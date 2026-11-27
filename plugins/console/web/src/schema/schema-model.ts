import type { InjectionKey, Ref } from "vue";

import type { PluginSchemaNode as Schema } from "../../../src/shared/plugin-config";

/** Provided by the editor: the plugin name, used to file uploads under data/yesimbot/uploads/<name>. */
export const SCHEMA_SCOPE: InjectionKey<Ref<string>> = Symbol("schema-scope");

export type Dynamics = Record<string, Schema>;

/** A config path; array items are addressed by their index as a string. */
export type Path = readonly string[];

// ---- The settings page a schema becomes -------------------------------------------------------------------------

/** A setting edited in its row. */
export type FieldKind = "switch" | "number" | "text" | "secret" | "select" | "textarea" | "path" | "json";

export type Row = FieldRow | BranchRow;

export interface FieldError {
  path: string;
  message: string;
}

export interface FieldRow {
  kind: FieldKind;
  id: string;
  path: Path;
  /** Empty when the row's group or a segmented choice above it already names it. */
  title: string;
  node: Schema;
}

/** Which shape a value takes (逐项填写 / 整段文本), as segments; the chosen shape's rows follow. */
export interface BranchRow {
  kind: "branch";
  id: string;
  path: Path;
  title: string;
  node: Schema;
  selected: number;
}

/**
 * A collection edited item by item: `items` (one row per text or number), `choices` (a switch per fixed option),
 * `records` (a list whose items open as pages), `entries` (named items that open as pages), `pairs` (name → value).
 */
export interface Collection {
  kind: "items" | "choices" | "records" | "entries" | "pairs";
  path: Path;
  title: string;
  node: Schema;
  item: Schema;
}

/** One group of rows on the page. */
export interface Block {
  id: string;
  title: string;
  rows: Row[];
  collection?: Collection;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const isSecret = (v: unknown): v is { $secret: true; sourcePath?: string[] } => isRecord(v) && v.$secret === true;

/** A segment's label: the option's name without what follows a comma or bracket (「HTTP（远程服务）」 → 「HTTP」). */
export const shortLabel = (label: string) => label.split(/[，,（(]/)[0]!.trim() || label;

/** The text form of a config path, as `validate` and the server write it (`a.b[0]`). */
export const pathText = (path: Path) => path.reduce((text, part) => (/^\d+$/.test(part) ? `${text}[${part}]` : text ? `${text}.${part}` : part), "");

export function description(v: unknown): string {
  return typeof v === "string" ? v : isRecord(v) ? String(v.zh ?? v["zh-CN"] ?? v[""] ?? "") : "";
}

/**
 * A field's name: the first line of its description, up to the first 「；」. The lines after it explain the field to
 * whoever reads the plugin's source; the settings page shows only the name (user, 2026-11-21: no guidance text).
 */
export function fieldTitle(raw: Schema, key = "", dynamics: Dynamics = {}): string {
  const first = description(resolve(raw, dynamics).meta?.description).trim().split(/\n/)[0] ?? "";
  return (
    first
      .split(/[；;]/)[0]!
      .replace(/[。.，,：:]$/, "")
      .trim() || key
  );
}

/** Union options without a description are named after their const discriminator (e.g. kind: "local"). */
export function branchLabel(raw: Schema, index: number, dynamics: Dynamics = {}): string {
  const text = description(raw.meta?.description);
  if (text === "Custom model (provider:model)") return "自定义模型（连接名:模型名）";
  if (text) return text.split(/\n/)[0]!;
  const node = resolve(raw, dynamics);
  if (node.type === "const") return String(node.value);
  const tag = Object.values(node.dict ?? {}).find((child) => resolve(child, dynamics).type === "const");
  if (tag) return description(tag.meta?.description) || String(resolve(tag, dynamics).value);
  if (node.type && node.type !== "object")
    return { string: "文本", number: "数字", boolean: "开关", array: "列表", dict: "键值表" }[node.type] ?? `选项 ${index + 1}`;
  return `选项 ${index + 1}`;
}

export function resolve(s: Schema, dynamics: Dynamics = {}, depth = 0): Schema {
  if (depth > 80) return { type: "any", meta: s.meta };
  const inner = s.type === "dynamic" ? dynamics[String(s.name ?? s.inner ?? "")] : s.type === "transform" ? s.inner : undefined;
  if (s.type !== "dynamic" && s.type !== "transform") return s;
  const node = resolve(inner ?? { type: "any" }, dynamics, depth + 1);
  return { ...node, meta: { ...node.meta, ...s.meta } };
}

export function matches(raw: Schema, value: unknown, dynamics: Dynamics = {}): boolean {
  const s = resolve(raw, dynamics);
  if (value === undefined) return !s.meta?.required;
  switch (s.type) {
    case "never":
      return false;
    case "const":
      return JSON.stringify(value) === JSON.stringify(s.value);
    case "object":
      return isRecord(value) && Object.entries(s.dict ?? {}).every(([k, v]) => matches(v, value[k], dynamics));
    case "intersect":
      return (s.list ?? []).every((v) => matches(v, value, dynamics));
    case "union":
      return (s.list ?? []).some((v) => matches(v, value, dynamics));
    case "array":
      return Array.isArray(value);
    case "dict":
      return isRecord(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" || isSecret(value);
    default:
      return true;
  }
}

export function branch(s: Schema, value: unknown, dynamics: Dynamics = {}): number {
  const n = (s.list ?? []).findIndex((v) => matches(v, value, dynamics));
  return Math.max(0, n);
}

/** The value a new item starts from: the discriminators its shape fixes (an MCP server starts as 「本地命令」). */
export function emptyValue(raw: Schema, dynamics: Dynamics = {}): unknown {
  const s = resolve(raw, dynamics);
  if (s.type === "never") return undefined;
  if (s.type === "const") return s.value;
  if (s.type === "object")
    return Object.fromEntries(
      Object.entries(s.dict ?? {})
        .filter(([, child]) => child.type === "const")
        .map(([key, child]) => [key, child.value]),
    );
  if (s.type === "intersect") return Object.assign({}, ...(s.list ?? []).map((part) => emptyValue(part, dynamics)).filter(isRecord));
  if (s.type === "dict") return {};
  if (s.type === "array") return [];
  if (s.type === "boolean") return false;
  if (s.type === "number") return 0;
  if (s.type === "union") return emptyValue(s.list?.[0] ?? {}, dynamics);
  return "";
}

/** Keep fields owned by other intersect branches and unknown extension keys. */
export function switchBranch(raw: Schema, value: unknown, dynamics: Dynamics = {}): unknown {
  const seed = emptyValue(raw, dynamics);
  return isRecord(value) && isRecord(seed) ? { ...value, ...seed } : seed;
}

/** Whether a value of this shape holds a secret anywhere. */
export function hasSecret(raw: Schema, dynamics: Dynamics = {}, depth = 0): boolean {
  const s = resolve(raw, dynamics);
  if (depth > 40) return false;
  if (s.meta?.role === "secret") return true;
  return [...Object.values(s.dict ?? {}), ...(s.list ?? []), ...(s.inner && typeof s.inner === "object" ? [s.inner] : [])].some((child) =>
    hasSecret(child, dynamics, depth + 1),
  );
}

export function validate(raw: Schema, value: unknown, dynamics: Dynamics = {}, path = ""): FieldError[] {
  const s = resolve(raw, dynamics),
    meta = s.meta ?? {},
    errors: FieldError[] = [];
  const fail = (message: string) => errors.push({ path, message });
  if (value === undefined) {
    if (meta.required && meta.default === undefined) fail("请填写此项");
    return errors;
  }
  if (isSecret(value)) return errors;
  if (s.type === "intersect") return (s.list ?? []).flatMap((v) => validate(v, value, dynamics, path));
  if (s.type === "union") {
    const candidates = (s.list ?? []).map((v) => validate(v, value, dynamics, path));
    return candidates.find((v) => !v.length) ?? candidates.sort((a, b) => a.length - b.length)[0] ?? [];
  }
  if (!["object", "dict", "array"].includes(s.type ?? "") && !matches(s, value, dynamics)) {
    fail("值的类型不正确");
    return errors;
  }
  const size = typeof value === "number" ? value : typeof value === "string" || Array.isArray(value) ? value.length : undefined;
  if (size !== undefined && typeof meta.min === "number" && size < meta.min) fail(`不能小于 ${meta.min}${typeof value === "number" ? "" : " 个字符或项目"}`);
  if (size !== undefined && typeof meta.max === "number" && size > meta.max) fail(`不能大于 ${meta.max}${typeof value === "number" ? "" : " 个字符或项目"}`);
  if (typeof value === "number" && !Number.isFinite(value)) fail("请输入有效数字");
  if (typeof value === "number" && meta.step === 1 && !Number.isInteger(value)) fail("请输入整数");
  if (typeof value === "string" && meta.pattern) {
    try {
      const p = meta.pattern as string | { source: string; flags?: string };
      if (!new RegExp(typeof p === "string" ? p : p.source, typeof p === "string" ? "" : p.flags).test(value)) fail("格式不符合要求");
    } catch {
      /* server remains authoritative */
    }
  }
  if ((s.type === "object" || s.type === "dict") && !isRecord(value)) {
    fail("请输入有效对象");
    return errors;
  }
  if (s.type === "array" && !Array.isArray(value)) {
    fail("请输入有效数组");
    return errors;
  }
  if ((s.type === "object" || s.type === "dict") && isRecord(value)) {
    const keys = s.type === "object" ? Object.keys(s.dict ?? {}) : Object.keys(value);
    for (const key of keys) errors.push(...validate(s.type === "object" ? s.dict![key] : (s.inner ?? {}), value[key], dynamics, path ? `${path}.${key}` : key));
  }
  if (s.type === "array" && Array.isArray(value)) value.forEach((v, i) => errors.push(...validate(s.inner ?? {}, v, dynamics, `${path}[${i}]`)));
  return errors;
}

/** The schema of the value at `path`: through objects, intersections, unions (the first shape that has the key) and items. */
export function schemaAt(raw: Schema | null | undefined, path: Path, dynamics: Dynamics = {}): Schema | undefined {
  let node = raw ? resolve(raw, dynamics) : undefined;
  for (const key of path) {
    if (!node) return;
    node = childAt(node, key, dynamics);
  }
  return node;
}

/** A server field path (`a.b[0]`) as a config path. */
export function parsePath(text: string): string[] {
  return text.split(/\.|\[(\d+)\]/).filter((part): part is string => !!part);
}

/**
 * Lays a schema out as groups of rows (user, 2026-11-25: every settings page like 对话 and 模型服务). Plain fields
 * become rows of the group they belong to; a described object or section becomes a group of its own, titled by its
 * description; lists and named items become groups whose rows are their items. A union shows the rows of the shape the
 * value has now (`read`), after a segmented choice unless a sibling field (a select) already chooses it.
 */
export function layout(raw: Schema | null | undefined, path: Path, read: (path: Path) => unknown, dynamics: Dynamics = {}): Block[] {
  const blocks: Block[] = [];
  const open = (title: string, at: Path): Block => {
    const block: Block = { id: `${at.join(".")}#${blocks.length}`, title, rows: [] };
    blocks.push(block);
    return block;
  };
  const root = resolve(raw ?? {}, dynamics);
  if (isShape(root)) shape(raw!, path, open("", path), false);
  else if (!root.meta?.hidden) open("", path).rows.push({ kind: "json", id: path.join("."), path, title: "", node: root });
  return blocks.filter((block) => block.rows.length || block.collection);

  /** The rows of the value at `at`, into `block`. */
  function shape(raw: Schema, at: Path, block: Block, chosen: boolean): void {
    const node = resolve(raw, dynamics);
    if (node.meta?.hidden) return;
    if (node.type === "object") for (const [key, child] of Object.entries(node.dict ?? {})) field(child, [...at, key], key, block);
    else if (node.type === "intersect")
      (node.list ?? []).forEach((part, index, list) => {
        const sibling = chosenBySibling(list, index, dynamics);
        const title = description(resolve(part, dynamics).meta?.description) ? fieldTitle(part, "", dynamics) : "";
        shape(part, at, title && isShape(resolve(part, dynamics)) ? open(title, at) : block, sibling);
      });
    else if (node.type === "union") {
      const selected = branch(node, read(at), dynamics);
      if (!chosen && (node.list?.length ?? 0) > 1) block.rows.push({ kind: "branch", id: `${at.join(".")}|branch`, path: at, title: "", node, selected });
      shape(node.list?.[selected] ?? {}, at, block, false);
    }
  }

  /** One field at `at`: a row of `block`, or a group of its own. `title` "" leaves it unnamed (a shape's only content). */
  function field(raw: Schema, at: Path, key: string, block: Block, inShape = false): void {
    const node = resolve(raw, dynamics);
    if (node.meta?.hidden || node.type === "const" || node.type === "never") return;
    const title = inShape ? "" : fieldTitle(raw, key, dynamics);
    const id = at.join(".");
    const row = (kind: FieldKind) => block.rows.push({ kind, id, path: at, title, node });
    const collect = (kind: Collection["kind"], item: Schema) => {
      const host = inShape ? block : open(title, at);
      host.collection = { kind, path: at, title: title || block.title, node, item };
    };
    switch (node.type) {
      case "boolean":
        return void row("switch");
      case "number":
        return void row("number");
      case "string":
        return void row(({ secret: "secret", textarea: "textarea", path: "path" } as const)[String(node.meta?.role)] ?? "text");
      case "union": {
        if (isConstUnion(node, dynamics)) return void ((node.list?.length ?? 0) > 1 && row("select"));
        // A value of a few shapes: a group named after the field, the shapes as segments, then the chosen one.
        const own = inShape ? block : open(title, at);
        const selected = branch(node, read(at), dynamics);
        own.rows.push({ kind: "branch", id: `${id}|branch`, path: at, title: "", node, selected });
        const chosen = node.list?.[selected] ?? {};
        if (isShape(resolve(chosen, dynamics))) return shape(chosen, at, own, false);
        return field(chosen, at, key, own, true);
      }
      case "object":
      case "intersect":
        return description(node.meta?.description) ? shape(raw, at, open(title, at), false) : shape(raw, at, block, false);
      case "array": {
        const item = resolve(node.inner ?? {}, dynamics);
        return collect(isConstUnion(item, dynamics) ? "choices" : isPrimitive(item) ? "items" : "records", item);
      }
      case "dict": {
        const item = resolve(node.inner ?? {}, dynamics);
        return collect(isPrimitive(item) ? "pairs" : "entries", item);
      }
      default:
        return void row("json");
    }
  }
}

/** Options of a const union, labelled. */
export function constOptions(node: Schema, dynamics: Dynamics = {}): { value: unknown; label: string }[] {
  return (node.list ?? []).map((child, index) => ({ value: resolve(child, dynamics).value, label: branchLabel(child, index, dynamics) }));
}

/** How a named item reads in its list: the label of its kind and its address or command (「本地命令 · npx …」). */
export function itemSummary(raw: Schema, value: unknown, dynamics: Dynamics = {}): string {
  if (!isRecord(value)) return "";
  const parts: string[] = [];
  const visit = (raw: Schema) => {
    const node = resolve(raw, dynamics);
    if (node.type === "intersect") return (node.list ?? []).forEach(visit);
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      const field = resolve(child, dynamics);
      if (isConstUnion(field, dynamics) && value[key] !== undefined) {
        const option = constOptions(field, dynamics).find((item) => JSON.stringify(item.value) === JSON.stringify(value[key]));
        if (option && !parts.includes(shortLabel(option.label))) parts.push(shortLabel(option.label));
      }
    }
  };
  visit(raw);
  const detail = ["url", "command", "endpoint", "path"].map((key) => value[key]).find((item) => typeof item === "string" && item);
  return [...parts, ...(typeof detail === "string" ? [detail] : [])].join(" · ");
}

/** The on/off field of a named item (`enable`/`enabled`), shown as its row's switch. */
export function itemToggle(raw: Schema, dynamics: Dynamics = {}): { key: string; fallback: boolean } | undefined {
  const node = resolve(raw, dynamics);
  const parts = node.type === "intersect" ? (node.list ?? []).map((child) => resolve(child, dynamics)) : [node];
  for (const part of parts)
    for (const key of ["enable", "enabled"]) {
      const field = resolve(part.dict?.[key] ?? {}, dynamics);
      if (field.type === "boolean") return { key, fallback: field.meta?.default === true };
    }
}

/** A list item's name: its first non-empty text field, else its position. */
export function recordTitle(value: unknown, index: number): string {
  const text = isRecord(value) ? Object.values(value).find((item) => typeof item === "string" && item.trim()) : undefined;
  return typeof text === "string" ? text : `第 ${index + 1} 项`;
}

const isConstUnion = (node: Schema, dynamics: Dynamics) =>
  node.type === "union" && !!node.list?.length && node.list.every((child) => resolve(child, dynamics).type === "const");

const isPrimitive = (node: Schema) => node.type === "string" || node.type === "number";

const isShape = (node: Schema) => node.type === "object" || node.type === "intersect" || node.type === "union";

function childAt(node: Schema, key: string, dynamics: Dynamics, depth = 0): Schema | undefined {
  if (depth > 20) return;
  if (node.dict?.[key]) return resolve(node.dict[key], dynamics);
  if ((node.type === "array" || node.type === "dict") && node.inner && typeof node.inner === "object") return resolve(node.inner, dynamics);
  for (const part of node.type === "intersect" || node.type === "union" ? (node.list ?? []) : []) {
    const found = childAt(resolve(part, dynamics), key, dynamics, depth + 1);
    if (found) return found;
  }
}

/** In an intersection, a union is chosen by a sibling field (MCP's 连接方式) when that field carries the union's discriminator. */
function chosenBySibling(list: readonly Schema[], index: number, dynamics: Dynamics): boolean {
  const union = resolve(list[index] ?? {}, dynamics);
  if (union.type !== "union") return false;
  const branches = (union.list ?? []).map((child) => resolve(child, dynamics));
  if (!branches.length || !branches.every((child) => child.type === "object")) return false;
  const keys = Object.keys(branches[0]!.dict ?? {}).filter((k) => branches.every((child) => resolve(child.dict?.[k] ?? {}, dynamics).type === "const"));
  return list.some((other, i) => i !== index && keys.some((k) => Object.hasOwn(resolve(other, dynamics).dict ?? {}, k)));
}

export type { PluginSchemaNode as Schema } from "../../../src/shared/plugin-config";

import { checkConfig, configForm, type FormSchema, type ModuleConfig } from "@yesimbot/foundation";

import type { PluginSchemaNode } from "../shared/plugin-config.js";
import { isObject } from "./secrets.js";

/** Where an option list comes from (`optionsSource`) → the dynamic form node the console already fills in. */
const OPTION_SOURCES: Readonly<Record<string, string>> = {
  "models.chat": "registry.chatModels",
  "models.embedding": "registry.embeddingModels",
  "models.image": "registry.imageModels",
};
const WIDGET_ROLES = new Set(["table", "textarea", "path", "slider"]);
const MAX_DEPTH = 80;

/** A plugin's config as the console sees it: the form to render and the check a save must pass. */
export interface PluginConfigSource {
  form(): PluginSchemaNode | null;
  /** Undefined when the value fits; otherwise the path of the first problem (`a.b[0]`), or "" for the whole value. */
  check(value: unknown): string | undefined;
}

/** The config a loaded plugin module declares: its zod `moduleConfig` (convention 02). A module without one has no form. */
export function pluginConfigSource(plugin: { moduleConfig?: unknown } | undefined): PluginConfigSource {
  const module = plugin?.moduleConfig;
  if (isModuleConfig(module))
    return {
      form: () => formNode(configForm(module.schema)),
      check(value) {
        const result = checkConfig(module.schema, value);
        return result.ok ? undefined : fieldPath(result.issues[0]?.path ?? []);
      },
    };
  return { form: () => null, check: () => undefined };
}

/**
 * A config form (JSON Schema from `configForm`) as the console's form nodes. Root fields that name a `group` become
 * sections (an intersect of objects titled by the group), the way the form already splits a Koishi config. Sections keep
 * the order their first field has; ungrouped fields form one section, titled 基本设置 when it comes first and untitled
 * otherwise. A section whose fields are all hidden is hidden.
 */
export function formNode(form: FormSchema): PluginSchemaNode {
  const defs = isObject(form.$defs) ? form.$defs : {};
  const node = convert(form, defs, false, 0, new Set());
  if (node.type !== "object" || !node.dict) return node;
  const sections = new Map<string, Record<string, PluginSchemaNode>>();
  const properties = isObject(form.properties) ? form.properties : {};
  for (const [key, child] of Object.entries(node.dict)) {
    const group = isObject(properties[key]) && typeof properties[key].group === "string" ? properties[key].group : "";
    sections.set(group, { ...sections.get(group), [key]: child });
  }
  if (!sections.size || (sections.size === 1 && sections.has(""))) return node;
  return {
    type: "intersect",
    list: [...sections].map(([group, dict], index) => {
      const title = group || (index === 0 ? "基本设置" : undefined);
      const hidden = Object.values(dict).every((field) => field.meta?.hidden === true);
      return { type: "object", dict, meta: { ...(title ? { description: title } : {}), ...(hidden ? { hidden: true } : {}) } };
    }),
  };
}

function convert(schema: unknown, defs: Record<string, unknown>, required: boolean, depth: number, seen: ReadonlySet<string>): PluginSchemaNode {
  if (!isObject(schema) || depth > MAX_DEPTH) return {};
  if (typeof schema.$ref === "string") {
    const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref)?.[1];
    if (!name || seen.has(name)) return {};
    const { $ref: _ref, ...rest } = schema;
    return convert({ ...(defs[name] as object), ...rest }, defs, required, depth + 1, new Set([...seen, name]));
  }
  const meta = nodeMeta(schema, required);
  const next = (child: unknown, childRequired = false) => convert(child, defs, childRequired, depth + 1, seen);
  if (typeof schema.optionsSource === "string") {
    const name = OPTION_SOURCES[schema.optionsSource];
    if (name) return { type: "dynamic", name, meta };
  }
  const branches = (Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined)?.filter(
    // `nullable` adds a bare null branch; a labelled `null` choice (`z.literal(null)`) carries `const` and stays.
    (branch) => !(isObject(branch) && branch.type === "null" && !Object.hasOwn(branch, "const")),
  );
  if (branches) {
    // `nullable` leaves one real branch: the field is that branch.
    if (branches.length === 1) return withMeta(next(branches[0]), meta);
    return { type: "union", list: branches.map((branch) => next(branch)), meta };
  }
  if (Array.isArray(schema.allOf)) return { type: "intersect", list: schema.allOf.map((part) => next(part)), meta };
  if (Object.hasOwn(schema, "const")) return { type: "const", value: schema.const, meta };
  if (Array.isArray(schema.enum)) return { type: "union", list: schema.enum.map((value) => ({ type: "const", value })), meta };
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "object") {
    const properties = isObject(schema.properties) ? schema.properties : undefined;
    if (properties) {
      const needed = new Set(Array.isArray(schema.required) ? schema.required : []);
      return { type: "object", dict: Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, next(child, needed.has(key))])), meta };
    }
    if (isObject(schema.additionalProperties)) return { type: "dict", inner: next(schema.additionalProperties), meta };
    return { type: "object", dict: {}, meta };
  }
  if (type === "array") return { type: "array", inner: next(schema.items), meta };
  if (type === "integer") return { type: "number", meta: { ...meta, step: 1 } };
  if (type === "string" || type === "number" || type === "boolean") return { type, meta };
  // Unrepresentable (a transform, `any`): the form edits the raw value.
  return { meta };
}

function nodeMeta(schema: Record<string, unknown>, required: boolean): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const description = [schema.title, schema.description].filter((text): text is string => typeof text === "string" && !!text.trim()).join("\n");
  if (description) meta.description = description;
  if (Object.hasOwn(schema, "default")) meta.default = schema.default;
  else if (required) meta.required = true;
  if (schema.hidden === true) meta.hidden = true;
  if (schema.secret === true) meta.role = "secret";
  else if (typeof schema.widget === "string" && WIDGET_ROLES.has(schema.widget)) meta.role = schema.widget;
  const min = schema.minimum ?? schema.minLength ?? schema.minItems;
  const max = schema.maximum ?? schema.maxLength ?? schema.maxItems;
  if (typeof min === "number") meta.min = min;
  if (typeof max === "number") meta.max = max;
  if (typeof schema.pattern === "string") meta.pattern = schema.pattern;
  if (typeof schema.unit === "string" && schema.unit) meta.unit = schema.unit;
  return meta;
}

function withMeta(node: PluginSchemaNode, meta: Record<string, unknown>): PluginSchemaNode {
  return { ...node, meta: { ...node.meta, ...meta } };
}

function fieldPath(path: readonly PropertyKey[]): string {
  return path.every((part) => typeof part === "number" || (typeof part === "string" && /^[A-Za-z_$][\w$-]{0,127}$/.test(part)))
    ? path.map((part, index) => (typeof part === "number" ? `[${part}]` : `${index ? "." : ""}${String(part)}`)).join("")
    : "";
}

function isModuleConfig(value: unknown): value is ModuleConfig {
  return isObject(value) && typeof value.id === "string" && isObject(value.schema) && typeof (value.schema as { safeParse?: unknown }).safeParse === "function";
}

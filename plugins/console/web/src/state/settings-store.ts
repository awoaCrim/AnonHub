import { reactive } from "vue";

import type { PluginSchemaSnapshot } from "../../../src/shared/plugin-config";
import { ApiError, api } from "../lib/api";
import { at, pathKey, type ConfigStore } from "../schema/config-store";
import { fieldTitle, parsePath, resolve, schemaAt, validate, type Dynamics, type Path, type Schema } from "../schema/schema-model";
import { createAutosave, type AutosaveTarget } from "./autosave";
import { createConfigFieldsEditor } from "./config-fields";

/**
 * The store a settings page's rows use (user, 2026-11-25: 全部改成即改即存). Every change saves at once through
 * `target`, with one 已保存 toast and 撤销; a save the server refuses as invalid puts its reason under the rows that
 * were changed, and the rows show the saved values again.
 */
export function createSettingsStore(options: {
  target: AutosaveTarget;
  /** The current value of a path, as the editor holds it. */
  read(path: Path): unknown;
  /** The schema of the value at `base`, which the rows edit. */
  schema: Schema | null | undefined;
  base?: Path;
  dynamics?: Dynamics;
  writable(): boolean;
  disposed(): boolean;
  notify(text: string, undo?: () => void): void;
  /** After a failed save: the refused field (`a.b[0]`, "" for the whole value), or undefined when it was not refused as invalid. */
  refused(): string | undefined;
}) {
  const base = options.base ?? [];
  const errors = reactive(new Map<string, string>());
  /** The rows behind each changed path, until it is handed to the editor. */
  const origins = new Map<string, readonly Path[]>();
  let batch: Path[] = [];
  const target: AutosaveTarget = {
    dirty: options.target.dirty,
    set(path, value) {
      batch.push(...(origins.get(pathKey(path)) ?? [path]));
      origins.delete(pathKey(path));
      options.target.set(path, value);
    },
    async save() {
      const touched = batch;
      batch = [];
      const attempted = options.read(base);
      if (await options.target.save()) {
        // What was refused before is settled by a save that went through.
        errors.clear();
        return true;
      }
      const refused = options.refused();
      if (refused !== undefined) {
        // The reason goes under the field it is about and under the rows just changed, naming that field when it is
        // another one (a required field still empty refuses every other change).
        const field = parsePath(refused);
        const message = validate(options.schema ?? {}, attempted, options.dynamics).find((item) => item.path === refused)?.message ?? "未通过校验";
        const name = field.length ? fieldTitle(schemaAt(options.schema, field, options.dynamics) ?? {}, field.at(-1)) : "";
        if (field.length) errors.set(pathKey([...base, ...field]), message);
        const full = [...base, ...field];
        for (const path of touched) {
          const inside = !field.length || (path.length <= full.length && path.every((part, index) => full[index] === part));
          errors.set(pathKey(path), inside ? message : `「${name}」${message}`);
        }
      }
      return false;
    },
    discard: () => options.target.discard(),
  };
  const autosave = createAutosave({ read: options.read, target: () => target, disposed: options.disposed, notify: options.notify });
  const store: ConfigStore = {
    value: (path) => autosave.value(path),
    commit(label, changes, commit) {
      if (options.disposed() || !options.writable()) return;
      for (const [path] of changes) origins.set(pathKey(path), commit?.origins ?? [path]);
      for (const path of commit?.origins ?? changes.map(([path]) => path)) errors.delete(pathKey(path));
      void autosave.commit(label, changes, { irreversible: commit?.irreversible });
    },
    error: (path) => errors.get(pathKey(path)) ?? "",
    fail: (path, message) => void errors.set(pathKey(path), message),
    get disabled() {
      return !options.writable();
    },
    dynamics: options.dynamics ?? {},
  };
  return { store, saving: autosave.saving };
}

/** The top-level fields a plugin schema can set: those of every object at its root, through intersections and unions. */
export function rootFields(schema: Schema | null | undefined, dynamics: Dynamics = {}): string[] {
  const keys = new Set<string>();
  const visit = (raw: Schema, depth: number) => {
    const node = resolve(raw, dynamics);
    if (depth > 20) return;
    for (const key of Object.keys(node.dict ?? {})) keys.add(key);
    if (node.type === "intersect" || node.type === "union") for (const part of node.list ?? []) visit(part, depth + 1);
  };
  if (schema) visit(schema, 0);
  return [...keys];
}

/**
 * One plugin instance's settings, saved on change through `plugins/update`. After each save the config is read again,
 * so secret markers name where the server keeps them now and the next save restores the right ones.
 */
export function createPluginSettings(
  snapshot: PluginSchemaSnapshot,
  options: { writable(): boolean; disposed(): boolean; notify(text: string, undo?: () => void): void; request?: typeof api },
) {
  let refused: string | undefined;
  const send = options.request ?? api;
  const request = (async (path: string, body?: unknown, init?: Parameters<typeof api>[2]) => {
    try {
      return await send(path, body, init);
    } catch (error) {
      if (body !== undefined && error instanceof ApiError && error.code === "invalid_config")
        refused = error.path && error.path !== editor.state.path ? error.path : "";
      throw error;
    }
  }) as typeof api;
  const dynamics = snapshot.dynamics ?? {};
  const editor = createConfigFieldsEditor(rootFields(snapshot.schema, dynamics), { request, savedNotice: "" });
  const target: AutosaveTarget = {
    dirty: editor.dirty,
    set: editor.set,
    async save() {
      refused = undefined;
      if (!(await editor.save())) {
        // A refusal is shown under its rows, not as a toast.
        if (refused !== undefined) editor.state.error = "";
        return false;
      }
      await editor.discard();
      return true;
    },
    discard: () => editor.discard(),
  };
  const settings = createSettingsStore({
    target,
    read: (path) => at(editor.state.value, path),
    schema: snapshot.schema,
    dynamics,
    writable: () => options.writable() && !!editor.state.config,
    disposed: options.disposed,
    notify: options.notify,
    refused: () => refused,
  });
  /** Whether the last failed save was refused as invalid: shown under its rows, never as a toast. */
  const refusing = () => refused !== undefined;
  return { ...settings, editor, refusing };
}

import { reactive, type InjectionKey } from "vue";

import type { Change } from "../state/autosave";
import { readPath, writePath } from "../state/config-fields";
import { emptyValue, validate, type Dynamics, type Path, type Schema } from "./schema-model";

export const CONFIG_STORE: InjectionKey<ConfigStore> = Symbol("config-store");

export interface CommitOptions {
  /** No 撤销 for it (a secret: the browser never holds the one it replaces). */
  irreversible?: boolean;
  /** The rows the user changed, where a refused save shows its reason; the changed paths by default. */
  origins?: readonly Path[];
}

/**
 * What the rows of a settings page read and change. A change saves at once (the page's store) or stays in a new
 * item until it is added (a draft); `error` is the one line shown under a row whose last change was refused.
 */
export interface ConfigStore {
  value(path: Path): unknown;
  commit(label: string, changes: readonly Change[], options?: CommitOptions): void;
  error(path: Path): string;
  fail(path: Path, message: string): void;
  readonly disabled: boolean;
  readonly dynamics: Dynamics;
}

export const pathKey = (path: Path) => path.join("\u0000");

/** `value` at `path`; the empty path is the value itself. */
export const at = (value: unknown, path: Path): unknown => (path.length ? (isRecord(value) ? readPath(value, path) : undefined) : value);

/** A copy of `value` with `path` set; the empty path replaces it. */
export const withAt = (value: unknown, path: Path, next: unknown): unknown => (path.length ? writePath(isRecord(value) ? value : {}, path, next) : copy(next));

/**
 * One item of a list as a store of its own: its rows read and change the item, and every change saves the whole list
 * (a list is one value; its items have no paths of their own on the server).
 */
export function itemStore(parent: ConfigStore, list: Path, index: number): ConfigStore {
  const items = () => {
    const value = parent.value(list);
    return Array.isArray(value) ? value : [];
  };
  const absolute = (path: Path) => [...list, String(index), ...path];
  return {
    value: (path) => at(items()[index], path),
    commit(label, changes, options) {
      const current = items();
      if (index >= current.length) return;
      const item = changes.reduce<unknown>((value, [path, next]) => withAt(value, path, next), current[index]);
      const next = current.map((value, i) => (i === index ? item : value));
      parent.commit(label, [[list, next]], { ...options, origins: (options?.origins ?? changes.map(([path]) => path)).map(absolute) });
    },
    error: (path) => parent.error(absolute(path)),
    fail: (path, message) => parent.fail(absolute(path), message),
    get disabled() {
      return parent.disabled;
    },
    dynamics: parent.dynamics,
  };
}

/** A new item being filled in before it is added: nothing saves until the page takes `draft`. */
export function draftStore(item: Schema, dynamics: Dynamics, disabled: () => boolean) {
  const state = reactive({ draft: emptyValue(item, dynamics) as unknown, errors: new Map<string, string>() });
  const store: ConfigStore = {
    value: (path) => at(state.draft, path),
    commit(_label, changes, options) {
      for (const path of options?.origins ?? changes.map(([path]) => path)) state.errors.delete(pathKey(path));
      state.draft = changes.reduce<unknown>((value, [path, next]) => withAt(value, path, next), state.draft);
    },
    error: (path) => state.errors.get(pathKey(path)) ?? "",
    fail: (path, message) => void state.errors.set(pathKey(path), message),
    get disabled() {
      return disabled();
    },
    dynamics,
  };
  return {
    store,
    get draft() {
      return state.draft;
    },
    /** What still keeps it from being added, as `validate` reports it. */
    problems: () => validate(item, state.draft, dynamics),
  };
}

const copy = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

import { computed, reactive } from "vue";

import type { PluginConfigSnapshot, PluginSchemaNode } from "../../../src/shared/plugin-config";
import { ApiError, api } from "../lib/api";
import { onCacheRefresh } from "../lib/cache";
import { retainDraft, takeDraft, draftScope } from "../lib/editor-drafts";
import { trackEditor } from "../lib/editor-guard";
import { editorValue } from "../lib/editor-value";
import { pluginIdentity } from "../lib/plugin-config";
import { pluginError } from "../lib/plugin-config";

type Value = Record<string, unknown>;
const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const isObject = (value: unknown): value is Value => !!value && typeof value === "object" && !Array.isArray(value);

/** The listed top-level fields of a config; absent fields stay absent. */
export function pickFields(config: Value, fields: readonly string[]): Value {
  const result: Value = {};
  for (const field of fields) if (Object.hasOwn(config, field)) result[field] = copy(config[field]);
  return result;
}

export function readPath(value: Value, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Copy with `path` set; `undefined` removes the key so the plugin default applies again. */
export function writePath(value: Value, path: readonly string[], next: unknown): Value {
  const result = copy(value);
  let parent = result;
  for (const key of path.slice(0, -1)) {
    if (!isObject(parent[key])) parent[key] = {};
    parent = parent[key] as Value;
  }
  const last = path.at(-1)!;
  if (next === undefined) delete parent[last];
  else parent[last] = copy(next);
  return result;
}

/** The schema node at a config path, looking through intersections and transforms. */
export function schemaAt(schema: PluginSchemaNode | null | undefined, path: readonly string[]): PluginSchemaNode | undefined {
  let node = schema ?? undefined;
  for (const key of path) {
    node = node && childOf(node, key);
    if (!node) return;
  }
  return node;
}

function childOf(node: PluginSchemaNode, key: string): PluginSchemaNode | undefined {
  if (node.dict?.[key]) return node.dict[key];
  if (node.inner && node.type === "transform") return childOf(node.inner, key);
  for (const child of node.type === "intersect" ? (node.list ?? []) : []) {
    const found = childOf(child, key);
    if (found) return found;
  }
}

/** Plugin default for a field, shown in place of an absent value; it never enters a payload by itself. */
export function schemaDefault(schema: PluginSchemaNode | null | undefined, path: readonly string[]): unknown {
  const node = schemaAt(schema, path);
  return node?.meta?.default ?? (node?.type === "transform" ? node.inner?.meta?.default : undefined);
}

/**
 * Edits a fixed set of top-level fields of one plugin instance, leaving every other field and
 * secret marker as read. Edits stay in memory until saved. Two editors of the same instance on one
 * page (tool permissions and an account's plugin list) save in turn: each accepts the other's
 * known write through `acceptRelatedSave` instead of reporting a conflict.
 */
export function createConfigFieldsEditor(fields: readonly string[], options: { request?: typeof api; savedNotice?: string } = {}) {
  const scope = draftScope();
  const request = options.request ?? api;
  const state = reactive({
    path: "",
    revision: "",
    config: undefined as Value | undefined,
    value: {} as Value,
    saved: {} as Value,
    loading: false,
    busy: false,
    error: "",
    notice: "",
  });
  let generation = 0,
    uncertain = false;
  const draftKey = (path: string) => `fields:${pluginIdentity(path)}:${fields.join(",")}`;
  const dirty = computed(() => state.config !== undefined && editorValue(state.value) !== editorValue(state.saved));
  trackEditor(
    () => dirty.value,
    () => state.busy,
  );
  const read = (path: string, fresh = true) =>
    request<PluginConfigSnapshot>(`/yesimbot/api/v1/plugins/config?path=${encodeURIComponent(path)}`, undefined, { fresh });
  /** Reads the server copy; edits not yet saved are dropped. `keep` leaves the form on screen meanwhile. */
  async function reread(path: string, keep: boolean, fresh = true) {
    const token = ++generation;
    state.path = path;
    if (keep) state.value = copy(state.saved);
    else state.config = undefined;
    state.error = state.notice = "";
    state.loading = !!path;
    if (!path) return;
    try {
      const snapshot = await read(path, fresh);
      if (generation !== token) return;
      state.config = snapshot.config;
      state.revision = snapshot.revision;
      state.saved = pickFields(snapshot.config, fields);
      state.value = copy(state.saved);
      const retained = takeDraft<{ config: Value; value: Value; saved: Value; revision: string; uncertain: boolean }>(draftKey(path));
      if (!keep && retained) {
        Object.assign(state, retained);
        uncertain = retained.uncertain;
        state.error = "已恢复上次失败的保存草稿，请检查服务器状态。";
      }
    } catch (error) {
      if (generation === token) state.error = pluginError(error);
    } finally {
      if (generation === token) state.loading = false;
    }
  }
  const load = (path = state.path, keep = path === state.path && !!state.config) => reread(path, keep, false);
  const stopRefresh = onCacheRefresh((path) => {
    if (path === `/yesimbot/api/v1/plugins/config?path=${encodeURIComponent(state.path)}` && !dirty.value && !state.busy && !state.loading)
      void reread(state.path, true, false);
  });
  function set(path: readonly string[], value: unknown) {
    if (!state.config || state.busy || state.loading || !fields.includes(path[0]!)) return;
    state.value = writePath(state.value, path, value);
    state.notice = "";
  }

  /** The save bar's 放弃: drop the edits and show the latest saved settings. */
  async function discard() {
    if (state.busy) return;
    // The form stays visible: it shows the last saved values at once, then the latest copy.
    takeDraft(draftKey(state.path));
    uncertain = false;
    await reread(state.path, state.config !== undefined);
  }
  const merge = (config: Value): Value => {
    const result = copy(config);
    for (const field of fields) {
      if (Object.hasOwn(state.value, field)) result[field] = copy(state.value[field]);
      else delete result[field];
    }
    return result;
  };
  /** Accept only a paired editor's known write, with this instance's config otherwise unchanged. */
  async function acceptRelatedSave(previous: string, revision: string) {
    if (!state.config || state.revision !== previous || state.busy || state.loading) return;
    const token = generation;
    try {
      const snapshot = await read(state.path);
      if (
        token !== generation ||
        state.revision !== previous ||
        snapshot.revision !== revision ||
        JSON.stringify(snapshot.config) !== JSON.stringify(state.config)
      )
        return;
      state.revision = revision;
    } catch {
      // Keep the old revision and input; the ordinary save still detects conflicts.
    }
  }

  async function checkStatus() {
    if (!state.config || state.busy) return false;
    const token = generation,
      path = state.path;
    state.busy = true;
    try {
      const latest = await read(path);
      if (token !== generation) return false;
      const server = pickFields(latest.config, fields);
      if (editorValue(server) === editorValue(state.value)) {
        state.config = latest.config;
        state.saved = copy(server);
        state.revision = latest.revision;
        uncertain = false;
        state.error = "";
        state.notice = "服务器已确认保存。";
        return true;
      }
      if (editorValue(server) !== editorValue(state.saved)) {
        state.error = "服务器配置已变化，草稿仍保留。请放弃草稿并读取最新配置后再改。";
        return false;
      }
      state.config = latest.config;
      state.revision = latest.revision;
      uncertain = false;
      state.error = "服务器仍是原配置，可以重新保存。";
      return true;
    } catch (error) {
      state.error = pluginError(error);
      return false;
    } finally {
      state.busy = false;
    }
  }

  async function save() {
    if (uncertain) {
      if (!(await checkStatus())) return false;
      if (!dirty.value) return true;
    }

    if (!dirty.value || !state.config || state.loading || state.busy) return false;
    const token = generation,
      path = state.path;
    let config = merge(state.config);
    state.busy = true;
    state.error = state.notice = "";
    try {
      let result: { revision: string };
      try {
        result = await request<{ revision: string }>("/yesimbot/api/v1/plugins/update", { path, revision: state.revision, config });
      } catch (error) {
        // Only the revision is stale. When nobody touched these fields meanwhile, apply the edit to the
        // latest config; any change to the same fields remains a conflict for the user to resolve.
        if (!(error instanceof ApiError) || error.code !== "config_changed") throw error;
        const latest = await read(path);
        if (token !== generation || JSON.stringify(pickFields(latest.config, fields)) !== JSON.stringify(state.saved)) throw error;
        config = merge(latest.config);
        result = await request<{ revision: string }>("/yesimbot/api/v1/plugins/update", { path, revision: latest.revision, config });
      }
      if (token !== generation) return true;
      state.config = config;
      state.saved = pickFields(config, fields);
      state.value = copy(state.saved);
      state.revision = result.revision;
      state.notice = options.savedNotice ?? "设置已保存。";
      return true;
    } catch (error) {
      if (token === generation) {
        state.error = pluginError(error);
        uncertain = error instanceof ApiError && error.code === "write_unknown";
      }
      return false;
    } finally {
      state.busy = false;
    }
  }
  return {
    state,
    dirty,
    load,
    set,
    discard,
    acceptRelatedSave,
    checkStatus,
    save,
    dispose: () => {
      stopRefresh();
      if (dirty.value && state.error)
        retainDraft(draftKey(state.path), { config: state.config, value: state.value, saved: state.saved, revision: state.revision, uncertain }, scope);
      generation++;
    },
  };
}

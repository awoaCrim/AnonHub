import { blankRoleCardText, type RoleCardPictureKey, type RoleCardPictures } from "@yesimbot/contracts/role-cards";
import { computed, reactive } from "vue";

import type { CardFields, CardsSnapshot } from "../../../src/shared/character-cards";
import { api, ApiError } from "../lib/api";
import { trackEditor } from "../lib/editor-guard";
import { editorValue } from "../lib/editor-value";
import { pluginError } from "../lib/plugin-config";

export function cardError(error: unknown) {
  if (error instanceof ApiError) {
    const message = {
      card_changed: "这张角色卡已被修改。当前输入仍保留在页面中；关闭后会读取最新内容，再打开修改。",
      invalid_card: "角色卡文件读不了。",
      card_not_found: "角色卡已不在列表中，请刷新页面。",
      active_card: "这是全平台默认角色，先把默认换成别的角色再删除。",
      too_many_cards: "最多可保存 100 张角色卡。",
      invalid_picture: "图片要 PNG、JPEG 或 WebP，5 MB 以内。",
      card_apply_failed: error.restored ? "应用失败，已恢复原来的角色卡和设置。" : "应用失败，请刷新页面并检查角色卡。",
    }[error.code];
    if (message) return message;
  }
  return pluginError(error);
}

/** Last snapshot per plugin path: the list renders at once on revisit while a fresh read runs. */
const snapshots = new Map<string, CardsSnapshot>();

/** Raw PNG hashes guard card writes independently of config revisions. */
export function createRoleEditor(request: typeof api = api) {
  const state = reactive({
    path: "",
    snapshot: undefined as CardsSnapshot | undefined,
    id: "",
    revision: "",
    etag: "",
    value: blank(),
    saved: blank(),
    loading: false,
    busy: false,
    error: "",
    creating: false,
  });
  let generation = 0;
  const dirty = computed(() => !equal(state.value, state.saved));
  trackEditor(
    () => dirty.value,
    () => state.busy,
  );
  function fields(): CardFields {
    return Object.fromEntries(Object.keys(blank()).map((key) => [key, state.value[key as keyof CardFields]])) as unknown as CardFields;
  }

  function accept(snapshot: CardsSnapshot) {
    state.snapshot = snapshot;
    snapshots.set(state.path, snapshot);
    state.id = snapshot.selected?.id ?? snapshot.active;
    state.creating = false;
    state.revision = snapshot.revision;
    state.etag = snapshot.selected?.etag ?? "";
    state.saved = { ...blank(), ...(snapshot.selected?.fields ?? {}) };
    state.value = copy(state.saved);
  }

  async function load(path = state.path, id?: string) {
    const token = ++generation;
    if (path !== state.path) state.snapshot = snapshots.get(path);
    state.path = path;
    state.error = "";
    state.loading = true;
    if (!path) {
      state.snapshot = undefined;
      state.loading = false;
      return false;
    }
    try {
      const snapshot = await request<CardsSnapshot>(
        `/yesimbot/api/v1/characters?path=${encodeURIComponent(path)}${id === undefined ? "" : `&id=${encodeURIComponent(id)}`}`,
        undefined,
        { fresh: true },
      );
      if (token !== generation) return false;
      accept(snapshot);
      return true;
    } catch (error) {
      if (token === generation) state.error = cardError(error);
      return false;
    } finally {
      if (token === generation) state.loading = false;
    }
  }

  /** Opens a listed card from the snapshot already in hand; no request when it carries its fields. */
  function select(id: string): boolean {
    const card = state.snapshot?.cards.find((item) => item.id === id);
    if (!state.snapshot || !card?.fields || card.etag === undefined || state.busy || state.loading) return false;
    state.id = id;
    state.creating = false;
    state.error = "";
    state.revision = state.snapshot.revision;
    state.etag = card.etag;
    state.saved = { ...blank(), ...card.fields };
    state.value = copy(state.saved);
    return true;
  }

  /** Drops unsaved edits at once, without a request. */
  function revert() {
    state.value = copy(state.saved);
  }

  /** Typing goes on while a save runs; only a read blocks it. */
  function edit(value: Record<string, unknown>) {
    if (state.loading) return;
    state.value = copy(value) as typeof state.value;
  }

  function create() {
    state.creating = true;
    state.id = "";
    state.etag = "";
    state.revision = state.snapshot?.revision ?? "";
    state.saved = blank();
    state.value = copy(state.saved);
    state.error = "";
  }

  async function mutate(action: string, input: Record<string, unknown>, revision = state.snapshot?.revision) {
    if (state.busy || state.loading || !state.path || !revision) return false;
    const token = generation,
      card = state.id,
      submitted = copy(state.value);
    state.busy = true;
    state.error = "";
    try {
      const result = await request<CardsSnapshot>(`/yesimbot/api/v1/characters/${action}`, { path: state.path, revision, ...input });
      if (token !== generation) return false;
      // Edits typed into the same card while this request ran stay on screen, to be saved next.
      const typed = action === "save" && state.id === card && !equal(state.value, submitted) ? copy(state.value) : undefined;
      accept(result);
      if (typed) state.value = typed;
      return true;
    } catch (error) {
      if (token === generation) state.error = cardError(error);
      return false;
    } finally {
      if (token === generation) state.busy = false;
    }
  }
  const save = () => mutate(state.creating ? "create" : "save", { id: state.id, etag: state.etag, fields: fields() }, state.revision);
  /** Stores a new 参考图 or 三视图 in the open card, or removes it; unsaved text edits stay in the editor. */
  async function setPicture(key: RoleCardPictureKey, picture: Blob | null): Promise<boolean> {
    if (state.busy || state.loading || !state.path || !state.id || state.creating) return false;
    const token = generation;
    state.busy = true;
    state.error = "";
    try {
      const query = new URLSearchParams({
        path: state.path,
        revision: state.revision,
        id: state.id,
        etag: state.etag,
        key,
        ...(picture ? {} : { remove: "1" }),
      });
      const result = await request<CardsSnapshot>(`/yesimbot/api/v1/characters/picture?${query}`, undefined, {
        method: "POST",
        rawBody: picture ?? new Blob([]),
      });
      if (token !== generation) return false;
      const draft = dirty.value ? copy(state.value) : undefined;
      accept(result);
      if (draft) state.value = draft;
      return true;
    } catch (error) {
      if (token === generation) state.error = cardError(error);
      return false;
    } finally {
      if (token === generation) state.busy = false;
    }
  }
  const switchCard = (id: string) => mutate("switch", { id });
  /** Adds a copy of a built-in card and opens it. */
  const addPreset = (preset: string) => mutate("create", { preset });
  const remove = (id: string) => mutate("remove", { id });
  /** Turns roleplay on or off; true once the switch is saved. */
  async function setEnabled(enabled: boolean): Promise<boolean> {
    if (state.busy || state.loading || !state.snapshot) return false;
    const token = generation;
    state.busy = true;
    state.error = "";
    try {
      const result = await request<{ path?: string; revision: string }>("/yesimbot/api/v1/plugins/enabled", {
        path: state.path,
        revision: state.snapshot.revision,
        enabled,
      });
      if (token !== generation) return false;
      if (dirty.value && state.revision === state.snapshot.revision && result.revision) {
        state.revision = result.revision;
      }
      if (result.path) relocate(result.path);
      await load(state.path, state.id);
      return true;
    } catch (error) {
      if (token === generation) state.error = cardError(error);
      return false;
    } finally {
      state.busy = false;
    }
  }

  function relocate(path: string) {
    state.path = path;
  }
  return {
    state,
    dirty,
    load,
    edit,
    revert,
    select,
    save,
    create,
    addPreset,
    setPicture,
    switchCard,
    remove,
    setEnabled,
    relocate,
    dispose: () => {
      generation++;
    },
  };
}

/** A picture of a listed card, by its file name so a new picture is a new address; undefined when it has none. */
export function cardPictureUrl(path: string, card: { id: string; pictures?: RoleCardPictures }, key: RoleCardPictureKey = "reference"): string | undefined {
  const file = card.pictures?.[key];
  return file && path
    ? `/yesimbot/api/v1/characters/picture?path=${encodeURIComponent(path)}&id=${encodeURIComponent(card.id)}&key=${key}&v=${encodeURIComponent(file)}`
    : undefined;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function equal(a: unknown, b: unknown) {
  return editorValue(a) === editorValue(b);
}

function blank(): CardFields {
  return blankRoleCardText();
}

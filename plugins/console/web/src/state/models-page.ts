import { computed, ref, toRaw, watch, type InjectionKey } from "vue";

import type {
  ModelSettingsConnection,
  ModelSettingsImageModel,
  ModelSettingsModel,
  ModelSettingsOptions,
  ModelSettingsRoles,
  ModelSettingsSnapshot,
} from "../../../src/model-settings-types";
import { modelSelectionKey, resolveConnectionSelection, resolveModelSelection } from "../lib/model-route-state";
import { useRouteState } from "../lib/route-state";
import {
  connectionHost,
  connectionName,
  connectionRef,
  findConnection,
  newConnection,
  protocolLabel,
  setConnectionEndpoint,
  type ConnectionEndpoint,
  type createModelSettingsState,
  type ModelSettingsChange,
} from "./model-settings-state";

/** The models tab provides its page state to the purpose card, connection list and editor. */
export const MODELS_PAGE: InjectionKey<ModelsPage> = Symbol("models-page");

export const CONNECTION_TABS = [
  { key: "connection", label: "连接" },
  { key: "chat", label: "聊天模型" },
  { key: "embedding", label: "向量模型" },
  { key: "image", label: "生图模型" },
  { key: "advanced", label: "高级" },
] as const;
const ROLE_NAMES: Record<keyof ModelSettingsRoles, string> = {
  chatModel: "日常回复",
  auxiliaryModel: "辅助",
  visionModel: "识图",
  embeddingModel: "向量检索",
  imageModel: "生图",
  imageEditModel: "图片编辑",
};
/** The purposes each kind of model can serve. */
const KIND_ROLES: Record<ModelKind, (keyof ModelSettingsRoles)[]> = {
  chat: ["chatModel", "auxiliaryModel", "visionModel"],
  embedding: ["embeddingModel"],
  image: ["imageModel", "imageEditModel"],
};
/** A model's own settings, put back as they were by 撤销. */
const MODEL_FIELDS = ["toolCall", "reasoning", "thinkingLevel", "thinkingLevelMap", "name", "hidden"] as const;

export type ModelsPage = ReturnType<typeof createModelsPage>;

export type ConnectionTab = (typeof CONNECTION_TABS)[number]["key"];

export type ModelKind = "chat" | "embedding" | "image";

type ModelSettingsView = ReturnType<typeof createModelSettingsState>;

type AnyModel = ModelSettingsModel | ModelSettingsImageModel;

/**
 * What the models tab shows: the open connection, its view (connection / chat / embedding /
 * advanced) and the open model, all kept in the URL so refresh and shared links reopen them.
 * Every change saves at once through the settings state; a service being added stays on this page
 * until 添加 writes it.
 */
export function createModelsPage(view: ModelSettingsView, routeState: typeof useRouteState = useRouteState) {
  const { state, selected } = view;
  const routeTab = routeState("tab", "connection");
  const tab = computed<ConnectionTab>({
    get: () => (CONNECTION_TABS.some((item) => item.key === routeTab.value) ? (routeTab.value as ConnectionTab) : "connection"),
    set: (value) => {
      routeTab.value = value;
    },
  });
  const connectionRoute = routeState("connection", "");
  const chatSelection = routeState("chatModel", "");
  const embeddingSelection = routeState("embeddingModel", "");
  const imageSelection = routeState("imageModel", "");
  const selectedModelKey = computed({
    get: () => (tab.value === "image" ? imageSelection.value : tab.value === "embedding" ? embeddingSelection.value : chatSelection.value),
    set: (value: string) => {
      if (tab.value === "image") imageSelection.value = value;
      else if (tab.value === "embedding") embeddingSelection.value = value;
      else chatSelection.value = value;
    },
  });
  /** The service editor is open (a page of the 设置 window; a dialog outside it). */
  const mobileEditor = ref(!!connectionRoute.value);
  /** A service being added: kept here, outside the settings, until 添加 writes it. */
  const creating = ref<ModelSettingsConnection>();
  const modelQuery = ref("");
  const modelKeys = new WeakMap<AnyModel, string>();

  const kind = computed<ModelKind>(() => (tab.value === "image" ? "image" : tab.value === "embedding" ? "embedding" : "chat"));
  const models = computed<AnyModel[]>(() => (selected.value && modelList(selected.value, kind.value)) ?? []);
  const rows = computed(() => models.value.map((model) => ({ model, key: keyFor(model) })));
  const filteredModels = computed(() => rows.value.filter((row) => row.model.id.toLowerCase().includes(modelQuery.value.toLowerCase())));
  const activeModel = computed(() => rows.value.find((row) => row.key === selectedModelKey.value)?.model);
  const editable = computed(() => !!state.draft?.writable && !state.loading);

  function keyFor(model: AnyModel) {
    model = toRaw(model);
    let key = modelKeys.get(model);
    if (!key) {
      let index = models.value.findIndex((item) => toRaw(item) === model);
      key = modelSelectionKey(model.id, index);
      // Removed rows keep their neighbours’ keys stable. Reusing the vacated
      // index must not give a newly added row an existing row’s selection key.
      const used = new Set(models.value.map((item) => modelKeys.get(toRaw(item))));
      while (used.has(key)) key = modelSelectionKey(model.id, ++index);
      modelKeys.set(model, key);
    }
    return key;
  }

  function selectConnection(key: string) {
    creating.value = undefined;
    state.selectedKey = key;
    const connection = state.draft?.connections.find((item) => item.key === key);
    // The purpose page reserves “roles”; this is also a valid connection ID.
    connectionRoute.value = connection?.id && connection.id !== "roles" ? connection.id : key;
    mobileEditor.value = !!connection;
    modelQuery.value = "";
  }

  /** Back to the overview; a refreshed URL stays there. A service being added is dropped, never written. */
  function closeConnection() {
    creating.value = undefined;
    mobileEditor.value = false;
    connectionRoute.value = "";
    routeTab.value = "connection";
    chatSelection.value = "";
    embeddingSelection.value = "";
    imageSelection.value = "";
    modelQuery.value = "";
  }

  /** 添加服务: a form of its own; nothing is written until 添加. */
  function startConnection() {
    if (!editable.value) return;
    closeConnection();
    creating.value = newConnection();
    mobileEditor.value = true;
  }

  /** Writes the service being added; once saved, the page shows it like any other. */
  async function addConnection(): Promise<boolean> {
    const connection = creating.value;
    if (!connection) return false;
    const added: ModelSettingsConnection = JSON.parse(JSON.stringify(connection));
    const ok = await view.commit(`添加 ${connectionName(added)}`, (draft) => {
      draft.connections.push(JSON.parse(JSON.stringify(added)));
    });
    if (!ok || creating.value !== connection) return ok;
    creating.value = undefined;
    connectionRoute.value = added.id;
    routeTab.value = "connection";
    return true;
  }

  /** Deleting a service (already confirmed) closes its page and saves at once. */
  function removeConnection(): Promise<boolean> {
    const connection = selected.value;
    if (!connection) return Promise.resolve(false);
    const ref = connectionRef(connection);
    closeConnection();
    return view.commit(`删除 ${connectionName(connection)}`, (draft) => {
      draft.connections = draft.connections.filter((item) => item !== findConnection(draft, ref));
    });
  }

  /**
   * Changes a service. The one being added changes in place; a saved one saves at once, with 撤销 when `revert` is
   * given (an API key cannot be put back: it is never read back from the server).
   */
  function changeConnection(
    connection: ModelSettingsConnection,
    label: string,
    change: (target: ModelSettingsConnection, draft?: ModelSettingsSnapshot) => void,
    revert?: (target: ModelSettingsConnection) => void,
  ): Promise<boolean> {
    if (connection === creating.value) {
      change(connection);
      return Promise.resolve(true);
    }
    const ref = connectionRef(connection);
    const inConnection =
      (edit: (target: ModelSettingsConnection, draft: ModelSettingsSnapshot) => void): ModelSettingsChange =>
      (draft) => {
        const target = findConnection(draft, ref);
        if (target) edit(target, draft);
      };
    return view.commit(label, inConnection(change), revert && inConnection(revert));
  }

  function setConnection<K extends "enabled" | "baseURL" | "apiKey">(
    connection: ModelSettingsConnection,
    label: string,
    key: K,
    value: ModelSettingsConnection[K],
  ) {
    const before = connection[key];
    if (before === value) return Promise.resolve(true);
    return changeConnection(
      connection,
      label,
      (target, draft) => {
        target[key] = value;
        // A service switched on may bring the only model there is to reply with.
        if (key === "enabled" && value === true && draft) view.defaultChat(draft);
      },
      key === "apiKey"
        ? undefined
        : (target) => {
            target[key] = before;
          },
    );
  }

  function setOption<K extends keyof ModelSettingsOptions>(connection: ModelSettingsConnection, label: string, key: K, value: ModelSettingsOptions[K]) {
    const before = connection.options[key];
    if (JSON.stringify(before) === JSON.stringify(value)) return Promise.resolve(true);
    const write = (next: ModelSettingsOptions[K]) => (target: ModelSettingsConnection) => {
      if (next === undefined) delete target.options[key];
      else target.options[key] = next;
    };
    return changeConnection(connection, label, write(value), write(before));
  }

  function setEndpoint(connection: ModelSettingsConnection, endpoint: ConnectionEndpoint) {
    const before = { type: connection.type, options: JSON.parse(JSON.stringify(connection.options)) as ModelSettingsOptions };
    return changeConnection(
      connection,
      "API 协议",
      (target) => setConnectionEndpoint(target, endpoint),
      (target) => {
        target.type = before.type;
        target.options = JSON.parse(JSON.stringify(before.options));
      },
    );
  }

  /** Adds models of the open kind to the open service; the first chat model becomes the reply model. */
  function addModels(ids: string[], into: ModelKind = kind.value): Promise<boolean> {
    const connection = selected.value;
    const fresh = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].filter((id) => !modelList(connection, into)?.some((model) => model.id === id));
    if (!connection || !fresh.length) return Promise.resolve(false);
    const ref = connectionRef(connection);
    const refs = new Set(fresh.map((id) => `${connection.id}:${id}`));
    return view.commit(
      fresh.length === 1 ? `添加 ${fresh[0]}` : `添加 ${fresh.length} 个模型`,
      (draft) => {
        const target = findConnection(draft, ref);
        if (!target) return;
        const list = modelList(target, into, true)!;
        for (const id of fresh) list.push(into === "chat" ? { id, toolCall: true, reasoning: false } : { id });
        if (into === "chat") view.defaultChat(draft);
      },
      (draft) => {
        const target = findConnection(draft, ref);
        const list = target && modelList(target, into);
        if (!list) return;
        for (const id of fresh) {
          const index = list.findIndex((model) => model.id === id);
          if (index >= 0) list.splice(index, 1);
        }
        for (const key of KIND_ROLES[into]) if (refs.has(draft.roles[key] ?? "")) draft.roles[key] = "";
      },
    );
  }

  /** Deleting a model (already confirmed) closes it and saves at once. */
  function removeModel(model: AnyModel): Promise<boolean> {
    const connection = selected.value;
    if (!connection) return Promise.resolve(false);
    const ref = connectionRef(connection);
    const into = kind.value;
    selectedModelKey.value = "";
    return view.commit(`删除 ${model.id}`, (draft) => {
      const target = findConnection(draft, ref);
      const list = target && modelList(target, into);
      const index = list?.findIndex((item) => item.id === model.id) ?? -1;
      if (index >= 0) list!.splice(index, 1);
    });
  }

  /** Changes a model's own settings (not its ID); 撤销 puts all of them back as they were. */
  function changeModel(model: AnyModel, label: string, change: (target: ModelSettingsModel) => void): Promise<boolean> {
    const connection = selected.value;
    if (!connection) return Promise.resolve(false);
    const ref = connectionRef(connection);
    const into = kind.value;
    const id = model.id;
    const before = JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
    const inModel =
      (edit: (target: ModelSettingsModel) => void): ModelSettingsChange =>
      (draft) => {
        const target = findConnection(draft, ref);
        const found = target && modelList(target, into)?.find((item) => item.id === id);
        if (found) edit(found as ModelSettingsModel);
      };
    return view.commit(
      label,
      inModel(change),
      inModel((target) => {
        const fields = target as unknown as Record<string, unknown>;
        for (const field of MODEL_FIELDS) {
          if (before[field] === undefined) delete fields[field];
          else fields[field] = JSON.parse(JSON.stringify(before[field]));
        }
      }),
    );
  }

  /**
   * Renames a model; the purposes that use it follow the new name. Returns why the name cannot be used, or "" once
   * the change is on its way.
   */
  function renameModel(model: AnyModel, text: string): string {
    const connection = selected.value;
    const next = text.trim();
    if (!connection || next === model.id) return "";
    if (!next) return "模型 ID 不能为空。";
    if (models.value.some((item) => item !== model && item.id === next)) return "已有同名模型。";
    const ref = connectionRef(connection);
    const into = kind.value;
    const rename =
      (from: string, to: string): ModelSettingsChange =>
      (draft) => {
        const target = findConnection(draft, ref);
        const found = target && modelList(target, into)?.find((item) => item.id === from);
        if (!found) return;
        found.id = to;
        const old = `${ref.id}:${from}`;
        const renamed = `${ref.id}:${to}`;
        for (const key of KIND_ROLES[into]) if (draft.roles[key] === old) draft.roles[key] = renamed;
        if (into === "chat" && draft.taskModels) draft.taskModels = draft.taskModels.map((item) => (item === old ? renamed : item));
      };
    void view.commit("模型 ID", rename(model.id, next), rename(next, model.id));
    return "";
  }

  /** Purposes that point at this model of the open connection, e.g. "日常回复 · 识图". */
  function usedFor(model: AnyModel): string {
    const roles = state.draft?.roles;
    if (!roles || !selected.value || !model.id) return "";
    const ref = `${selected.value.id}:${model.id}`;
    const names = KIND_ROLES[kind.value].filter((key) => roles[key] === ref).map((key) => ROLE_NAMES[key]);
    if (kind.value === "chat" && state.draft?.taskModels?.includes(ref)) names.push("后台任务");
    return names.join(" · ");
  }

  watch(
    [connectionRoute, () => state.draft],
    () => {
      if (state.draft) state.selectedKey = resolveConnectionSelection(connectionRoute.value, state.draft.connections);
    },
    { immediate: true },
  );
  // A model opens only when asked for (its row, or a link naming it); a link to a renamed or moved model still finds it.
  watch([mobileEditor, connectionRoute, () => `${state.selectedKey}/${tab.value}`, rows], () => {
    if (!mobileEditor.value || !connectionRoute.value || !state.draft || !["chat", "embedding", "image"].includes(tab.value)) return;
    if (selectedModelKey.value && !rows.value.some((row) => row.key === selectedModelKey.value))
      selectedModelKey.value = resolveModelSelection(selectedModelKey.value, rows.value);
  });

  return {
    view,
    state,
    selected,
    creating,
    editable,
    tab,
    kind,
    mobileEditor,
    modelQuery,
    selectedModelKey,
    models,
    rows,
    filteredModels,
    activeModel,
    keyFor,
    selectConnection,
    closeConnection,
    startConnection,
    addConnection,
    removeConnection,
    changeConnection,
    setConnection,
    setOption,
    setEndpoint,
    addModels,
    removeModel,
    changeModel,
    renameModel,
    usedFor,
  };
}

/** The models of one kind of a service; `create` makes the image list for a service that has none yet. */
export function modelList(connection: ModelSettingsConnection | undefined, kind: ModelKind, create = false): AnyModel[] | undefined {
  if (!connection) return undefined;
  if (kind === "chat") return connection.chatModels;
  if (kind === "embedding") return connection.embeddingModels;
  if (create) connection.imageModels ??= [];
  return connection.imageModels;
}

export function connectionSubtitle(connection: ModelSettingsConnection): string {
  const count = connection.chatModels.length + connection.embeddingModels.length + (connection.imageModels?.length ?? 0);
  return [
    protocolLabel(connection),
    connectionHost(connection) !== connectionName(connection) ? connectionHost(connection) : "",
    count ? `${count} 个模型` : "未添加模型",
  ]
    .filter(Boolean)
    .join(" · ");
}

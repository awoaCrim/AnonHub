import { computed, reactive } from "vue";

import type {
  ModelProbeResult,
  ModelCapabilityProbeRequest,
  ModelCapabilityProbeResult,
  ModelCapabilityFailure,
  ModelSettingsConnection,
  ModelSettingsOptions,
  ModelSettingsRoles,
  ModelSettingsSave,
  ModelSettingsSnapshot,
} from "../../../src/model-settings-types";
import { protectedAdminFetch } from "../lib/admin-request";
import { notifyUnauthorized } from "../lib/api";
import { trackEditor } from "../lib/editor-guard";
import { defaultConnectionKey } from "../lib/model-route-state";
import type { PickerOption } from "../lib/picker";
import { toast } from "../lib/toast";

export const protocolOptions: PickerOption<ConnectionEndpoint>[] = [
  { value: "openai-chat", label: "OpenAI Chat Completions", note: "/chat/completions" },
  { value: "openai-responses", label: "OpenAI Responses", note: "/responses" },
  { value: "anthropic", label: "Anthropic", note: "/messages" },
  { value: "google", label: "Google", note: "Gemini API" },
  { value: "deepseek", label: "DeepSeek", note: "/chat/completions" },
];

export const probeMessages: Record<NonNullable<ModelProbeResult["error"]>, string> = {
  invalid_request: "服务地址或协议无效。",
  missing_key: "请先填写 API 密钥。修改服务地址后需要重新填写密钥。",
  unauthorized: "API 密钥无效或没有权限。",
  not_found: "该地址没有模型列表接口，请检查服务地址（通常以 /v1 结尾）。",
  timeout: "连接超时，请检查服务地址和网络。",
  network: "无法连接到该地址。",
  bad_response: "服务返回的内容无法识别。仍可手动填写模型 ID。",
  rate_limited: "检测过于频繁，请稍后再试。",
  forbidden: "登录已失效或没有权限，请重新登录后重试。",
};

export const capabilityFailureMessages: Record<ModelCapabilityFailure, string> = {
  authentication: "认证失败",
  permission: "没有权限",
  quota: "服务额度不足",
  context_limit: "上下文超限",
  rate_limit: "服务限流",
  unavailable: "服务暂不可用",
  invalid_request: "请求参数被拒绝",
  invalid_response: "响应格式无效",
  network: "连接失败",
  timeout: "请求超时",
  cancelled: "已取消",
  invalid_result: "未得到预期结果",
};

/** Which options each endpoint reads; switching endpoints drops the rest. */
const ENDPOINT_OPTIONS: Record<ConnectionEndpoint, readonly (keyof ModelSettingsOptions)[]> = {
  "openai-chat": ["format", "imageToolResultSupport"],
  "openai-responses": ["format", "webSearch", "imageToolResultSupport", "imageToolResultPlacement"],
  anthropic: ["webSearch"],
  google: ["imageToolResultMediaTypes"],
  deepseek: ["thinking"],
};
const GENERATED_ID = /^(connection-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The API a connection calls, one per endpoint: OpenAI has two (user, 2026-11-19: 「模型服务按照端点进行划分，openai也有两种端点啊」).
 * Saved as the connection's `type` plus, for OpenAI, `options.format`; an OpenAI connection without a format uses Chat Completions.
 */
export type ConnectionEndpoint = "openai-chat" | "openai-responses" | "anthropic" | "google" | "deepseek";

export type ModelSettingsRequest = (body?: ModelSettingsSave, fresh?: boolean) => Promise<ModelSettingsSnapshot>;

/**
 * One change to the model settings. It is applied to the page at once and replayed on a newer copy after a save, so it
 * finds what it changes by name (a service's ID, a model's ID), never by the copy's row keys.
 */
export type ModelSettingsChange = (draft: ModelSettingsSnapshot) => void;

/** Says a save went through; `undo` puts back what it changed. */
export type ModelSettingsNotify = (text: string, undo?: () => void) => void;

/** A service as the page names it across saves: by its ID once it has one, otherwise by its row. */
export type ConnectionRef = Pick<ModelSettingsConnection, "id" | "key">;

interface Queued {
  label: string;
  apply: ModelSettingsChange;
  revert?: ModelSettingsChange;
  undo: boolean;
  done(saved: boolean): void;
}

export function connectionEndpoint(connection: Pick<ModelSettingsConnection, "type" | "options">): string {
  if (connection.type !== "openai") return connection.type;
  return connection.options?.format === "responses" ? "openai-responses" : "openai-chat";
}

/** The endpoint's name, e.g. 「OpenAI Chat Completions」; an unknown protocol shows its own type. */
export function protocolLabel(connection: Pick<ModelSettingsConnection, "type" | "options">): string {
  const endpoint = connectionEndpoint(connection);
  return protocolOptions.find((option) => option.value === endpoint)?.label ?? connection.type;
}

/** The connection `type` an endpoint is saved as. */
export function endpointType(endpoint: ConnectionEndpoint): string {
  return endpoint === "openai-chat" || endpoint === "openai-responses" ? "openai" : endpoint;
}

/** Points a connection at another endpoint, dropping the options only the previous one read. */
export function setConnectionEndpoint(connection: Pick<ModelSettingsConnection, "type" | "options">, endpoint: ConnectionEndpoint) {
  connection.type = endpointType(endpoint);
  const kept = ENDPOINT_OPTIONS[endpoint];
  for (const key of Object.keys(connection.options) as (keyof ModelSettingsOptions)[]) if (!kept.includes(key)) delete connection.options[key];
  if (connection.type === "openai") connection.options.format = endpoint === "openai-responses" ? "responses" : "chat";
}

export async function requestModelCapabilityProbe(request: ModelCapabilityProbeRequest, fetcher: typeof fetch = fetch): Promise<ModelCapabilityProbeResult> {
  try {
    const response = await fetcher("/yesimbot/model-settings/capability-probe", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (response.status === 401) notifyUnauthorized("/yesimbot/model-settings/capability-probe");
    if (!response.ok) return { ok: false, checks: [], error: response.status === 401 || response.status === 403 ? "forbidden" : "network" };
    const result = await response.json();
    return result && Array.isArray(result.checks) ? result : { ok: false, checks: [], error: "network" };
  } catch {
    return { ok: false, checks: [], error: "network" };
  }
}

/**
 * Asks the server to list a connection's models. A blank key reuses the saved one for an unchanged address.
 * Not routed through the request cache: a probe must not invalidate cached model settings.
 */
export async function requestModelProbe(
  connection: Pick<ModelSettingsConnection, "key" | "type" | "baseURL" | "apiKey">,
  fetcher: typeof fetch = fetch,
): Promise<ModelProbeResult> {
  let response: Response;
  try {
    response = await fetcher("/yesimbot/model-settings/probe", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: connection.type,
        baseURL: connection.baseURL,
        ...(connection.apiKey ? { apiKey: connection.apiKey } : { key: connection.key }),
      }),
    });
  } catch {
    return { ok: false, models: [], error: "network" };
  }
  if (response.status === 401) notifyUnauthorized("/yesimbot/model-settings/probe");
  if (!response.ok) return { ok: false, models: [], error: response.status === 401 || response.status === 403 ? "forbidden" : "bad_response" };
  const result = (await response.json().catch(() => undefined)) as ModelProbeResult | undefined;
  return result && Array.isArray(result.models) ? result : { ok: false, models: [], error: "bad_response" };
}

/** The service host of a connection, else its protocol. */
export function connectionHost(connection: Pick<ModelSettingsConnection, "baseURL" | "type" | "options">): string {
  try {
    if (connection.baseURL.trim()) return new URL(connection.baseURL.trim()).host || connection.baseURL.trim();
  } catch {
    return connection.baseURL.trim();
  }
  return (connection.type && protocolLabel(connection)) || "新连接";
}

/**
 * Endpoints that draw (user, 2026-11-23: 「图片也需要看端点」): OpenAI through its Images API, Gemini through its own
 * generateContent. Anthropic and DeepSeek have no image output.
 */
export function servesImages(type: ModelSettingsConnection["type"] | undefined): boolean {
  return type === "openai" || type === "google";
}

/** Short human name for a connection: an ID someone wrote by hand (e.g. "deepseek-main"), else the service host. Generated UUID IDs are never shown. */
export function connectionName(connection: Pick<ModelSettingsConnection, "baseURL" | "type" | "options"> & { id?: string }): string {
  const id = connection.id?.trim();
  return id && !GENERATED_ID.test(id) && !id.includes(":") ? id : connectionHost(connection);
}

export async function requestModelSettings(body?: ModelSettingsSave, fresh = false): Promise<ModelSettingsSnapshot> {
  const response = await protectedAdminFetch(
    "/yesimbot/model-settings",
    {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
    fresh,
  );
  if (!response.ok) {
    if (response.status === 409) throw new Error("模型设置已在别处修改，已换成最新的设置。");
    if (response.status === 401) throw new Error("管理员登录已失效，请重新登录。");
    if (response.status === 400 || response.status === 503) {
      let message = "";
      try {
        const text = await response.text();
        if (text.length <= 4096) {
          const payload: unknown = JSON.parse(text);
          if (
            payload &&
            typeof payload === "object" &&
            "message" in payload &&
            typeof payload.message === "string" &&
            payload.message.trim().length > 0 &&
            payload.message.length <= 500
          )
            message = payload.message.trim();
        }
      } catch {
        /* A malformed answer falls back to the fixed text below. */
      }
      if (message) throw new Error(message);
    }
    throw new Error(response.status === 400 ? "模型设置未通过验证。" : body ? "模型设置没能保存，请稍后重试。" : "无法读取模型设置，请稍后重试。");
  }
  return response.json();
}

/**
 * The model settings, changed in place (user, 2026-11-26: 设置全部改成即改即存). A change shows at once and is saved
 * at once; changes made while a save is on its way wait and then go out together, as one save with one 已保存 and one
 * 撤销. A failed save shows the copy the server kept, so the page never shows a value that was not saved.
 */
export function createModelSettingsState(request: ModelSettingsRequest = requestModelSettings, notify: ModelSettingsNotify = notifySaved) {
  const state = reactive({
    /** The server's copy with every change not saved yet applied. */
    draft: undefined as ModelSettingsSnapshot | undefined,
    selectedKey: "",
    query: "",
    error: "",
    /** Reading the settings before anything is shown. */
    loading: false,
    /** A save is on its way (or changes wait for one). */
    saving: false,
  });
  let queue: Queued[] = [];
  let reading: Promise<void> | undefined;
  let disposed = false;
  /** The owner picked the reply model (or cleared it) themselves; it is no longer filled in for them. */
  let chatModelChosen = false;
  // Leaving the page waits for a save on its way.
  trackEditor(
    () => state.saving,
    () => state.saving,
  );
  const selected = computed(() => state.draft?.connections.find((connection) => connection.key === state.selectedKey));
  const connections = computed(
    () =>
      state.draft?.connections.filter((connection) =>
        `${connection.id} ${connection.baseURL} ${protocolLabel(connection)}`.toLowerCase().includes(state.query.toLowerCase()),
      ) ?? [],
  );

  /** Shows the server's copy, with the changes still waiting replayed on it. */
  function show(snapshot: ModelSettingsSnapshot) {
    const draft = clone(snapshot);
    for (const change of queue) change.apply(draft);
    state.draft = draft;
    if (state.selectedKey !== "roles" && !draft.connections.some((connection) => connection.key === state.selectedKey))
      state.selectedKey = defaultConnectionKey(draft.connections);
  }

  function read(fresh = false): Promise<void> {
    if (disposed) return Promise.resolve();
    reading ??= (async () => {
      state.loading = !state.draft;
      state.error = "";
      try {
        const snapshot = await request(undefined, fresh);
        // A save on its way shows its own answer.
        if (!disposed && !state.saving) show(snapshot);
      } catch (error) {
        if (!disposed) state.error = errorText(error);
      } finally {
        reading = undefined;
        if (!disposed) state.loading = false;
      }
    })();
    return reading;
  }

  /**
   * Applies `apply` now and saves it; `revert`, when the change can be undone, is offered as 撤销. Resolves with
   * whether the server kept the change.
   */
  function commit(label: string, apply: ModelSettingsChange, revert?: ModelSettingsChange, undo = false): Promise<boolean> {
    const draft = state.draft;
    if (disposed || !draft?.writable || state.loading) return Promise.resolve(false);
    return new Promise<boolean>((done) => {
      apply(draft);
      queue.push({ label, apply, revert, undo, done });
      void flush();
    });
  }

  async function flush() {
    if (state.saving) return;
    state.saving = true;
    state.error = "";
    try {
      while (queue.length && !disposed && state.draft) {
        const batch = queue;
        queue = [];
        try {
          // The page's copy already holds every change of the batch.
          const next = await request(saveBody(state.draft));
          if (disposed) return;
          show(next);
          announce(batch);
          for (const change of batch) change.done(true);
        } catch (error) {
          if (disposed) return;
          state.error = errorText(error);
          try {
            const latest = await request(undefined, true);
            if (!disposed) show(latest);
          } catch {
            // Unreadable now: the page keeps what it shows until the next change or reload.
          }
          // Reported once the page shows what the server kept.
          for (const change of batch) change.done(false);
        }
      }
    } finally {
      if (!disposed) state.saving = false;
    }
  }

  function announce(batch: Queued[]) {
    const text = [...new Set(batch.map((change) => change.label))].join("、");
    if (batch.some((change) => change.undo)) return notify(`已撤销：${text}`);
    const reverts = batch.map((change) => change.revert);
    const revertAll: ModelSettingsChange = (draft) => {
      for (const revert of [...reverts].reverse()) revert?.(draft);
    };
    notify(`已保存：${text}`, reverts.every(Boolean) ? () => void commit(text, revertAll, undefined, true) : undefined);
  }

  /** Fills in the reply model while the settings offer exactly one and the owner has not picked one. */
  function defaultChat(draft: ModelSettingsSnapshot) {
    if (chatModelChosen || draft.roles.chatModel) return;
    const choices = modelChoicesOf(draft);
    if (choices.length === 1) draft.roles.chatModel = choices[0]!.value;
  }

  function setRole(key: keyof ModelSettingsRoles, value: string | undefined, label: string): Promise<boolean> {
    const draft = state.draft;
    if (!draft) return Promise.resolve(false);
    const before = draft.roles[key];
    if (before === value) return Promise.resolve(true);
    if (key === "chatModel") chatModelChosen = true;
    const write =
      (next: string | undefined): ModelSettingsChange =>
      (target) => {
        // An absent image purpose keeps the server's choice; only an explicit one is sent.
        if (next === undefined && (key === "imageModel" || key === "imageEditModel")) delete target.roles[key];
        else target.roles[key] = next ?? "";
      };
    return commit(label, write(value), write(before));
  }

  function setTaskModels(next: string[]): Promise<boolean> {
    const before = [...(state.draft?.taskModels ?? [])];
    return commit(
      "后台任务",
      (draft) => {
        draft.taskModels = [...next];
      },
      (draft) => {
        draft.taskModels = [...before];
      },
    );
  }

  return {
    state,
    selected,
    connections,
    commit,
    defaultChat,
    setRole,
    setTaskModels,
    modelChoices: (kind: boolean | "image" = false) => modelChoicesOf(state.draft, kind),
    reload: (fresh = false) => read(fresh),
    setVisible: (visible: boolean) => (visible && !state.draft ? read() : Promise.resolve()),
    dispose() {
      disposed = true;
      queue = [];
      state.saving = false;
    },
  };
}

export function connectionRef(connection: ConnectionRef): ConnectionRef {
  return { id: connection.id, key: connection.key };
}

export function findConnection(draft: ModelSettingsSnapshot, ref: ConnectionRef): ModelSettingsConnection | undefined {
  return draft.connections.find((connection) => (ref.id.trim() ? connection.id === ref.id : connection.key === ref.key));
}

/** A service not saved yet, as 添加服务 starts it. */
export function newConnection(): ModelSettingsConnection {
  const identity = newConnectionId();
  return {
    key: `new:${identity}`,
    id: `connection-${identity}`,
    type: "openai",
    enabled: true,
    baseURL: "",
    hasApiKey: false,
    chatModels: [],
    embeddingModels: [],
    imageModels: [],
    options: {},
  };
}

export function modelChoicesOf(draft: ModelSettingsSnapshot | undefined, kind: boolean | "image" = false) {
  const embedding = kind === true;
  const image = kind === "image";
  return (
    draft?.connections
      .filter(
        (connection) =>
          connection.enabled &&
          connection.id.trim() &&
          !connection.id.includes(":") &&
          (!image || servesImages(connection.type)) &&
          (!embedding || connection.type === "openai" || connection.type === "google"),
      )
      .flatMap((connection) =>
        (image ? (connection.imageModels ?? []) : embedding ? connection.embeddingModels : connection.chatModels)
          .filter((model) => model.id.trim() && (!image || !("hidden" in model && model.hidden)))
          .map((model) => ({
            value: `${connection.id}:${model.id}`,
            label: `${model.id} · ${connectionName(connection)}`,
          })),
      ) ?? []
  );
}

function saveBody(draft: ModelSettingsSnapshot): ModelSettingsSave {
  const body: ModelSettingsSave = { revision: draft.revision, roles: clone(draft.roles), connections: clone(draft.connections) };
  if (draft.taskModels !== undefined) body.taskModels = [...draft.taskModels];
  for (const connection of body.connections) if (!connection.apiKey) delete connection.apiKey;
  return body;
}

function notifySaved(text: string, undo?: () => void): void {
  toast(text, "ok", undefined, undo && { label: "撤销", run: undo });
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "模型设置没能保存，请稍后重试。";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function newConnectionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

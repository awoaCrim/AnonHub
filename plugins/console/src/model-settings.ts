import type { IncomingMessage } from "node:http";
import { isDeepStrictEqual } from "node:util";

import type { httpFetch } from "@yesimbot/foundation";

import type { AdminAuth } from "./admin-auth.js";
import { pluginConfigSource } from "./config/form.js";
import { settleReload } from "./config/settle.js";
import { ConfigStore, ConfigError } from "./config/store.js";
import type { Host } from "./host.js";
import { capabilityProbeRequest, probeModelCapabilities, probeModels, probeRequest } from "./model-probe.js";
import type {
  ModelProbeRequest,
  ModelProbeResult,
  ModelCapabilityProbeResult,
  ModelSettingsConnection,
  ModelSettingsImageModel,
  ModelSettingsModel,
  ModelSettingsOptions,
  ModelSettingsSave,
  ModelSettingsSnapshot,
} from "./model-settings-types.js";

const requiredRoles = ["chatModel", "auxiliaryModel", "visionModel", "embeddingModel"] as const;

const imageRoles = ["imageModel", "imageEditModel"] as const;

const roles = [...requiredRoles, ...imageRoles] as const;

const options = ["format", "webSearch", "thinking", "imageToolResultSupport", "imageToolResultPlacement", "imageToolResultMediaTypes"] as const;

const modelFields = ["id", "toolCall", "reasoning", "thinkingLevel", "thinkingLevelMap"] as const;

const imageModelFields = ["id", "name", "hidden"] as const;

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const nativeLevels = [...levels, "none"];

const PROBES_PER_MINUTE = 10;

type ObjectValue = Record<string, unknown>;

interface Entry {
  parent: string;
  key: string;
  value: ObjectValue;
  scoped: boolean;
}

/** Narrow configuration adapter. It never accepts plugin names, scope identities or arbitrary config from a client. */
export class ModelSettingsStore {
  private saving = false;
  private configStore: ConfigStore;
  constructor(private ctx: Host) {
    this.configStore = new ConfigStore(ctx);
  }
  private state() {
    const all = entries((this.ctx.loader.config.plugins ?? {}) as ObjectValue);
    const providers = all.filter((entry) => name(entry) === "yesimbot-model-provider");
    const cores = all.filter((entry) => name(entry) === "yesimbot");
    const writer = this.configStore;
    const reason =
      providers.length !== 1
        ? "需要恰好一个模型接入插件，请先在高级配置中合并。"
        : cores.length !== 1
          ? "需要恰好一个 YesImBot 配置。"
          : [...providers, ...cores].some((entry) => entry.scoped)
            ? "停用或带条件、筛选器的配置需要在高级配置中管理。"
            : !this.ctx.loader.writable
              ? "当前配置不可写。"
              : undefined;
    return { provider: providers[0], core: cores[0], writer, reason };
  }
  /** Saved credential for a probe, only while the address it was saved for is unchanged. */
  probeKey(key: string | undefined, type: string, baseURL: string): string | undefined {
    const index = /^connection:(\d+)$/.exec(key ?? "")?.[1];
    if (index === undefined) return undefined;
    const original = sourceConnections(this.state().provider)[Number(index)];
    if (!original || (text(original.type) || "openai") !== type || safeURL(original.baseURL) !== safeURL(baseURL)) return undefined;
    return text(original.apiKey) || undefined;
  }
  /** Capability checks use saved, active model configuration and the actual registered route. */
  capabilityModel(key: string, model: string): string | undefined {
    const index = /^connection:(\d+)$/.exec(key)?.[1];
    if (index === undefined) return;
    const original = sourceConnections(this.state().provider)[Number(index)];
    if (
      !original ||
      original.enabled === false ||
      !text(original.id) ||
      !Array.isArray(original.chatModels) ||
      !original.chatModels.some((entry) => object(entry) && entry.id === model)
    )
      return;
    return `${text(original.id)}:${model}`;
  }
  read(): ModelSettingsSnapshot {
    const state = this.state();
    const core = state.core?.value ?? {};
    const revision = this.configStore.revision();
    return {
      revision,
      writable: !state.reason,
      ...(this.configStore.allowed() ? { contextManaged: true } : {}),
      ...(state.reason ? { reason: state.reason } : {}),
      connections: sourceConnections(state.provider).map(project),
      taskModels: Array.isArray(core.taskModels) ? core.taskModels.filter((value): value is string => typeof value === "string") : [],
      roles: {
        chatModel: text(core.chatModel),
        auxiliaryModel: text(core.auxiliaryModel),
        visionModel: text(core.visionModel),
        embeddingModel: text(core.embeddingModel),
        ...(Object.hasOwn(core, "imageModel") ? { imageModel: text(core.imageModel) } : {}),
        ...(Object.hasOwn(core, "imageEditModel") ? { imageEditModel: text(core.imageEditModel) } : {}),
      },
    };
  }
  async save(input: unknown): Promise<ModelSettingsSnapshot> {
    if (this.saving) throw new SettingsError(409, "另一个保存正在进行，请重新加载后重试。");
    this.saving = true;
    try {
      if (!object(input) || typeof input.revision !== "string") throw new SettingsError(400, "模型设置格式无效。");
      return await this.configStore.transaction(input.revision, () => this.saveUnlocked(input));
    } catch (error) {
      if (error instanceof ConfigError)
        throw new SettingsError(error.status, error.code === "config_changed" ? "配置已被修改，请重新加载后重试。" : "配置保存失败。");
      throw error;
    } finally {
      this.saving = false;
    }
  }
  private async saveUnlocked(input: unknown): Promise<ModelSettingsSnapshot> {
    const snapshot = this.read();
    const state = this.state();
    if (!object(input) || typeof input.revision !== "string" || !Array.isArray(input.connections) || !object(input.roles))
      throw new SettingsError(400, "模型设置格式无效。");
    if (input.revision !== snapshot.revision) throw new SettingsError(409, "配置已被修改，请重新加载后重试。");
    if (!snapshot.writable) throw new SettingsError(400, snapshot.reason!);
    const incoming = input as unknown as ModelSettingsSave;
    if (
      Object.hasOwn(input, "taskModels") &&
      (!Array.isArray(input.taskModels) ||
        input.taskModels.length > 100 ||
        input.taskModels.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > 512) ||
        new Set(input.taskModels).size !== input.taskModels.length)
    )
      throw new SettingsError(400, "后台任务模型列表无效，请选择不重复的模型。");
    if (
      incoming.connections.length > 100 ||
      requiredRoles.some((role) => typeof incoming.roles[role] !== "string" || incoming.roles[role].length > 512) ||
      imageRoles.some((role) => Object.hasOwn(incoming.roles, role) && (typeof incoming.roles[role] !== "string" || incoming.roles[role]!.length > 512)) ||
      Object.keys(incoming.roles).some((key) => !roles.includes(key as (typeof roles)[number]))
    )
      throw new SettingsError(400, "模型用途或连接数量无效。");
    const draft = { ...incoming, roles: { ...snapshot.roles, ...incoming.roles } };
    const imageEditChanged = draft.roles.imageEditModel !== snapshot.roles.imageEditModel;
    if (imageEditChanged && draft.roles.imageEditModel && !draft.roles.imageModel) throw new SettingsError(400, "请先选择生图模型，再设置独立编辑模型。");
    const originalProvider = state.provider!.value;
    const originals = sourceConnections({ ...state.provider!, value: originalProvider });
    const keys = new Set<string>();
    const candidate = draft.connections.map((connection) => this.mergeConnection(connection, originals, snapshot.connections, keys));
    let providerPlugin: Parameters<typeof pluginConfigSource>[0];
    try {
      providerPlugin = await this.ctx.loader.resolve("yesimbot-model-provider");
    } catch {
      /* handled below */
    }
    if (!providerPlugin) throw new SettingsError(400, "模型接入插件不可用，请检查安装。");
    if (pluginConfigSource(providerPlugin).check({ connections: candidate }) !== undefined)
      throw new SettingsError(400, "连接配置无效，请检查已启用连接的协议、凭据和模型选项。");
    const ids = new Set<string>();
    const chat = new Set<string>();
    const embedding = new Set<string>();
    const images = new Set<string>();
    for (const connection of candidate) {
      const id = text(connection.id);
      const type = text(connection.type) || "openai";
      if (connection.enabled !== false && !id.trim()) throw new SettingsError(400, "已启用连接的标识不能为空。");
      if (id && ids.has(id)) throw new SettingsError(400, "连接标识不能重复。");
      if (id) ids.add(id);
      for (const [field, target] of [
        ["chatModels", chat],
        ["embeddingModels", embedding],
        ["imageModels", images],
      ] as const) {
        const modelIds = new Set<string>();
        for (const model of Array.isArray(connection[field]) ? connection[field].filter(object) : []) {
          const modelId = text(model.id);
          if (connection.enabled === false && !modelId.trim()) continue;
          if (!modelId.trim() || modelIds.has(modelId)) throw new SettingsError(400, "模型标识不能为空或重复。");
          modelIds.add(modelId);
          if (
            connection.enabled !== false &&
            // Images follow the endpoint: OpenAI's Images API or Gemini's generateContent (user, 2026-11-23).
            (field === "chatModels" || type === "openai" || type === "google")
          )
            target.add(`${id}:${modelId}`);
        }
      }
    }
    for (const role of roles) {
      const target = role === "embeddingModel" ? embedding : role === "imageModel" || role === "imageEditModel" ? images : chat;
      const selection = draft.roles[role];
      if (selection && !target.has(selection)) throw new SettingsError(400, "模型用途必须选择已启用连接中的对应模型。");
    }
    const taskModels = incoming.taskModels ?? snapshot.taskModels ?? [];
    const taskModelsChanged = incoming.taskModels !== undefined && !isDeepStrictEqual(incoming.taskModels, snapshot.taskModels);
    const originalChat = new Set(
      originals
        .filter((connection) => connection.enabled !== false)
        .flatMap((connection) =>
          (Array.isArray(connection.chatModels) ? connection.chatModels.filter(object) : []).map((model) => `${text(connection.id)}:${text(model.id)}`),
        ),
    );
    for (const ref of taskModels) {
      // An unchanged stale native reference is retained on no-op saves;
      // this save may neither introduce one nor remove a route still in use.
      if (!chat.has(ref) && (taskModelsChanged || originalChat.has(ref)))
        throw new SettingsError(400, "后台任务模型必须选择已启用连接中的聊天模型；删除或停用前，请先移除对应的后台任务用途。");
    }
    let provider: ObjectValue = { ...clone(originalProvider), connections: candidate };
    if (isDeepStrictEqual(candidate, originals)) provider = clone(originalProvider);
    const core = clone(state.core!.value);
    if (taskModelsChanged) core.taskModels = [...incoming.taskModels!];
    for (const role of ["chatModel", "auxiliaryModel", "visionModel"] as const) if (draft.roles[role] !== snapshot.roles[role]) core[role] = draft.roles[role];
    for (const role of imageRoles) if (draft.roles[role] !== snapshot.roles[role]) core[role] = draft.roles[role];
    if (draft.roles.embeddingModel !== snapshot.roles.embeddingModel) core.embeddingModel = draft.roles.embeddingModel;
    // Module resolution is asynchronous; reject a native-editor change that raced validation.
    if (this.read().revision !== draft.revision) throw new SettingsError(409, "配置已被修改，请重新加载后重试。");
    const changes: { entry: Entry; value: ObjectValue }[] = [
      { entry: state.provider!, value: provider },
      { entry: state.core!, value: core },
    ];
    const changed = changes.filter(({ entry, value }) => JSON.stringify(entry.value) !== JSON.stringify(value));
    const attempted: typeof changed = [];
    try {
      for (const change of changed) {
        attempted.push(change);
        await state.writer.updateRaw([change.entry.parent, change.entry.key].filter(Boolean).join("/"), change.value);
        await this.settleReload(change.entry);
      }
    } catch {
      let restored = true;
      for (const change of attempted.reverse()) {
        try {
          await state.writer.updateRaw([change.entry.parent, change.entry.key].filter(Boolean).join("/"), clone(change.entry.value));
          await this.settleReload(change.entry);
        } catch {
          restored = false;
        }
      }
      throw new SettingsError(503, restored ? "保存失败，已恢复之前的配置，请重试。" : "保存失败且自动恢复未完成，请检查高级配置与服务状态。");
    }
    return this.read();
  }
  private async settleReload(entry: Entry): Promise<void> {
    await settleReload(this.ctx);
    if (!this.ctx.get("yesimbot")) throw new Error("Model-dependent services did not start.");
    const separator = entry.key.indexOf(":");
    const identity = separator < 0 ? "" : entry.key.slice(separator + 1);
    const pluginName = entry.key.split(":", 1)[0];
    for (const runtime of this.ctx.registry.values()) {
      if (this.ctx.loader.keyFor(runtime.plugin) !== pluginName) continue;
      for (const fork of runtime.children) {
        const sameParent = entry.parent
          ? fork.parent.scope.key === entry.parent.split("/").at(-1)?.split(":").slice(1).join(":")
          : fork.parent.scope === this.ctx.loader.entry?.scope;
        // Reusable plugins execute in each configuration fork. Their shared main
        // scope may lack the fork's injected services and legitimately stay inactive.
        if (sameParent && fork.key === identity && (fork.error || runtime.error || !fork.isActive || (!runtime.isReusable && !runtime.isActive)))
          throw new Error("Model configuration scope failed to start.");
      }
    }
  }
  private mergeConnection(value: unknown, originals: ObjectValue[], publicOriginals: ModelSettingsConnection[], keys: Set<string>): ObjectValue {
    if (!object(value) || typeof value.key !== "string" || keys.has(value.key)) throw new SettingsError(400, "连接草稿标识无效或重复。");
    keys.add(value.key);
    const index = /^connection:(\d+)$/.exec(value.key)?.[1];
    const original = index === undefined ? undefined : originals[Number(index)];
    if (!original && !/^new:[0-9a-f-]{36}$/i.test(value.key)) throw new SettingsError(400, "连接草稿已失效，请重新加载。");
    if (
      typeof value.enabled !== "boolean" ||
      (!["openai", "anthropic", "google", "deepseek"].includes(text(value.type)) && !(original && value.enabled === false && value.type === original.type)) ||
      typeof value.id !== "string" ||
      value.id.length > 128 ||
      typeof value.baseURL !== "string" ||
      value.baseURL.length > 2048 ||
      !object(value.options)
    )
      throw new SettingsError(400, "连接字段无效。");
    if (value.id.includes(":") && (!original || original.id !== value.id))
      throw new SettingsError(400, "连接标识不能包含冒号（:）。请重新创建连接，并将 URL 填入「服务地址」。");
    if (original && text(original.id) && original.id !== value.id) throw new SettingsError(400, "已有连接标识不能修改，以保护其他模型引用。");
    if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length > 8192)) throw new SettingsError(400, "API Key 格式无效。");
    const result: ObjectValue = clone(original ?? {});
    const priorPublic = index !== undefined ? publicOriginals[Number(index)] : undefined;
    for (const key of ["enabled", "type", "id"] as const) if (!priorPublic || priorPublic[key] !== value[key]) result[key] = value[key];
    const baseURLChanged = !original || priorPublic?.baseURL !== value.baseURL;
    if (baseURLChanged || (value.type === "google" && priorPublic?.type !== value.type)) {
      if (value.baseURL && !/^https?:\/\//.test(value.baseURL)) throw new SettingsError(400, "API 地址必须是 HTTP(S) URL。");
      let baseURL = baseURLChanged ? value.baseURL : text(original?.baseURL);
      if (value.type === "google" && baseURL) {
        try {
          const url = new URL(baseURL);
          if (url.pathname === "/") {
            url.pathname = "/v1beta";
            baseURL = url.href;
          }
        } catch {
          throw new SettingsError(400, "API 地址必须是有效的 HTTP(S) URL。");
        }
      }
      if (baseURL) result.baseURL = baseURL;
      else delete result.baseURL;
    }
    if (value.apiKey !== undefined) result.apiKey = value.apiKey;
    const publicOpts = publicOptions(value.options);
    if (!isDeepStrictEqual(publicOpts, value.options)) throw new SettingsError(400, "高级选项无效。");
    for (const key of options) {
      if (Object.hasOwn(publicOpts, key)) result[key] = publicOpts[key];
      else if (original && Object.hasOwn(publicOptions(original), key)) delete result[key];
    }
    const usedModelKeys = new Set<string>();
    for (const field of ["chatModels", "embeddingModels", "imageModels"] as const) {
      if (field === "imageModels" && !Object.hasOwn(value, field)) continue;
      if (!Array.isArray(value[field]) || value[field].length > 500) throw new SettingsError(400, "模型列表无效。");
      if (priorPublic && isDeepStrictEqual(priorPublic[field], value[field])) continue;
      const previous = Array.isArray(original?.[field]) ? original[field].filter(object) : [];
      const fields: readonly string[] = field === "imageModels" ? imageModelFields : modelFields;
      const projectModel = (model: ObjectValue): ObjectValue => ({ ...(field === "imageModels" ? publicImageModel(model) : publicModel(model)) });
      result[field] = value[field].map((model: unknown) => {
        if (!object(model) || typeof model.id !== "string" || model.id.length > 256 || Object.keys(model).some((key) => key !== "key" && !fields.includes(key)))
          throw new SettingsError(400, "模型字段无效。");
        const { key: modelKey, ...modelInput } = model;
        let prior: ObjectValue | undefined;
        if (modelKey !== undefined) {
          if (typeof modelKey !== "string" || usedModelKeys.has(modelKey)) throw new SettingsError(400, "模型草稿标识无效或重复。");
          usedModelKeys.add(modelKey);
          const modelIndex = priorPublic?.[field]?.findIndex((item) => item.key === modelKey) ?? -1;
          if (modelIndex < 0) throw new SettingsError(400, "模型草稿标识不属于当前连接和模型类型，请重新加载。");
          prior = previous[modelIndex];
        } else {
          // Compatibility with drafts loaded before model identities were introduced.
          prior = previous.find((item) => item.id === model.id);
        }
        const projected = projectModel(modelInput);
        if (!isDeepStrictEqual(projected, modelInput)) throw new SettingsError(400, "模型选项无效。");
        const priorModelPublic = prior ? projectModel(prior) : undefined;
        const merged: ObjectValue = { ...clone(prior ?? {}) };
        for (const key of fields) {
          if (priorModelPublic && isDeepStrictEqual(priorModelPublic[key], projected[key])) continue;
          delete merged[key];
          if (Object.hasOwn(projected, key)) merged[key] = projected[key];
        }
        return merged;
      });
    }
    return result;
  }
}

class SettingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readModelSettingsBody(http: { get(name: string): string; request: object; req: IncomingMessage }): Promise<unknown> {
  const limit = 512 * 1024;
  if (http.get("content-type").split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new SettingsError(400, "需要 JSON 请求。");
  let value = (http.request as { body?: unknown }).body;
  const length = http.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new SettingsError(400, "配置请求超过 512 KiB。");
  if (value === undefined) {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const cleanup = () => {
        clearTimeout(timer);
        http.req.off("data", data);
        http.req.off("end", end);
        http.req.off("error", fail);
        http.req.off("aborted", fail);
      };
      const fail = () => {
        cleanup();
        http.req.resume();
        reject(new SettingsError(400, "配置请求无效或过大。"));
      };
      const data = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit) return fail();
        chunks.push(buffer);
      };
      const end = () => {
        cleanup();
        resolve(Buffer.concat(chunks));
      };
      const timer = setTimeout(fail, 10_000);
      http.req.on("data", data);
      http.req.once("end", end);
      http.req.once("error", fail);
      http.req.once("aborted", fail);
    });
    value = JSON.parse(raw.toString("utf8"));
  } else if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new SettingsError(400, "配置请求超过 512 KiB。");
  return value;
}

export function installModelSettings(ctx: Host, auth: AdminAuth, options: { fetcher?: typeof httpFetch } = {}): void {
  if (!auth.config.enabled) return;
  const store = new ModelSettingsStore(ctx);
  ctx.server.get("/yesimbot/model-settings", (http) => {
    if (auth.requireOwner(http)) http.body = store.read();
  });
  ctx.server.post("/yesimbot/model-settings", async (http) => {
    if (!auth.requireOwner(http)) return;
    if (!auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { message: "Same-origin request required." };
      return;
    }
    try {
      http.body = await store.save(await readModelSettingsBody(http));
    } catch (error) {
      http.status = error instanceof SettingsError ? error.status : 400;
      http.body = { message: error instanceof SettingsError ? error.message : "模型设置请求无效。" };
    }
  });
  const probes = new Map<string, number[]>();
  ctx.server.post("/yesimbot/model-settings/probe", async (http) => {
    if (!auth.requireOwner(http)) return;
    if (!auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { message: "Same-origin request required." };
      return;
    }
    http.set("Cache-Control", "no-store");
    // Each probe makes an outbound request; bound it per session.
    const session = auth.sessionFromCookie(http.get("cookie"))?.username ?? "";
    const now = ctx.clock.now(),
      recent = (probes.get(session) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= PROBES_PER_MINUTE) {
      http.body = { ok: false, models: [], error: "rate_limited" } satisfies ModelProbeResult;
      return;
    }
    probes.set(session, [...recent, now]);
    let request: ModelProbeRequest | undefined;
    try {
      request = probeRequest(await readModelSettingsBody(http));
    } catch {
      request = undefined;
    }
    if (!request) {
      http.body = { ok: false, models: [], error: "invalid_request" } satisfies ModelProbeResult;
      return;
    }
    const apiKey = request.apiKey ?? store.probeKey(request.key, request.type, request.baseURL);
    http.body = apiKey
      ? await probeModels({ type: request.type, baseURL: request.baseURL, apiKey }, options.fetcher)
      : ({ ok: false, models: [], error: "missing_key" } satisfies ModelProbeResult);
  });
  const activeCapabilityProbes = new Set<string>();
  ctx.server.post("/yesimbot/model-settings/capability-probe", async (http) => {
    if (!auth.requireOwner(http)) return;
    if (!auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { ok: false, checks: [], error: "forbidden" } satisfies ModelCapabilityProbeResult;
      return;
    }
    http.set("Cache-Control", "no-store");
    const session = auth.sessionFromCookie(http.get("cookie"))?.username ?? "";
    const now = ctx.clock.now(),
      recent = (probes.get(session) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= PROBES_PER_MINUTE || activeCapabilityProbes.has(session)) {
      http.body = { ok: false, checks: [], error: "rate_limited" } satisfies ModelCapabilityProbeResult;
      return;
    }
    let request;
    try {
      request = capabilityProbeRequest(await readModelSettingsBody(http));
    } catch {
      /* invalid body */
    }
    if (!request) {
      http.body = { ok: false, checks: [], error: "invalid_request" } satisfies ModelCapabilityProbeResult;
      return;
    }
    const fullId = store.capabilityModel(request.key, request.model);
    let ref;
    try {
      ref = fullId ? ctx.yesimbot.model.resolveChatModel(fullId) : undefined;
    } catch {
      /* fixed public error below */
    }
    if (!ref) {
      http.body = { ok: false, checks: [], error: "not_registered" } satisfies ModelCapabilityProbeResult;
      return;
    }
    probes.set(session, [...recent, now]);
    activeCapabilityProbes.add(session);
    try {
      http.body = await probeModelCapabilities(ref.model, request.capabilities, `model-capability-probe:${session}`, ctx.clock);
    } finally {
      activeCapabilityProbes.delete(session);
    }
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const name = (entry: Entry) => entry.key.replace(/^~/, "").split(":", 1)[0];

function hasSemanticMetadata(value: ObjectValue): boolean {
  return Object.keys(value).some((key) => key.startsWith("$") && key !== "$description" && key !== "$label");
}

function entries(plugins: ObjectValue, parent = "", scoped = false): Entry[] {
  const result: Entry[] = [];
  for (const [key, value] of Object.entries(plugins)) {
    if (key.startsWith("$") || !object(value)) continue;
    const disabled = scoped || key.startsWith("~") || hasSemanticMetadata(value);
    const entry = { parent, key, value, scoped: disabled };
    if (name(entry) === "group") result.push(...entries(value, [parent, key].filter(Boolean).join("/"), disabled));
    else result.push(entry);
  }
  return result;
}

function sourceConnections(entry?: Entry): ObjectValue[] {
  if (!entry) return [];
  return Array.isArray(entry.value.connections) ? entry.value.connections.filter(object) : [];
}

function safeURL(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function publicModel(value: ObjectValue): ModelSettingsModel {
  const result: ModelSettingsModel = { id: text(value.id) };
  if (typeof value.toolCall === "boolean") result.toolCall = value.toolCall;
  if (typeof value.reasoning === "boolean") result.reasoning = value.reasoning;
  if (levels.includes(text(value.thinkingLevel))) result.thinkingLevel = value.thinkingLevel as ModelSettingsModel["thinkingLevel"];
  if (object(value.thinkingLevelMap)) {
    result.thinkingLevelMap = {};
    for (const level of levels) {
      const mapped = value.thinkingLevelMap[level];
      if (mapped === null || nativeLevels.includes(text(mapped)))
        result.thinkingLevelMap[level as keyof NonNullable<ModelSettingsModel["thinkingLevelMap"]>] = mapped as string | null;
    }
  }
  return result;
}

function publicImageModel(value: ObjectValue): ModelSettingsImageModel {
  const result: ModelSettingsImageModel = { id: text(value.id) };
  if (typeof value.name === "string") result.name = value.name;
  if (typeof value.hidden === "boolean") result.hidden = value.hidden;
  return result;
}

function publicOptions(value: ObjectValue): ModelSettingsOptions {
  const result: ModelSettingsOptions = {};
  if (["chat", "responses"].includes(text(value.format))) result.format = value.format as "chat" | "responses";
  if (typeof value.webSearch === "boolean") result.webSearch = value.webSearch;
  if (["auto", "none", "low", "medium", "high", "xhigh", "max"].includes(text(value.thinking)))
    result.thinking = value.thinking as ModelSettingsOptions["thinking"];
  if (["native", "unsupported", "unknown"].includes(text(value.imageToolResultSupport)))
    result.imageToolResultSupport = value.imageToolResultSupport as ModelSettingsOptions["imageToolResultSupport"];
  if (["tool-output", "user-message"].includes(text(value.imageToolResultPlacement)))
    result.imageToolResultPlacement = value.imageToolResultPlacement as ModelSettingsOptions["imageToolResultPlacement"];
  if (Array.isArray(value.imageToolResultMediaTypes))
    result.imageToolResultMediaTypes = value.imageToolResultMediaTypes.filter((item): item is string =>
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(text(item)),
    );
  return result;
}

function project(value: ObjectValue, index: number): ModelSettingsConnection {
  return {
    key: `connection:${index}`,
    enabled: value.enabled !== false,
    type: text(value.type) || "openai",
    id: text(value.id),
    baseURL: safeURL(value.baseURL),
    hasApiKey: typeof value.apiKey === "string" && !!value.apiKey,
    chatModels: Array.isArray(value.chatModels)
      ? value.chatModels.filter(object).map((model, modelIndex) => ({ ...publicModel(model), key: `model:connection:${index}:chatModels:${modelIndex}` }))
      : [],
    embeddingModels: Array.isArray(value.embeddingModels)
      ? value.embeddingModels
          .filter(object)
          .map((model, modelIndex) => ({ ...publicModel(model), key: `model:connection:${index}:embeddingModels:${modelIndex}` }))
      : [],
    imageModels: Array.isArray(value.imageModels)
      ? value.imageModels
          .filter(object)
          .map((model, modelIndex) => ({ ...publicImageModel(model), key: `model:connection:${index}:imageModels:${modelIndex}` }))
      : [],
    options: publicOptions(value),
  };
}

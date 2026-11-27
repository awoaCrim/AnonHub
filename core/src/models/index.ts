import { join, resolve } from "node:path";

import type { EmbeddingModelV3, LanguageModelV3 } from "@ai-sdk/provider";
import { currentModelRequestContext, modelRequestContextMiddleware, reportModelUsageDiagnostic } from "@yesimbot/agent-runtime";
import { AppError, logger, systemClock, type Clock } from "@yesimbot/foundation";
import { wrapEmbeddingModel, wrapLanguageModel } from "ai";
import type { EmbeddingModel, EmbeddingModelMiddleware, LanguageModel, LanguageModelMiddleware, ToolSet } from "ai";

import { deriveChannelKey } from "../channels/context.js";
import type { ChannelContext } from "../channels/index.js";
import type { ChatModelConfig, ChatModelModality, EmbeddingModelConfig, ModelServiceConfig } from "./config.js";
import { createEmptyModelsConfig, loadModelsConfig } from "./config.js";
import { MODEL_ERRORS } from "./errors.js";
import type { ImageModelAdapter, ImageModelConfig, ImageModelRef } from "./images.js";

const log = logger("yesimbot.model");

export type ModelId = `${string}:${string}`;

export type ModelUsageEvent =
  | {
      readonly context?: ChannelContext;
      readonly modelId: ModelId;
      readonly providerId: string;
      readonly providerModelId: string;
      readonly kind: "chat";
      readonly usage: unknown;
      readonly timestamp: number;
    }
  | {
      readonly context?: ChannelContext;
      readonly modelId: ModelId;
      readonly providerId: string;
      readonly providerModelId: string;
      readonly kind: "embedding";
      readonly usage: { readonly inputTokens: number; readonly outputTokens: 0 };
      readonly timestamp: number;
    };

export type AuxiliaryPurpose = "memory-summary" | "history-summary" | "notification" | "utility";

export type ImageToolResultSupport = "native" | "unsupported" | "unknown";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Native user-video transport; absent or invalid declarations fail closed. */
export type VideoInputSupport = "native" | "unsupported" | "unknown";

export type HistoryProjectionMode = "default" | "gemini-native";

export type InputModalitiesSource = "metadata" | "selection" | "unknown";

export interface ChatModelCapabilities {
  readonly imageToolResult: ImageToolResultSupport;
  /** Optional route-specific allowlist for native image tool-result media. */
  readonly imageToolResultMediaTypes?: readonly ImageMediaType[];
  readonly videoInput?: VideoInputSupport;
  readonly historyProjection?: HistoryProjectionMode;
}

export interface ChatModelRef {
  fullId: ModelId;
  providerId: string;
  modelId: string;
  entry: ChatModelConfig;
  /** Role-derived inputs do not exclude other modalities whose metadata remains unknown. */
  readonly inputModalitiesSource: InputModalitiesSource;
  model: LanguageModel;
  capabilities: ChatModelCapabilities;
  tools?: ToolSet;
}

export interface AuxiliaryModelRef extends ChatModelRef {
  readonly route: "auxiliary";
  readonly purpose: AuxiliaryPurpose;
  readonly source: "config.auxiliaryModel";
}

/** What the registry tells extensions: each model call's usage, and that the set of models changed. */
export interface ModelEvents {
  "yesimbot/model-usage"(event: ModelUsageEvent): void;
  "yesimbot/model-registry-changed"(revision: number): void;
}

/** Where models.json lives (relative `basePath` resolves against `baseDir`) and where events go. */
export interface ModelServiceHost {
  readonly baseDir: string;
  /** Usage timestamps; the system clock when absent. */
  readonly clock?: Clock;
  emit<K extends keyof ModelEvents>(name: K, ...args: Parameters<ModelEvents[K]>): void;
}

interface Provider {
  readonly id: string;
  readonly capabilities: { chat: boolean; embedding: boolean; image?: boolean };
  chatModels(): ChatModelConfig[];
  embeddingModels(): EmbeddingModelConfig[];
  imageModels?(): ImageModelConfig[];
  chat?(modelId: string, config?: ChatModelConfig): LanguageModel;
  embedding?(modelId: string): EmbeddingModel;
  image?(modelId: string): ImageModelAdapter;
  chatCapabilities?(modelId: string): Partial<ChatModelCapabilities> | undefined;
  tools?(modelId: string): ToolSet;
}

interface ChatModelRecord {
  fullId: ModelId;
  providerId: string;
  modelId: string;
  config: ChatModelConfig;
  inputModalitiesSource: InputModalitiesSource;
}

interface EmbeddingModelRecord {
  fullId: ModelId;
  providerId: string;
  modelId: string;
  config: EmbeddingModelConfig;
}

interface ImageModelRecord {
  fullId: ModelId;
  providerId: string;
  modelId: string;
  config: ImageModelConfig;
}

/** A model setting the registry could not apply: an override, alias or default naming no registered model. */
interface IgnoredConfigEntry {
  readonly entry: string;
  readonly reason: string;
  readonly fullId?: string;
  readonly alias?: string;
  readonly target?: string;
}

export class ModelService {
  private readonly host: ModelServiceHost;
  private readonly config: ModelServiceConfig;
  private readonly clock: Clock;

  private providers = new Map<string, Provider>();
  private chatModels = new Map<string, ChatModelRecord>();
  private embeddingModels = new Map<string, EmbeddingModelRecord>();
  private reportedIgnored = new Set<string>();
  private imageModels = new Map<string, ImageModelRecord>();
  private aliases = new Map<string, ModelId>();
  private modelsConfig = createEmptyModelsConfig();
  private defaults: { chat?: ModelId; embedding?: ModelId } = {};
  private readonly refreshListeners = new Set<() => void>();
  private readonly middlewares = new Set<LanguageModelMiddleware>();
  private revisionValue = 0;

  constructor(host: ModelServiceHost, config: ModelServiceConfig) {
    this.host = host;
    this.config = config;
    this.clock = host.clock ?? systemClock();
  }

  public get revision(): number {
    return this.revisionValue;
  }

  public register(provider: Provider): () => void {
    const existing = this.providers.get(provider.id);
    if (existing && existing !== provider) {
      throw new AppError(MODEL_ERRORS.model_provider_duplicate, { effect: "none", detail: provider.id });
    }
    this.providers.set(provider.id, provider);
    this.refreshModels();
    log.info("model.provider_registered", { provider: provider.id });

    return () => {
      if (this.providers.get(provider.id) !== provider) {
        return;
      }
      this.providers.delete(provider.id);
      this.refreshModels();
      log.info("model.provider_unregistered", { provider: provider.id });
    };
  }

  public async stop(): Promise<void> {
    this.refreshListeners.clear();
  }

  /** Called after every rebuild of the model lists (a provider came or went, or models.json was loaded). */
  public onModelsRefreshed(listener: () => void): () => void {
    this.refreshListeners.add(listener);
    return () => {
      this.refreshListeners.delete(listener);
    };
  }

  public middleware(middleware: LanguageModelMiddleware): () => void {
    this.middlewares.add(middleware);
    this.bumpRevision();
    return () => {
      if (this.middlewares.delete(middleware)) this.bumpRevision();
    };
  }

  public resolveChatModel(fullId: string, context?: ChannelContext, options?: Readonly<Pick<ChatModelConfig, "thinkingLevel">>): ChatModelRef {
    const record = this.getChatRecord(fullId);
    const provider = this.providers.get(record.providerId);
    if (!provider) {
      throw new AppError(MODEL_ERRORS.model_provider_not_found, { effect: "none", detail: record.providerId });
    }

    log.debug("model.resolve_chat", {
      input: fullId,
      fullId: record.fullId,
      provider: record.providerId,
      model: record.modelId,
      modalities: record.config.modalities,
      inputModalitiesSource: record.inputModalitiesSource,
    });
    const entry = cloneChatModelConfig(record.config);
    if (options?.thinkingLevel !== undefined) entry.thinkingLevel = options.thinkingLevel;
    // A per-resolution override must not mutate the registry or another use of the same model.
    const source = provider.chat!(record.modelId, cloneChatModelConfig(entry));
    const model = isModelObject(source)
      ? [...this.middlewares].reduce(
          (current, middleware) => wrapLanguageModel({ model: current, middleware, providerId: record.providerId, modelId: record.modelId }),
          wrapLanguageModel({
            model: source as LanguageModelV3,
            middleware: [
              modelRequestContextMiddleware(context ? { sessionId: deriveChannelKey(context) } : {}),
              createLanguageUsageMiddleware((usage) => {
                this.host.emit("yesimbot/model-usage", {
                  context,
                  modelId: record.fullId,
                  providerId: record.providerId,
                  providerModelId: record.modelId,
                  kind: "chat",
                  usage,
                  timestamp: this.clock.now(),
                });
              }),
            ],
            providerId: record.providerId,
            modelId: record.modelId,
          }),
        )
      : source;
    const tools = provider.tools?.(record.modelId);
    const declaredCapabilities = provider.chatCapabilities?.(record.modelId);
    const imageToolResultMediaTypes = normalizeImageToolResultMediaTypes(declaredCapabilities?.imageToolResultMediaTypes);
    const capabilities: ChatModelCapabilities = {
      imageToolResult:
        declaredCapabilities?.imageToolResult === "native" || declaredCapabilities?.imageToolResult === "unsupported"
          ? declaredCapabilities.imageToolResult
          : "unknown",
      ...(imageToolResultMediaTypes === undefined ? {} : { imageToolResultMediaTypes }),
      videoInput:
        declaredCapabilities?.videoInput === "native" || declaredCapabilities?.videoInput === "unsupported" ? declaredCapabilities.videoInput : "unknown",
      historyProjection: declaredCapabilities?.historyProjection === "gemini-native" ? "gemini-native" : "default",
    };
    return {
      fullId: record.fullId,
      providerId: record.providerId,
      modelId: record.modelId,
      entry,
      inputModalitiesSource: record.inputModalitiesSource,
      model,
      capabilities,
      tools: tools && { ...tools },
    };
  }

  /** Limits for the actual registry-wrapped model, including a plugin-selected model. */
  public contextLimit(model: LanguageModel): ChatModelConfig["limit"] {
    const id = typeof model === "string" ? model : formatModelId(model.provider, model.modelId);
    const limit = this.chatModels.get(id)?.config.limit;
    return limit ? { ...limit } : undefined;
  }

  public resolveAuxiliaryModel(purpose: AuxiliaryPurpose, context?: ChannelContext): AuxiliaryModelRef {
    const source = "config.auxiliaryModel" as const;
    const configured = this.config.auxiliaryModel;
    if (typeof configured !== "string" || configured.trim().length === 0) throw auxiliaryFailure(MODEL_ERRORS.model_auxiliary_missing, purpose);

    const fullId = configured.trim();
    const parsed = parseModelId(fullId);
    if (!parsed || parsed.model.trim().length === 0) throw auxiliaryFailure(MODEL_ERRORS.model_auxiliary_invalid, purpose, fullId);

    if (!this.providers.has(parsed.provider)) throw auxiliaryFailure(MODEL_ERRORS.model_auxiliary_provider_unavailable, purpose, fullId);

    let resolved: ChatModelRef;
    try {
      resolved = this.resolveChatModel(fullId, context);
    } catch (cause) {
      throw auxiliaryFailure(MODEL_ERRORS.model_auxiliary_unresolvable, purpose, fullId, cause);
    }

    log.debug("model.resolve_auxiliary", {
      route: "auxiliary",
      purpose,
      source,
      fullId: resolved.fullId,
      provider: resolved.providerId,
      model: resolved.modelId,
    });
    return { ...resolved, route: "auxiliary", purpose, source };
  }

  public resolveEmbedding(fullId: string, context?: ChannelContext): EmbeddingModel {
    const record = this.getEmbeddingRecord(fullId);
    const provider = this.providers.get(record.providerId);
    if (!provider) throw new AppError(MODEL_ERRORS.model_provider_not_found, { effect: "none", detail: record.providerId });
    log.debug("model.resolve_embedding", { input: fullId, fullId: record.fullId, provider: record.providerId, model: record.modelId });
    const source = provider.embedding!(record.modelId);
    return isModelObject(source)
      ? wrapEmbeddingModel({
          model: source as EmbeddingModelV3,
          middleware: createEmbeddingUsageMiddleware((usage) => {
            this.host.emit("yesimbot/model-usage", {
              context,
              modelId: record.fullId,
              providerId: record.providerId,
              providerModelId: record.modelId,
              kind: "embedding",
              usage,
              timestamp: this.clock.now(),
            });
          }),
          providerId: record.providerId,
          modelId: record.modelId,
        })
      : source;
  }

  public getProvider(id: string) {
    return this.providers.get(id);
  }

  /** Only explicitly registered Images models can be selected; never resolve through chat. */
  public resolveImage(fullId: string): ImageModelRef {
    const record = this.imageModels.get(fullId);
    if (!record) throw new AppError(MODEL_ERRORS.model_not_found, { effect: "none", detail: fullId });
    const provider = this.providers.get(record.providerId);
    if (!provider?.capabilities.image || !provider.image)
      throw new AppError(MODEL_ERRORS.model_capability_unsupported, { effect: "none", detail: `${record.providerId} images` });
    return {
      fullId: record.fullId,
      providerId: record.providerId,
      modelId: record.modelId,
      entry: { ...record.config },
      ...provider.image(record.modelId),
    };
  }

  public listProviders() {
    return [...this.providers.keys()];
  }

  public getDefaultChatModelId(): ModelId | undefined {
    return this.defaults.chat;
  }

  public getDefaultEmbeddingModelId(): ModelId | undefined {
    return this.defaults.embedding;
  }

  public listChatModels(): Array<{ fullId: string; config: ChatModelConfig }> {
    return [...this.chatModels.values()].map((record) => ({ fullId: record.fullId, config: cloneChatModelConfig(record.config) }));
  }

  public listEmbeddingModels(): Array<{ fullId: string; config: EmbeddingModelConfig }> {
    return [...this.embeddingModels.values()].map((record) => ({ fullId: record.fullId, config: cloneEmbeddingModelConfig(record.config) }));
  }

  public listImageModels(): Array<{ fullId: string; config: ImageModelConfig }> {
    return [...this.imageModels.values()].map((record) => ({ fullId: record.fullId, config: { ...record.config } }));
  }

  private getModelsConfigPath(): string {
    return join(resolve(this.host.baseDir, this.config.basePath || this.host.baseDir), "models.json");
  }

  /** Loads models.json; the host calls it once it is ready. */
  public async start(): Promise<void> {
    const { config: modelsConfig, warnings } = await loadModelsConfig(this.getModelsConfigPath());
    this.modelsConfig = modelsConfig;
    for (const warning of warnings) {
      log.warn("model.config_warning", { warning });
    }
    this.refreshModels();
  }

  private bumpRevision(): void {
    this.revisionValue += 1;
    this.host.emit("yesimbot/model-registry-changed", this.revisionValue);
  }

  private refreshModels(): void {
    this.bumpRevision();
    this.chatModels.clear();
    this.embeddingModels.clear();
    this.imageModels.clear();
    this.aliases.clear();
    this.defaults = {};

    for (const provider of this.providers.values()) {
      if (provider.capabilities.chat) {
        for (const config of provider.chatModels()) {
          const fullId = formatModelId(provider.id, config.id);
          const cloned = cloneChatModelConfig(config);
          // Do not infer model inputs from the protocol/provider. Explicit metadata and the
          // operator's image-understanding role are applied below.
          cloned.modalities = undefined;
          this.chatModels.set(fullId, { fullId, providerId: provider.id, modelId: config.id, config: cloned, inputModalitiesSource: "unknown" });
        }
      }

      if (provider.capabilities.embedding) {
        for (const config of provider.embeddingModels()) {
          const fullId = formatModelId(provider.id, config.id);
          this.embeddingModels.set(fullId, { fullId, providerId: provider.id, modelId: config.id, config: cloneEmbeddingModelConfig(config) });
        }
      }

      if (provider.capabilities.image && provider.image) {
        for (const config of provider.imageModels?.() ?? []) {
          const fullId = formatModelId(provider.id, config.id);
          this.imageModels.set(fullId, { fullId, providerId: provider.id, modelId: config.id, config: { ...config } });
        }
      }
    }

    const modelsConfig = this.modelsConfig;
    const ignored: IgnoredConfigEntry[] = [];

    for (const [fullId, override] of Object.entries(modelsConfig.chat)) {
      const record = this.chatModels.get(fullId);
      if (!record) {
        ignored.push({ entry: "chat override", fullId, reason: "unknown model" });
        continue;
      }
      record.config = {
        ...record.config,
        name: override.name ?? record.config.name,
        toolCall: override.toolCall ?? record.config.toolCall,
        reasoning: override.reasoning ?? record.config.reasoning,
        thinkingLevel: override.thinkingLevel ?? record.config.thinkingLevel,
        thinkingLevelMap: override.thinkingLevelMap
          ? { ...(record.config.thinkingLevelMap ?? {}), ...override.thinkingLevelMap }
          : record.config.thinkingLevelMap,
        hidden: override.hidden ?? record.config.hidden,
        modalities: override.modalities
          ? {
              ...(override.modalities.input ? { input: [...override.modalities.input] } : {}),
              ...(override.modalities.output ? { output: [...override.modalities.output] } : {}),
            }
          : record.config.modalities,
        limit: override.limit ?? record.config.limit,
      };
      if (override.modalities?.input !== undefined) record.inputModalitiesSource = "metadata";
    }

    for (const [fullId, override] of Object.entries(modelsConfig.embedding)) {
      const record = this.embeddingModels.get(fullId);
      if (!record) {
        ignored.push({ entry: "embedding override", fullId, reason: "unknown model" });
        continue;
      }
      record.config = { ...record.config, name: override.name ?? record.config.name, hidden: override.hidden ?? record.config.hidden };
    }

    for (const [alias, target] of Object.entries(modelsConfig.aliases)) {
      if (this.chatModels.has(alias) || this.embeddingModels.has(alias)) {
        ignored.push({ entry: "alias", alias, reason: "conflicts with a full model id" });
        continue;
      }
      const parsedTarget = parseModelId(target);
      if (!parsedTarget) {
        ignored.push({ entry: "alias", alias, target, reason: "target is not a valid model id" });
        continue;
      }
      const targetId = formatModelId(parsedTarget.provider, parsedTarget.model);
      if (!this.chatModels.has(targetId) && !this.embeddingModels.has(targetId)) {
        ignored.push({ entry: "alias", alias, target, reason: "target is not registered" });
        continue;
      }
      this.aliases.set(alias, targetId);
    }

    // These explicit operator choices must work in fresh instances without models.json.
    // The default-on imageInput switch alone does not declare model capability. Explicit
    // input metadata (including text-only/empty arrays) and transport gates remain authoritative.
    const selectedInputs: [string | undefined, "image" | "video"][] = [
      [this.config.visionModel, "image"],
      [this.config.videoInput === true ? this.config.chatModel : undefined, "video"],
    ];
    const inferredInputs = new Map<ChatModelRecord, ChatModelModality[]>();
    for (const [selectedId, input] of selectedInputs) {
      const id = selectedId?.trim();
      const record = id ? this.chatModels.get(this.resolveInput(id)) : undefined;
      if (!record || record.config.modalities?.input !== undefined) continue;
      const inputs = inferredInputs.get(record) ?? ["text"];
      inputs.push(input);
      inferredInputs.set(record, inputs);
    }
    for (const [record, input] of inferredInputs) {
      record.config.modalities = { ...record.config.modalities, input };
      record.inputModalitiesSource = "selection";
    }

    if (modelsConfig.defaults.chat) {
      if (this.chatModels.has(modelsConfig.defaults.chat)) {
        this.defaults.chat = modelsConfig.defaults.chat as ModelId;
      } else {
        ignored.push({ entry: "chat default", fullId: modelsConfig.defaults.chat, reason: "not a registered chat model" });
      }
    }

    if (modelsConfig.defaults.embedding) {
      if (this.embeddingModels.has(modelsConfig.defaults.embedding)) {
        this.defaults.embedding = modelsConfig.defaults.embedding as ModelId;
      } else {
        ignored.push({ entry: "embedding default", fullId: modelsConfig.defaults.embedding, reason: "not a registered embedding model" });
      }
    }

    this.reportIgnored(ignored);
    for (const listener of this.refreshListeners) listener();
  }

  /**
   * Warns once per ignored entry. An entry naming a provider that has not registered is not a mistake yet: providers
   * register one after another at startup, and each one rebuilds the lists. It warns again only after it was fixed and
   * broke anew.
   */
  private reportIgnored(entries: readonly IgnoredConfigEntry[]): void {
    const current = new Set<string>();
    for (const entry of entries) {
      const provider = parseModelId(entry.fullId ?? entry.target ?? "")?.provider;
      if (provider !== undefined && !this.providers.has(provider)) {
        log.debug("model.config_pending", { ...entry });
        continue;
      }
      const key = JSON.stringify(entry);
      current.add(key);
      if (!this.reportedIgnored.has(key)) log.warn("model.config_ignored", { ...entry });
    }
    this.reportedIgnored = current;
  }

  private resolveInput(input: string): string {
    return this.aliases.get(input) ?? input;
  }

  private getChatRecord(fullId: string): ChatModelRecord {
    fullId = this.resolveInput(fullId);
    const parsed = parseModelId(fullId);
    if (!parsed) throw new AppError(MODEL_ERRORS.model_id_invalid, { effect: "none", detail: fullId });

    const provider = this.providers.get(parsed.provider);
    if (!provider) {
      throw new AppError(MODEL_ERRORS.model_provider_not_found, {
        effect: "none",
        detail: `${parsed.provider}; available: ${this.listProviders().join(", ")}`,
      });
    }

    if (!provider.capabilities.chat) {
      throw new AppError(MODEL_ERRORS.model_capability_unsupported, { effect: "none", detail: `${parsed.provider} chat` });
    }

    const record = this.chatModels.get(fullId);
    if (record) return record;

    const available = [...this.chatModels.values()]
      .filter((item) => item.providerId === parsed.provider)
      .map((item) => item.modelId)
      .join(", ");
    throw new AppError(MODEL_ERRORS.model_not_found, { effect: "none", detail: `${fullId}; available: ${available}` });
  }

  private getEmbeddingRecord(fullId: string): EmbeddingModelRecord {
    fullId = this.resolveInput(fullId);
    const parsed = parseModelId(fullId);
    if (!parsed) throw new AppError(MODEL_ERRORS.model_id_invalid, { effect: "none", detail: fullId });

    const provider = this.providers.get(parsed.provider);
    if (!provider) throw new AppError(MODEL_ERRORS.model_provider_not_found, { effect: "none", detail: parsed.provider });

    if (!provider.capabilities.embedding) {
      throw new AppError(MODEL_ERRORS.model_capability_unsupported, { effect: "none", detail: `${parsed.provider} embedding` });
    }

    const record = this.embeddingModels.get(fullId);
    if (record) return record;

    const available = [...this.embeddingModels.values()]
      .filter((item) => item.providerId === parsed.provider)
      .map((item) => item.modelId)
      .join(", ");
    throw new AppError(MODEL_ERRORS.model_not_found, { effect: "none", detail: `${fullId}; available: ${available}` });
  }
}

function parseModelId(fullId: string): { provider: string; model: string } | null {
  const idx = fullId.indexOf(":");
  return idx <= 0 ? null : { provider: fullId.slice(0, idx), model: fullId.slice(idx + 1) };
}

function formatModelId(providerId: string, modelId: string): ModelId {
  return `${providerId}:${modelId}`;
}

function createLanguageUsageMiddleware(report: (usage: unknown) => void): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      reportModelUsageDiagnostic(result.usage);
      report(result.usage);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const requestContext = currentModelRequestContext();
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (chunk.type === "finish") {
                report(chunk.usage);
                reportModelUsageDiagnostic(chunk.usage, requestContext);
              }
              controller.enqueue(chunk);
            },
          }),
        ),
      };
    },
  };
}

function createEmbeddingUsageMiddleware(report: (usage: { inputTokens: number; outputTokens: 0 }) => void): EmbeddingModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapEmbed: async ({ doEmbed }) => {
      const result = await doEmbed();
      const rawUsage: unknown = result;
      const usage = rawUsage && typeof rawUsage === "object" && "usage" in rawUsage ? rawUsage.usage : undefined;
      const tokens = usage && typeof usage === "object" && "tokens" in usage ? usage.tokens : undefined;
      report({ inputTokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0, outputTokens: 0 });
      return result;
    },
  };
}

function isModelObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeImageToolResultMediaTypes(value: readonly ImageMediaType[] | undefined): readonly ImageMediaType[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isImageMediaType))];
}

function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp";
}

function cloneChatModelConfig(config: ChatModelConfig): ChatModelConfig {
  return {
    ...config,
    thinkingLevelMap: config.thinkingLevelMap ? { ...config.thinkingLevelMap } : undefined,
    limit: config.limit ? { ...config.limit } : undefined,
    modalities: config.modalities
      ? {
          ...(config.modalities.input ? { input: [...config.modalities.input] } : {}),
          ...(config.modalities.output ? { output: [...config.modalities.output] } : {}),
        }
      : undefined,
  };
}

function cloneEmbeddingModelConfig(config: EmbeddingModelConfig): EmbeddingModelConfig {
  return { ...config };
}

/** The auxiliary model cannot serve `purpose`; logged here once, thrown to the caller. Nothing falls back to the chat model. */
function auxiliaryFailure(code: string, purpose: AuxiliaryPurpose, model?: string, cause?: unknown): AppError {
  log.warn("model.auxiliary_unavailable", { route: "auxiliary", purpose, source: "config.auxiliaryModel", code, ...(model ? { model } : {}) });
  return new AppError(code, { effect: "none", detail: `${purpose}${model ? ` ${model}` : ""}`, ...(cause === undefined ? {} : { cause }) });
}

export type { BaseProviderConfig, CHAT_MODEL_MODALITIES, ChatModelConfig, ChatModelModality, EmbeddingModelConfig, ModelServiceConfig } from "./config.js";

export { createEmptyModelsConfig, isChatModelModality, loadModelsConfig, mutateModelsConfig } from "./config.js";

export type { ResolvedThinkingLevel, ThinkingLevel, ThinkingLevelMap, ThinkingLevelSupport } from "./thinking.js";

export { getSupportedThinkingLevels, resolveThinkingLevel, THINKING_LEVELS } from "./thinking.js";

export type { ImageModelConfig, ImageModelAdapter, ImageModelRef, ImageEditor, ImageEditRequest, ImageEditResponse } from "./images.js";

export { imageTransportError, imageTransportFailure, MODEL_ERRORS, type ImageTransportCode, type ImageTransportFailure } from "./errors.js";

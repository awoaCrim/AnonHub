import { createDeepSeek, type DeepSeekLanguageModelOptions } from "@ai-sdk/deepseek";
import { AppError, logger, modelFetch } from "@yesimbot/foundation";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { type BaseProviderConfig, type ChatModelConfig, resolveThinkingLevel, type ThinkingLevel, type ThinkingLevelMap } from "koishi-plugin-yesimbot/kernel";

import { MODEL_PROVIDER_ERRORS } from "./errors.js";
import type { ModelProvider } from "./provider.js";
import { reasoningRoute, withReasoningOrigin } from "./reasoning-origin.js";
import { modelTransport, diagnosticObserver } from "./transport.js";

const DEEPSEEK_LEGACY_THINKING_LEVELS = ["auto", "none", "low", "medium", "high", "xhigh", "max"] as const;

const DEEPSEEK_DEFAULT_THINKING_LEVELS: ThinkingLevelMap = { off: "off", low: "low", medium: "medium", high: "high" };

const log = logger("yesimbot.provider");

type DeepSeekLegacyThinkingLevel = (typeof DEEPSEEK_LEGACY_THINKING_LEVELS)[number];

type DeepSeekReasoningEffort = NonNullable<DeepSeekLanguageModelOptions["reasoningEffort"]>;

export interface Config extends BaseProviderConfig {
  thinking: DeepSeekLegacyThinkingLevel;
}

interface DeepSeekThinkingResolution {
  readonly actualId: string;
  readonly clamped: boolean;
  readonly level: ThinkingLevel | undefined;
  readonly options: DeepSeekLanguageModelOptions;
  readonly requested: ThinkingLevel | undefined;
}

export function resolveDeepSeekThinking(modelId: string, entry: ChatModelConfig, globalThinking: DeepSeekLegacyThinkingLevel): DeepSeekThinkingResolution {
  const colonIndex = modelId.lastIndexOf(":");
  if (colonIndex > 0) {
    const suffix = modelId.slice(colonIndex + 1);
    if (isDeepSeekLegacyThinkingLevel(suffix)) {
      return { actualId: modelId.slice(0, colonIndex), clamped: false, level: undefined, options: deepSeekLegacyOptions(suffix), requested: undefined };
    }
  }

  if (entry.thinkingLevel !== undefined) {
    const resolved = resolveThinkingLevel(
      {
        defaultMap: DEEPSEEK_DEFAULT_THINKING_LEVELS,
        isNativeValue: isDeepSeekReasoningEffort,
        reasoning: entry.reasoning,
        thinkingLevelMap: entry.thinkingLevelMap,
      },
      entry.thinkingLevel,
    );
    const options = resolved.level === "off" ? { thinking: { type: "disabled" as const } } : deepSeekEnabledOptions(resolved.native);
    if (options) {
      return { actualId: modelId, clamped: resolved.clamped, level: resolved.level, options, requested: entry.thinkingLevel };
    }
  }

  return { actualId: modelId, clamped: false, level: undefined, options: deepSeekLegacyOptions(globalThinking), requested: undefined };
}

/** The DeepSeek connection as Core registers it; a model it cannot map logs once per model. */
export function createDeepSeekProvider(config: Config): ModelProvider {
  const client = createDeepSeek({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    fetch: modelTransport(modelFetch, config.id, diagnosticObserver(config.id)),
  });
  const warned = new Set<string>();
  return {
    id: config.id,
    capabilities: { chat: true, embedding: false },
    chatModels: () => config.chatModels,
    embeddingModels: () => [],
    chat: (modelId: string, modelConfig?: ChatModelConfig) => {
      const entry = modelConfig ?? config.chatModels.find((item) => item.id === modelId) ?? { id: modelId };
      const resolution = resolveDeepSeekThinking(modelId, entry, config.thinking);

      if (resolution.clamped && resolution.requested !== undefined && !warned.has(modelId)) {
        warned.add(modelId);
        log.warn("provider.thinking_level_clamped", {
          protocol: "deepseek",
          provider: config.id,
          model: modelId,
          requested: resolution.requested,
          level: resolution.level,
        });
      }

      return wrapLanguageModel({
        model: withReasoningOrigin(client.chat(resolution.actualId), config.id, "deepseek", reasoningRoute(config)),
        middleware: [defaultSettingsMiddleware({ settings: { providerOptions: { deepseek: resolution.options } } })],
      });
    },
    embedding: () => {
      throw new AppError(MODEL_PROVIDER_ERRORS.model_provider_embedding_unsupported, { effect: "none", detail: config.id });
    },
  };
}

function deepSeekEnabledOptions(native: string | undefined): DeepSeekLanguageModelOptions | undefined {
  return isDeepSeekReasoningEffort(native) ? { thinking: { type: "enabled" }, reasoningEffort: native } : undefined;
}

function deepSeekLegacyOptions(level: DeepSeekLegacyThinkingLevel): DeepSeekLanguageModelOptions {
  if (level === "none") return { thinking: { type: "disabled" } };
  if (level === "auto") return { thinking: { type: "adaptive" } };
  return { thinking: { type: "enabled" }, reasoningEffort: level };
}

function isDeepSeekLegacyThinkingLevel(value: string): value is DeepSeekLegacyThinkingLevel {
  return DEEPSEEK_LEGACY_THINKING_LEVELS.some((level) => level === value);
}

function isDeepSeekReasoningEffort(value: string | undefined): value is DeepSeekReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

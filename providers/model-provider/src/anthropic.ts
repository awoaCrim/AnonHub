import { createAnthropic } from "@ai-sdk/anthropic";
import { AppError, logger, modelFetch } from "@yesimbot/foundation";
import { defaultSettingsMiddleware, wrapLanguageModel, type ToolSet } from "ai";
import { type BaseProviderConfig, type ChatModelConfig, resolveThinkingLevel, type ThinkingLevel, type ThinkingLevelMap } from "koishi-plugin-yesimbot/kernel";

import { MODEL_PROVIDER_ERRORS } from "./errors.js";
import type { ModelProvider } from "./provider.js";
import { reasoningRoute, withReasoningOrigin } from "./reasoning-origin.js";
import { modelTransport, diagnosticObserver } from "./transport.js";

export const imageToolResultSupport = "native" as const;

const ANTHROPIC_DEFAULT_THINKING_LEVELS: ThinkingLevelMap = { off: "off", low: "low", medium: "medium", high: "high" };

const log = logger("yesimbot.provider");

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

type AnthropicThinkingOptions = { readonly effort: AnthropicEffort } | { readonly thinking: { readonly type: "disabled" } };

export interface Config extends BaseProviderConfig {
  webSearch: boolean;
}

interface AnthropicThinkingResolution {
  readonly clamped: boolean;
  readonly level: ThinkingLevel;
  readonly providerOptions: AnthropicThinkingOptions | undefined;
  readonly requested: ThinkingLevel;
}

export function resolveAnthropicThinkingOptions(entry: ChatModelConfig): AnthropicThinkingResolution | undefined {
  if (entry.thinkingLevel === undefined) return undefined;

  const resolved = resolveThinkingLevel(
    {
      defaultMap: ANTHROPIC_DEFAULT_THINKING_LEVELS,
      isNativeValue: isAnthropicEffort,
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
    },
    entry.thinkingLevel,
  );
  return {
    clamped: resolved.clamped,
    level: resolved.level,
    providerOptions: anthropicProviderOptions(resolved.level, resolved.native),
    requested: entry.thinkingLevel,
  };
}

/** The Anthropic connection as Core registers it; a model it cannot map logs once per model. */
export function createAnthropicProvider(config: Config): ModelProvider {
  const warned = new Set<string>();
  const client = createAnthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    fetch: modelTransport(modelFetch, config.id, diagnosticObserver(config.id)),
  });
  return {
    id: config.id,
    capabilities: { chat: true, embedding: false },
    chatModels: () => config.chatModels,
    embeddingModels: () => [],
    chat: (modelId: string, modelConfig?: ChatModelConfig) => {
      const model = withReasoningOrigin(client.chat(modelId), config.id, "anthropic", reasoningRoute(config));
      const entry = modelConfig ?? config.chatModels.find((item) => item.id === modelId);
      const resolution = entry ? resolveAnthropicThinkingOptions(entry) : undefined;
      if (!resolution) return model;

      if (resolution.clamped && !warned.has(modelId)) {
        warned.add(modelId);
        log.warn("provider.thinking_level_clamped", {
          protocol: "anthropic",
          provider: config.id,
          model: modelId,
          requested: resolution.requested,
          level: resolution.level,
        });
      }
      if (!resolution.providerOptions) return model;

      return wrapLanguageModel({
        model,
        middleware: [defaultSettingsMiddleware({ settings: { providerOptions: { anthropic: resolution.providerOptions } } })],
      });
    },
    chatCapabilities: () => ({ imageToolResult: imageToolResultSupport }),
    embedding: () => {
      throw new AppError(MODEL_PROVIDER_ERRORS.model_provider_embedding_unsupported, { effect: "none", detail: config.id });
    },
    tools: (): ToolSet => (config.webSearch ? { web_search: client.tools.webSearch_20250305() } : {}),
  };
}

function anthropicProviderOptions(level: ThinkingLevel, native: string | undefined): AnthropicThinkingOptions | undefined {
  if (level === "off") return { thinking: { type: "disabled" } };
  return isAnthropicEffort(native) ? { effort: native } : undefined;
}

function isAnthropicEffort(value: string | undefined): value is AnthropicEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

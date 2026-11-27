import { createOpenAI, type OpenAIChatLanguageModelOptions } from "@ai-sdk/openai";
import { logger, modelFetch } from "@yesimbot/foundation";
import { defaultSettingsMiddleware, wrapLanguageModel, type ToolSet } from "ai";
import {
  type BaseProviderConfig,
  type ChatModelConfig,
  type ImageToolResultSupport,
  resolveThinkingLevel,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from "koishi-plugin-yesimbot/kernel";

import { withUserMessageImageToolResults } from "./image-tool-result.js";
import { createOpenAIImageEditor } from "./images.js";
import type { ModelProvider } from "./provider.js";
import { reasoningRoute, withReasoningOrigin } from "./reasoning-origin.js";
import { modelTransport, diagnosticObserver } from "./transport.js";

const OPENAI_DEFAULT_THINKING_LEVELS: ThinkingLevelMap = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high" };

const log = logger("yesimbot.provider");

type OpenAIReasoningEffort = NonNullable<OpenAIChatLanguageModelOptions["reasoningEffort"]>;

export interface Config extends BaseProviderConfig {
  format: "chat" | "responses";
  imageToolResultSupport?: ImageToolResultSupport;
  imageToolResultPlacement?: "tool-output" | "user-message";
  webSearch?: boolean;
}

interface OpenAIThinkingResolution {
  readonly clamped: boolean;
  readonly level: ThinkingLevel;
  readonly providerOptions: { reasoningEffort: OpenAIReasoningEffort } | undefined;
  readonly requested: ThinkingLevel;
}

export function imageToolResultSupportForFormat(_format: Config["format"], override?: ImageToolResultSupport): ImageToolResultSupport {
  // Chat carries tool images in a temporary user image message to the same model. Its tool
  // output field is text-only; Responses also supports structured images in tool output.
  return override ?? "native";
}

/** Some compatible gateways default an omitted Responses stream flag to SSE. */
export function explicitResponsesStreamFetch(fetcher: typeof modelFetch): typeof modelFetch {
  return (input, init) => {
    if (typeof init?.body === "string") {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname.replace(/\/$/, "").endsWith("/responses")) {
        const body = JSON.parse(init.body);
        if (body && typeof body === "object" && body.stream === undefined) {
          return fetcher(input, { ...init, body: JSON.stringify({ ...body, stream: false }) });
        }
      }
    }
    return fetcher(input, init);
  };
}

export function resolveOpenAIThinkingOptions(entry: ChatModelConfig): OpenAIThinkingResolution | undefined {
  if (entry.thinkingLevel === undefined) return undefined;

  const resolved = resolveThinkingLevel(
    {
      defaultMap: OPENAI_DEFAULT_THINKING_LEVELS,
      isNativeValue: isOpenAIReasoningEffort,
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
    },
    entry.thinkingLevel,
  );
  const effort = isOpenAIReasoningEffort(resolved.native) ? resolved.native : undefined;
  return {
    clamped: resolved.clamped,
    level: resolved.level,
    providerOptions: effort ? { reasoningEffort: effort } : undefined,
    requested: entry.thinkingLevel,
  };
}

/** The OpenAI connection as Core registers it; a model it cannot map logs once per model. */
export function createOpenAIProvider(config: Config): ModelProvider {
  const fetch = modelTransport(modelFetch, config.id, diagnosticObserver(config.id));
  const client = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    fetch: explicitResponsesStreamFetch(fetch),
  });
  const warned = new Set<string>();
  const imageToolResultSupport = imageToolResultSupportForFormat(config.format, config.imageToolResultSupport);
  const imageToolResultPlacement = config.format === "chat" ? "user-message" : (config.imageToolResultPlacement ?? "tool-output");
  return {
    id: config.id,
    capabilities: { chat: true, embedding: true, image: true },
    chatModels: () => config.chatModels,
    embeddingModels: () => config.embeddingModels ?? [],
    imageModels: () => config.imageModels ?? [],
    image: (modelId: string) => ({
      model: client.image(modelId),
      edit: createOpenAIImageEditor({ apiKey: config.apiKey, baseURL: config.baseURL, modelId, fetch }),
    }),
    chat: (modelId: string, modelConfig?: ChatModelConfig) => {
      const base = withReasoningOrigin(
        config.format === "responses" ? client.responses(modelId) : client.chat(modelId),
        config.id,
        `openai:${config.format}`,
        reasoningRoute(config),
      );
      const entry = modelConfig ?? config.chatModels.find((item) => item.id === modelId);
      const resolution = entry ? resolveOpenAIThinkingOptions(entry) : undefined;
      const model = resolution?.providerOptions
        ? wrapLanguageModel({
            model: base,
            middleware: [defaultSettingsMiddleware({ settings: { providerOptions: { openai: resolution.providerOptions } } })],
          })
        : base;

      if (resolution?.clamped && !warned.has(modelId)) {
        warned.add(modelId);
        log.warn("provider.thinking_level_clamped", {
          protocol: "openai",
          provider: config.id,
          model: modelId,
          requested: resolution.requested,
          level: resolution.level,
        });
      }
      return imageToolResultSupport === "native" && imageToolResultPlacement === "user-message" ? withUserMessageImageToolResults(model) : model;
    },
    embedding: (modelId: string) => client.embedding(modelId),
    chatCapabilities: () => ({ imageToolResult: imageToolResultSupport }),
    tools: (): ToolSet => (config.format === "responses" && config.webSearch ? { web_search: client.tools.webSearch({}) } : {}),
  };
}

function isOpenAIReasoningEffort(value: string | undefined): value is OpenAIReasoningEffort {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

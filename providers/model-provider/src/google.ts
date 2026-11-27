import { createGoogleGenerativeAI, type GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { logger, modelFetch } from "@yesimbot/foundation";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { type BaseProviderConfig, type ChatModelConfig, resolveThinkingLevel, type ThinkingLevel, type ThinkingLevelMap } from "koishi-plugin-yesimbot/kernel";

import { createGoogleImageAdapter } from "./images.js";
import type { ModelProvider } from "./provider.js";
import { reasoningRoute, withReasoningOrigin } from "./reasoning-origin.js";
import { modelTransport, diagnosticObserver } from "./transport.js";

export const imageToolResultSupport = "native" as const;

/**
 * NewAPI/CPA routes must explicitly opt into additional image formats. PNG/JPEG are the
 * conservative native baseline; WebP is not projected until the route has been verified.
 */
export const defaultImageToolResultMediaTypes = ["image/png", "image/jpeg"] as const satisfies readonly (
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
)[];

export const videoInputSupport = "native" as const;

export const googleVideoInputMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => {
    let userInput: Extract<(typeof params.prompt)[number], { role: "user" }> | undefined;
    const prompt = params.prompt.map((message) => {
      if (message.role === "user") {
        userInput = { ...message, content: [...message.content] };
        return userInput;
      }
      if (message.role !== "tool") return message;
      return {
        ...message,
        content: message.content.map((result) => {
          if (result.type !== "tool-result" || result.output.type !== "content") return result;
          const value = result.output.value.filter((part) => {
            if (part.type !== "file-data" || !part.mediaType.startsWith("video/")) return true;
            if (!userInput) throw new Error("Google video projection requires a preceding user input");
            // Video is supported as user media, not inside Gemini functionResponse.parts.
            userInput.content.push({ ...part, type: "file" });
            return false;
          });
          return { ...result, output: { ...result.output, value } };
        }),
      };
    });
    return { ...params, prompt };
  },
};

const GOOGLE_DEFAULT_THINKING_LEVELS: ThinkingLevelMap = { minimal: "minimal", low: "low", medium: "medium", high: "high" };

const log = logger("yesimbot.provider");

type GoogleNativeThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface Config extends BaseProviderConfig {
  imageToolResultMediaTypes?: ("image/png" | "image/jpeg" | "image/gif" | "image/webp")[];
}

interface GoogleThinkingResolution {
  readonly clamped: boolean;
  readonly level: ThinkingLevel;
  readonly providerOptions: GoogleGenerativeAIProviderOptions | undefined;
  readonly requested: ThinkingLevel;
}

export function resolveGoogleThinkingOptions(entry: ChatModelConfig): GoogleThinkingResolution | undefined {
  if (entry.thinkingLevel === undefined) return undefined;

  const resolved = resolveThinkingLevel(
    {
      defaultMap: GOOGLE_DEFAULT_THINKING_LEVELS,
      isNativeValue: isGoogleNativeThinkingLevel,
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
    },
    entry.thinkingLevel,
  );
  const native = isGoogleNativeThinkingLevel(resolved.native) ? resolved.native : undefined;
  return {
    clamped: resolved.clamped,
    level: resolved.level,
    providerOptions: native ? { thinkingConfig: { thinkingLevel: native } } : undefined,
    requested: entry.thinkingLevel,
  };
}

/** The Google connection as Core registers it; a model it cannot map logs once per model. */
export function createGoogleProvider(config: Config): ModelProvider {
  const warned = new Set<string>();
  const client = createGoogleGenerativeAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    fetch: modelTransport(modelFetch, config.id, diagnosticObserver(config.id)),
  });
  return {
    id: config.id,
    capabilities: { chat: true, embedding: true, image: true },
    chatModels: () => config.chatModels,
    embeddingModels: () => config.embeddingModels ?? [],
    imageModels: () => config.imageModels ?? [],
    image: (modelId: string) => createGoogleImageAdapter(client, modelId),
    chat: (modelId: string, modelConfig?: ChatModelConfig) => {
      const model = withReasoningOrigin(client.chat(modelId), config.id, "google", reasoningRoute(config));
      const entry = modelConfig ?? config.chatModels.find((item) => item.id === modelId);
      const resolution = entry ? resolveGoogleThinkingOptions(entry) : undefined;
      if (resolution?.clamped && !warned.has(modelId)) {
        warned.add(modelId);
        log.warn("provider.thinking_level_clamped", {
          protocol: "google",
          provider: config.id,
          model: modelId,
          requested: resolution.requested,
          level: resolution.level,
        });
      }
      return wrapLanguageModel({
        model,
        middleware: [
          googleVideoInputMiddleware,
          ...(resolution?.providerOptions ? [defaultSettingsMiddleware({ settings: { providerOptions: { google: resolution.providerOptions } } })] : []),
        ],
      });
    },
    chatCapabilities: () => ({
      imageToolResult: imageToolResultSupport,
      imageToolResultMediaTypes: config.imageToolResultMediaTypes ?? defaultImageToolResultMediaTypes,
      videoInput: videoInputSupport,
      historyProjection: "gemini-native" as const,
    }),
    embedding: (modelId: string) => client.embedding(modelId),
  };
}

function isGoogleNativeThinkingLevel(value: string | undefined): value is GoogleNativeThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high";
}

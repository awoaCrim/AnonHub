import { createHash } from "node:crypto";

import type { LanguageModelV3, LanguageModelV3Prompt, SharedV3ProviderMetadata } from "@ai-sdk/provider";

/** Editing the destination or account under the same connection ID invalidates opaque state.
 * Only this one-way fingerprint is persisted, never the address or credential. */
export function reasoningRoute(config: { baseURL?: string; apiKey: string }): string {
  return createHash("sha256")
    .update(`${(config.baseURL ?? "").trim().replace(/\/+$/, "")}\0${config.apiKey}`)
    .digest("hex");
}

/** Opaque reasoning/signatures are replayable only to the same connection, protocol and model.
 * Legacy untagged reasoning has no verifiable origin. Normal text and tool calls remain usable. */
export function withReasoningOrigin(model: LanguageModelV3, connection: string, protocol: string, route?: string): LanguageModelV3 {
  const origin = { connection, protocol, model: model.modelId, ...(route ? { route } : {}) };
  const tag = (metadata?: SharedV3ProviderMetadata): SharedV3ProviderMetadata => ({ ...metadata, yesimbot: origin });
  const project = (prompt: LanguageModelV3Prompt): LanguageModelV3Prompt =>
    prompt.flatMap<LanguageModelV3Prompt[number]>((message) => {
      if (message.role !== "assistant") return [message];
      const content = message.content.flatMap<(typeof message.content)[number]>((part) => {
        const saved = part.providerOptions?.yesimbot;
        const same = saved?.connection === connection && saved.protocol === protocol && saved.model === model.modelId && saved.route === route;
        if (part.type === "reasoning" && !same) return [];
        if (same || !part.providerOptions) return [part];
        // Dialogue/tool payload is portable; cached item IDs and thought signatures are not.
        const { providerOptions: _private, ...portable } = part;
        return [portable];
      });
      if (!content.length) return [];
      const { providerOptions: _private, ...portable } = message;
      return [{ ...portable, content }];
    });
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(params) {
      const result = await model.doGenerate({ ...params, prompt: project(params.prompt) });
      return { ...result, content: result.content.map((part) => ({ ...part, providerMetadata: tag(part.providerMetadata) })) };
    },
    async doStream(params) {
      const result = await model.doStream({ ...params, prompt: project(params.prompt) });
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(part, controller) {
              switch (part.type) {
                case "reasoning-start":
                case "reasoning-delta":
                case "reasoning-end":
                case "text-start":
                case "text-delta":
                case "text-end":
                case "tool-call":
                case "file":
                  controller.enqueue({ ...part, providerMetadata: tag(part.providerMetadata) });
                  break;
                default:
                  controller.enqueue(part);
              }
            },
          }),
        ),
      };
    },
  };
}

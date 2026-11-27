import { parseConfig } from "@yesimbot/foundation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveReadImagePolicy } from "../../../core/src/runtimes/index.js";
import { moduleConfig } from "../src/config.js";
import { registerWith } from "./register.js";

const one = (connection: unknown) => (parseConfig(moduleConfig, { connections: [connection] }) as { connections: unknown[] }).connections[0];

type RegisteredProvider = {
  chatCapabilities?(modelId: string): { readonly imageToolResult?: "native" | "unsupported" | "unknown" };
  tools?(modelId: string): Record<string, { readonly id?: string; readonly type?: string }>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function registerProvider(config: Record<string, unknown>): RegisteredProvider {
  const { model } = registerWith(config);
  return model.register.mock.calls[0]?.[0] as RegisteredProvider;
}

describe("OpenAI image tool-result capability", () => {
  it.each([
    ["chat", "native"],
    ["responses", "native"],
  ] as const)("defaults %s format to %s when no override is configured", (format, imageToolResult) => {
    const provider = registerProvider({ id: "openai", apiKey: "test", format, chatModels: [], embeddingModels: [] });

    expect(provider.chatCapabilities?.("gpt-5")).toEqual({ imageToolResult });
  });

  it.each(["unsupported", "unknown"] as const)("propagates an explicit %s override without caption fallback", (imageToolResultSupport) => {
    const provider = registerProvider({
      id: "antigravity",
      apiKey: "test",
      format: "responses",
      imageToolResultSupport,
      imageToolResultPlacement: "user-message",
      chatModels: [],
      embeddingModels: [],
    });
    const capabilities = provider.chatCapabilities?.("gpt-5");
    if (!capabilities) throw new Error("provider did not declare chat capabilities");

    expect(capabilities).toEqual({ imageToolResult: imageToolResultSupport });
    expect(
      resolveReadImagePolicy(
        {
          entry: { modalities: { input: ["image"] } },
          capabilities,
          model: { id: "primary" },
        } as never,
        { entry: { modalities: { input: ["image"] } }, model: { id: "vision" } } as never,
        true,
      ),
    ).toEqual({ mode: "unavailable" });
  });

  it("exposes the optional imageToolResultSupport override with all supported values", () => {
    expect(one({ id: "images", apiKey: "test", chatModels: [], embeddingModels: [] })).toMatchObject({ imageModels: [] });
    expect(one({ id: "images", apiKey: "test", chatModels: [], embeddingModels: [], imageModels: [{ id: "gpt-image-2" }] })).toMatchObject({
      imageModels: [{ id: "gpt-image-2" }],
    });
  });
});

describe("OpenAI native web search", () => {
  it("registers web_search for opted-in Responses models", () => {
    const provider = registerProvider({ id: "openai", apiKey: "test", format: "responses", webSearch: true, chatModels: [], embeddingModels: [] });

    expect(provider.tools?.("gpt-5")?.web_search).toMatchObject({ type: "provider", id: "openai.web_search" });
  });

  it("omits web_search when Responses search is not enabled", () => {
    const provider = registerProvider({ id: "openai", apiKey: "test", format: "responses", webSearch: false, chatModels: [], embeddingModels: [] });

    expect(provider.tools?.("gpt-5")).toEqual({});
  });

  it("omits web_search for the Chat Completions format", () => {
    const provider = registerProvider({ id: "openai", apiKey: "test", format: "chat", webSearch: true, chatModels: [], embeddingModels: [] });

    expect(provider.tools?.("gpt-5")).toEqual({});
  });
});

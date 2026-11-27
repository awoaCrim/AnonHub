import { describe, expect, it } from "vitest";

import { registerWith } from "./register.js";

type RegisteredProvider = { tools?(modelId: string): Record<string, { readonly id?: string; readonly type?: string }> };

function registerProvider(config: Record<string, unknown>): RegisteredProvider {
  const { model } = registerWith({ type: "anthropic", ...config });
  return model.register.mock.calls[0]?.[0] as RegisteredProvider;
}

describe("Anthropic native web search", () => {
  it("registers web_search when enabled", () => {
    const provider = registerProvider({ id: "anthropic", apiKey: "test", webSearch: true, chatModels: [] });

    expect(provider.tools?.("claude-sonnet")?.web_search).toMatchObject({ type: "provider", id: "anthropic.web_search_20250305" });
  });

  it("omits web_search when disabled", () => {
    const provider = registerProvider({ id: "anthropic", apiKey: "test", webSearch: false, chatModels: [] });

    expect(provider.tools?.("claude-sonnet")).toEqual({});
  });
});

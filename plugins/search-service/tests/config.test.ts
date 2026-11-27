import { configForm, parseConfig } from "@yesimbot/foundation";
import { describe, expect, it } from "vitest";

import { moduleConfig } from "../src/config.js";

describe("search-service configuration", () => {
  it("marks the Tavily credentials and the SearXNG HTTP Basic password as secret", () => {
    const form = JSON.stringify(configForm(moduleConfig.schema));
    expect(form.match(/"secret":true/g)).toHaveLength(3);
  });

  it("preserves the existing default provider", () => {
    expect(parseConfig(moduleConfig, { tavily: { apiKey: "test" } })).toEqual({
      provider: "tavily",
      blacklist: [],
      tavily: { apiKey: "test", apiKeys: [] },
    });
  });

  it("preserves complete Tavily overrides in the existing nested provider object", () => {
    const previous = { provider: "tavily" as const, blacklist: ["blocked"], tavily: { apiKey: "test" } };
    expect(parseConfig(moduleConfig, structuredClone(previous))).toEqual({
      ...previous,
      tavily: { apiKey: "test", apiKeys: [] },
    });
  });

  it("preserves the SearXNG branch and its existing defaults and explicit preferences", () => {
    expect(parseConfig(moduleConfig, { provider: "searxng", searxng: { endpoint: "https://search.example" } })).toEqual({
      provider: "searxng",
      blacklist: [],
      searxng: { endpoint: "https://search.example", engines: [], categories: [] },
    });
    const previous = {
      provider: "searxng" as const,
      blacklist: ["blocked"],
      searxng: {
        endpoint: "https://search.example",
        engines: ["web-only"],
        categories: ["general"],
        language: "zh-CN",
        safeSearch: 1 as const,
        username: "test",
        password: "placeholder",
      },
    };
    expect(parseConfig(moduleConfig, structuredClone(previous))).toEqual(previous);
  });

  it("keeps required provider credentials and endpoint validation unchanged", () => {
    expect(() => parseConfig(moduleConfig, { provider: "searxng", searxng: {} })).toThrow();
    expect(() => parseConfig(moduleConfig, { provider: "unknown" })).toThrow();
  });
});

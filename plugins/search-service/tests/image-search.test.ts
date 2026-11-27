import { configureLogging, manualClock, type LogRecord } from "@yesimbot/foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSearXNGBackend } from "../src/backends/searxng.js";
import { createTavilyBackend } from "../src/backends/tavily.js";
import { jsonResponse, stubFetch } from "./helpers.js";

const runtime = { blacklist: ["blocked\\.example"] };
const context = { toolCallId: "search", turnId: "turn-1", messages: [] } as never;
const clock = manualClock(Date.UTC(2026, 10, 24));
const records: LogRecord[] = [];

beforeEach(() => {
  records.length = 0;
  configureLogging({ sink: (record) => records.push(record) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public reference image search", () => {
  it("requests Tavily images with descriptions, keeps real attribution, and bounds candidates", async () => {
    const fetch = stubFetch(() =>
      jsonResponse({
        images: [{ url: "https://cdn.example/a.png", description: "duplicate without attribution" }, "https://cdn.example/b.png", null],
        results: [
          {
            url: "https://source.example/character",
            title: "Official character",
            images: [{ url: "https://cdn.example/a.png", description: "x".repeat(1000) }],
          },
          { url: "https://blocked.example/page", images: [{ url: "https://cdn.example/blocked.png" }] },
        ],
      }),
    );
    const backend = createTavilyBackend({ apiKey: "secret" }, runtime, clock);
    const tool = backend.createImageSearchTool();
    const output = await tool.execute({ query: "public character", limit: 2 }, context);
    expect(String(fetch.mock.lastCall?.[0])).toBe("https://api.tavily.com/search");
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({
      query: "public character",
      search_depth: "basic",
      max_results: 2,
      include_images: true,
      include_image_descriptions: true,
    });
    expect(output).toMatchObject({
      provider: "tavily",
      results: [
        { imageUrl: "https://cdn.example/a.png", sourcePageUrl: "https://source.example/character", title: "Official character" },
        { imageUrl: "https://cdn.example/b.png" },
      ],
    });
    const results = (output as { results: Array<{ description?: string; sourcePageUrl?: string }> }).results;
    expect(results[0]?.description?.length).toBeLessThanOrEqual(301);
    expect(results[1]?.sourcePageUrl).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("secret");
  });

  it("requests SearXNG image results without inheriting web-only engines and never substitutes thumbnails", async () => {
    const fetch = stubFetch(() =>
      jsonResponse({
        results: [
          {
            url: "https://source.example/item",
            img_src: "https://cdn.example/original.webp",
            thumbnail_src: "https://cdn.example/thumb.webp",
            title: "Product",
            content: "A product",
          },
          { url: "https://source.example/thumb-only", thumbnail_src: "https://cdn.example/only-thumb.webp" },
          { url: "https://source.example/item", img_src: "file:///etc/passwd" },
          { url: "https://source.example/item", img_src: "https://user:secret@cdn.example/a.png" },
          { url: "https://blocked.example/page", img_src: "https://cdn.example/blocked.png" },
        ],
      }),
    );
    const backend = createSearXNGBackend(
      { endpoint: "https://search.example", engines: ["web-only"], categories: ["general"], language: "en", safeSearch: 1 },
      runtime,
    );
    const output = await backend.createImageSearchTool().execute({ query: "Product model" }, context);
    expect(String(fetch.mock.lastCall?.[0])).toBe("https://search.example/search?q=Product+model&format=json&categories=images&language=en&safesearch=1");
    expect([...new Headers(fetch.mock.lastCall?.[1]?.headers).keys()]).not.toContain("authorization");
    expect(output).toEqual({
      provider: "searxng",
      query: "Product model",
      results: [{ imageUrl: "https://cdn.example/original.webp", sourcePageUrl: "https://source.example/item", title: "Product", description: "A product" }],
    });
  });

  it.each(["tavily", "searxng"])("bounds %s failures and never logs upstream secrets", async (provider) => {
    const request = stubFetch(() => new Response("secret raw provider response", { status: 500 }));
    const backend =
      provider === "tavily" ? createTavilyBackend({ apiKey: "secret" }, runtime, clock) : createSearXNGBackend({ endpoint: "https://search.example" }, runtime);
    const tool = backend.createImageSearchTool();
    const failed = await tool.execute({ query: "public subject" }, context);
    expect(failed).toMatchObject({ results: [], error: { code: "request_failed", message: "搜索服务请求失败，请稍后再试。" } });
    expect(JSON.stringify(failed)).not.toMatch(/secret|raw provider/);
    expect(JSON.stringify(records)).not.toMatch(/"secret"|Bearer/);
    await expect(tool.execute({ query: " " }, context)).resolves.toMatchObject({ results: [], error: { code: "invalid_query" } });
    expect(request).toHaveBeenCalledOnce();
  });
});

import { configureLogging, manualClock, type LogRecord } from "@yesimbot/foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { identity, policy } from "../../../tests/tool-policy.js";
import { createSearXNGBackend } from "../src/backends/searxng.js";
import { createTavilyBackend, resolveTavilyKeys, TAVILY_QUOTA_COOLDOWN_MS } from "../src/backends/tavily.js";
import { SearchService } from "../src/index.js";
import { bearers, jsonResponse, stubFetch } from "./helpers.js";

const runtime = { blacklist: [] };
const records: LogRecord[] = [];
const clock = manualClock(Date.UTC(2026, 10, 24));

beforeEach(() => {
  records.length = 0;
  configureLogging({ sink: (record) => records.push(record) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function promptFor(provider: "tavily" | "searxng"): Promise<string> {
  const host = {
    resources: vi.fn(async () => ({ artifacts: { forTool: () => ({ put: vi.fn() }) }, maxBytes: 1024 }) as never),
    conversation: identity.conversation as never,
  };
  const config = provider === "tavily" ? { provider, tavily: { apiKey: "test" } } : { provider, searxng: { endpoint: "https://example.com" } };
  const service = new SearchService({ ...config }, host, clock);

  service.start();
  try {
    const plugin = await service.setup({ type: "guild", platform: "onebot", channelId: "room", guildId: "room", selfId: "bot" } as never, {} as never);
    if (!plugin) throw new Error("Expected search plugin");
    return (plugin.appendSystemPrompt as () => string)();
  } finally {
    service.stop();
  }
}

describe("search backend tool names", () => {
  it("names Tavily search tool search_web", () => {
    const backend = createTavilyBackend({ apiKey: "test" }, runtime, clock);

    expect(backend.createSearchTool().name).toBe("search_web");
  });

  it("names Tavily scraper read_webpage", () => {
    const backend = createTavilyBackend({ apiKey: "test" }, runtime, clock);

    expect(backend.createScrapeTool?.().name).toBe("read_webpage");
  });

  it("sends Tavily web search to the fixed endpoint with basic depth and only per-call topic/time range", async () => {
    const fetch = stubFetch(() => jsonResponse({ results: [] }));
    const tool = createTavilyBackend({ apiKey: "test" }, runtime, clock).createSearchTool();
    const sent = () => JSON.parse(String(fetch.mock.lastCall?.[1]?.body));

    await tool.execute({ query: "news", limit: 50 }, {} as never);
    expect(String(fetch.mock.lastCall?.[0])).toBe("https://api.tavily.com/search");
    expect(sent()).toMatchObject({ query: "news", search_depth: "basic", max_results: 10 });
    expect(sent().topic).toBeUndefined();
    expect(sent().time_range).toBeUndefined();

    await tool.execute({ query: "news", searchDepth: "advanced", topic: "news", timeRange: "week" }, {} as never);
    expect(sent()).toMatchObject({ search_depth: "advanced", topic: "news", time_range: "week", max_results: 5 });
  });

  it("sends Tavily extraction to the fixed extract endpoint", async () => {
    const fetch = stubFetch(() => jsonResponse({ results: [] }));
    const backend = createTavilyBackend({ apiKey: "test" }, runtime, clock);

    await backend.createScrapeTool?.().execute({ urls: ["https://example.com/a"] }, {} as never);
    expect(String(fetch.mock.lastCall?.[0])).toBe("https://api.tavily.com/extract");
    expect(JSON.parse(String(fetch.mock.lastCall?.[1]?.body))).toEqual({ urls: ["https://example.com/a"] });
  });

  it("gives the model one registered sentence for an extraction failure and keeps Tavily's text in the log", async () => {
    stubFetch(() => jsonResponse({ results: [], failed_results: [{ url: "https://example.com/a", error: "upstream says: internal path /srv/x" }] }));
    const backend = createTavilyBackend({ apiKey: "test" }, runtime, clock);
    const output = await backend.createScrapeTool!().execute({ urls: ["https://example.com/a", "ftp://bad.example/"] }, {} as never);
    expect(JSON.stringify(output)).not.toContain("upstream says");
    expect(output.results).toEqual([
      { url: "ftp://bad.example/", error: "网址格式不对，或不是 http、https 开头。" },
      { url: "https://example.com/a", error: "这个网页没能提取出内容。" },
    ]);
    expect(JSON.stringify(records)).toContain("upstream says");
  });

  it("keeps an upstream error body out of what the model sees, and in the log", async () => {
    stubFetch(() => new Response("provider says: key sk-secret-value rejected for account 42", { status: 400 }));
    const output = await createTavilyBackend({ apiKey: "test" }, runtime, clock)
      .createSearchTool()
      .execute({ query: "a" }, {} as never);
    expect(output).toMatchObject({ results: [], ok: false, error: { code: "request_failed", message: "搜索服务拒绝了这次请求。" } });
    expect(JSON.stringify(output)).not.toMatch(/provider says|account 42/);
    expect(records.find((record) => record.event === "tavily.search_failed")).toMatchObject({ level: "warn", code: "search_upstream_rejected" });
    expect(JSON.stringify(records)).toContain("provider says");
  });

  it("sends the SearXNG HTTP Basic password to the search instance", async () => {
    const fetch = stubFetch(() => jsonResponse({ results: [] }));
    const config = { endpoint: "https://example.com", username: "user", password: "pass" };
    const backend = createSearXNGBackend(config, runtime);

    await backend.createSearchTool().execute({ query: "q" }, {} as never);
    expect(String(fetch.mock.lastCall?.[0])).toBe("https://example.com/search?q=q&format=json");
    expect(new Headers(fetch.mock.lastCall?.[1]?.headers).get("authorization")).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });

  it("names SearXNG search tool search_web", () => {
    const backend = createSearXNGBackend({ endpoint: "https://example.com" }, runtime);

    expect(backend.createSearchTool().name).toBe("search_web");
  });

  it("describes the selected backend's concrete tool names", async () => {
    await expect(promptFor("tavily")).resolves.toContain("`search_web`");
    await expect(promptFor("tavily")).resolves.toContain("`read_webpage`");
    await expect(promptFor("searxng")).resolves.toContain("`search_web`");
  });

  describe("Tavily multiple keys", () => {
    const answer = (status: number) => new Response("quota text from upstream", { status });
    const make = (config: { apiKeys?: string[]; apiKey?: string }) => createTavilyBackend(config, runtime, clock).createSearchTool();

    it("sticks to the first key and does not rotate", async () => {
      const fetch = stubFetch(() => jsonResponse({ results: [] }));
      const tool = make({ apiKeys: ["k1", "k2"] });
      await tool.execute({ query: "a" }, {} as never);
      await tool.execute({ query: "b" }, {} as never);
      expect(bearers(fetch)).toEqual(["Bearer k1", "Bearer k1"]);
    });

    it("moves to the next key on 432/433/401 and remembers it without logging key values", async () => {
      const fetch = stubFetch((_url, init) => {
        const key = init.headers.get("authorization");
        if (key === "Bearer k1") return answer(432);
        if (key === "Bearer k2") return answer(401);
        return jsonResponse({ results: [] });
      });
      const tool = make({ apiKeys: ["k1", "k2", "k3"] });
      expect((await tool.execute({ query: "a" }, {} as never)).error).toBeUndefined();
      expect(bearers(fetch)).toEqual(["Bearer k1", "Bearer k2", "Bearer k3"]);
      await tool.execute({ query: "b" }, {} as never);
      expect(bearers(fetch).slice(3)).toEqual(["Bearer k3"]);
      const warned = JSON.stringify(records.filter((record) => record.level === "warn"));
      expect(warned).not.toMatch(/k[123]"|Bearer/);
      expect(records.find((record) => record.event === "tavily.key_quota_exhausted")).toMatchObject({ key: 1, status: 432 });
    });

    it("retries a quota-blocked key after the cooldown", async () => {
      let first = true;
      const fetch = stubFetch((_url, init) => {
        if (init.headers.get("authorization") === "Bearer k1" && first) {
          first = false;
          return answer(433);
        }
        return jsonResponse({ results: [] });
      });
      const tool = make({ apiKeys: ["k1", "k2"] });
      await tool.execute({ query: "a" }, {} as never);
      clock.advance(TAVILY_QUOTA_COOLDOWN_MS + 1);
      await tool.execute({ query: "b" }, {} as never);
      expect(bearers(fetch)).toEqual(["Bearer k1", "Bearer k2", "Bearer k1"]);
    });

    it("uses the next key on 429 without marking the first exhausted", async () => {
      let limited = true;
      const fetch = stubFetch((_url, init) => {
        if (init.headers.get("authorization") === "Bearer k1" && limited) {
          limited = false;
          return answer(429);
        }
        return jsonResponse({ results: [] });
      });
      const tool = make({ apiKeys: ["k1", "k2"] });
      await tool.execute({ query: "a" }, {} as never);
      await tool.execute({ query: "b" }, {} as never);
      expect(bearers(fetch)).toEqual(["Bearer k1", "Bearer k2", "Bearer k1"]);
    });

    it("does not switch keys on 5xx or 400", async () => {
      for (const status of [500, 400]) {
        const fetch = stubFetch(() => answer(status));
        const tool = make({ apiKeys: ["k1", "k2"] });
        expect((await tool.execute({ query: "a" }, {} as never)).error?.code).toBe("request_failed");
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    });

    it("reports all keys used up once every key is blocked, without further requests", async () => {
      const fetch = stubFetch(() => answer(432));
      const tool = make({ apiKeys: ["k1", "k2"] });
      const result = await tool.execute({ query: "a" }, {} as never);
      expect(result.error).toMatchObject({ code: "request_failed", message: expect.stringContaining("所有 API Key") });
      await tool.execute({ query: "b" }, {} as never);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("treats the legacy apiKey as the first key and rejects an empty list", () => {
      expect(resolveTavilyKeys({ apiKey: "old", apiKeys: ["new", "old", " "] })).toEqual(["old", "new"]);
      expect(() => make({ apiKeys: [] })).toThrow(expect.objectContaining({ code: "search_config_invalid" }));
    });
  });
});

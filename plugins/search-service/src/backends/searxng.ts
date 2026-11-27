import type { AgentTool } from "@yesimbot/agent-runtime";
import { AppError, errorFields, httpFetch, logger } from "@yesimbot/foundation";
import { z } from "zod/v4";

import type { SearXNGConfig } from "../config.js";
import { SEARCH_ERRORS, searchFailure } from "../errors.js";
import type { ImageSearchOutput, SearchBackend, SearchRuntimeConfig, WebSearchOutput } from "../types.js";
import {
  clampLimit,
  compileBlacklist,
  dedupeByUrl,
  filterBlockedResults,
  MAX_IMAGE_CANDIDATES,
  normalizeImageCandidates,
  REQUEST_TIMEOUT_MS,
} from "../utils.js";

/** Largest SearXNG answer read. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const log = logger("yesimbot.search-service");

const searchInputSchema = z.object({
  query: z.string().min(1).describe("Search query."),
  limit: z.number().min(1).describe("Maximum number of results.").optional(),
  engines: z.array(z.string()).describe("Search engines to use.").optional(),
  language: z.string().describe("Search language.").optional(),
  categories: z.array(z.string()).describe("Search categories.").optional(),
  timeRange: z.enum(["day", "month", "year"]).describe("Time range for search.").optional(),
  safeSearch: z.literal([0, 1, 2]).describe("Safe search level.").optional(),
});

const imageSearchInputSchema = z.strictObject({
  query: z.string().min(1).max(512).regex(/\S/).describe("Name the public person, character, or product to find reference images."),
  limit: z.int().min(1).max(MAX_IMAGE_CANDIDATES).optional(),
});

type SearXNGSearchInput = z.infer<typeof searchInputSchema>;

interface SearXNGRuntimeConfig extends SearchRuntimeConfig, SearXNGConfig {}

interface SearXNGResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  engine?: string;
  category?: string;
  img_src?: string;
}

interface SearXNGResponse {
  results?: SearXNGResult[];
}

class SearXNGBackend implements SearchBackend {
  public readonly name = "searxng";

  private readonly blacklist: RegExp[];

  constructor(private readonly config: SearXNGRuntimeConfig) {
    this.blacklist = compileBlacklist(config.blacklist);
  }

  public createSearchTool(): AgentTool<SearXNGSearchInput, WebSearchOutput> {
    return {
      name: "search_web",
      description: "Search the web for current information, news, facts, or web content. " + "Returns structured JSON with titles, URLs, and snippets.",
      inputSchema: searchInputSchema,
      execute: async (input) => this.search(input),
    };
  }

  public createImageSearchTool(): AgentTool<z.infer<typeof imageSearchInputSchema>, ImageSearchOutput> {
    return {
      name: "search_images",
      description:
        "Find public reference-image candidates, not identity proof. Import a candidate with import_image_reference and inspect its pixels and source before generation. Never search for speculative private identities.",
      inputSchema: imageSearchInputSchema,
      execute: async (input) => {
        if (!input.query.trim() || input.query.length > 512)
          return { provider: this.name, query: "", results: [], ...searchFailure(new AppError(SEARCH_ERRORS.search_query_invalid, { effect: "none" })) };
        try {
          const response = await this.get({
            q: input.query,
            format: "json",
            categories: "images",
            language: this.config.language,
            safesearch: this.config.safeSearch?.toString(),
          });
          const limit = Math.min(clampLimit(input.limit), MAX_IMAGE_CANDIDATES);
          const results = normalizeImageCandidates(
            (Array.isArray(response.results) ? response.results : [])
              .slice(0, 64)
              .map((result) => ({ imageUrl: result.img_src, sourcePageUrl: result.url, title: result.title, description: result.content })),
            { blacklist: this.blacklist, limit },
          );
          return { provider: this.name, query: input.query, results };
        } catch (error) {
          log.warn("searxng.image_search_failed", { ...errorFields(error) });
          return { provider: this.name, query: input.query, results: [], ...searchFailure(error) };
        }
      },
    };
  }

  private async get(params: Record<string, string | undefined>): Promise<SearXNGResponse> {
    const headers: Record<string, string> = {};
    if (this.config.username && this.config.password) {
      headers.Authorization = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`;
    }
    const url = new URL(normalizeSearchUrl(this.config.endpoint));
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
    const response = await httpFetch(url, { purpose: "public", headers, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES });
    if (!response.ok) {
      // The instance's own text goes to the log only (through `detail`).
      const upstream = (await response.text().catch(() => "")).slice(0, 300);
      throw new AppError(response.status >= 500 ? "search_request_failed" : "search_upstream_rejected", {
        effect: "none",
        detail: `HTTP ${response.status} ${upstream}`,
      });
    }
    return (await response.json()) as SearXNGResponse;
  }

  private async search(input: SearXNGSearchInput): Promise<WebSearchOutput> {
    const limit = clampLimit(input.limit);
    const engines = input.engines ?? this.config.engines;
    const categories = input.categories ?? this.config.categories;
    const params: Record<string, string | undefined> = {
      q: input.query,
      format: "json",
      engines: engines?.join(","),
      categories: categories?.join(","),
      language: input.language ?? this.config.language,
      time_range: input.timeRange,
      safesearch: input.safeSearch != null ? String(input.safeSearch) : this.config.safeSearch != null ? String(this.config.safeSearch) : undefined,
    };

    try {
      const response = await this.get(params);
      const rawResults = Array.isArray(response.results) ? response.results : [];
      const mapped = rawResults.map((result) => ({
        title: result.title ?? "",
        url: result.url ?? "",
        snippet: result.content ?? "",
        score: result.score,
        metadata: { ...(result.engine ? { engine: result.engine } : {}), ...(result.category ? { category: result.category } : {}) },
      }));
      const filtered = filterBlockedResults(mapped, this.blacklist);
      const deduped = dedupeByUrl(filtered).slice(0, limit);

      return { provider: this.name, query: input.query, results: deduped };
    } catch (error) {
      log.warn("searxng.search_failed", { ...errorFields(error) });
      return { provider: this.name, query: input.query, results: [], ...searchFailure(error) };
    }
  }
}

export function createSearXNGBackend(config: SearXNGConfig | undefined, runtime: SearchRuntimeConfig): SearchBackend {
  if (!config?.endpoint) {
    throw new AppError(SEARCH_ERRORS.search_config_invalid, { effect: "none", detail: "SearXNG provider requires searxng.endpoint to be configured" });
  }

  return new SearXNGBackend({ ...runtime, ...config });
}

function normalizeSearchUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (trimmed.endsWith("/search")) return trimmed;
  return `${trimmed}/search`;
}

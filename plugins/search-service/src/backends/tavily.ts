import type { AgentTool } from "@yesimbot/agent-runtime";
import { AppError, errorFields, httpFetch, logger, type Clock } from "@yesimbot/foundation";
import { z } from "zod/v4";

import type { TavilyConfig } from "../config.js";
import { modelText, SEARCH_ERRORS, searchFailure } from "../errors.js";
import type { ImageSearchOutput, SearchBackend, SearchRuntimeConfig, WebScrapeOutput, WebSearchOutput } from "../types.js";
import {
  clampLimit,
  compileBlacklist,
  dedupeByUrl,
  filterBlockedResults,
  MAX_IMAGE_CANDIDATES,
  normalizeImageCandidates,
  normalizeUrlList,
  REQUEST_TIMEOUT_MS,
} from "../utils.js";

/** An exhausted (quota) key is probed again after this long; a top-up or plan change then takes effect without a restart. */
export const TAVILY_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_URLS_PER_SCRAPE = 20;
/** Largest Tavily answer read; search and extract answers are far smaller. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Endpoint shared by webpage and image search. */
const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
/** Page-extraction endpoint (not used for reference-image downloads). */
const TAVILY_EXTRACT_ENDPOINT = "https://api.tavily.com/extract";
/** Search depth for image search and for webpage search calls that do not pass `searchDepth`. */
const TAVILY_SEARCH_DEPTH: NonNullable<TavilySearchInput["searchDepth"]> = "basic";

const log = logger("yesimbot.search-service");

const searchInputSchema = z.object({
  query: z.string().min(1).describe("Search query."),
  limit: z.number().min(1).describe("Maximum number of results.").optional(),
  searchDepth: z.enum(["basic", "advanced"]).describe("Search depth.").optional(),
  topic: z.enum(["general", "news", "finance"]).describe("Search topic.").optional(),
  timeRange: z.enum(["day", "week", "month", "year"]).describe("Time range.").optional(),
  startDate: z.string().describe("Start date for the search.").optional(),
  endDate: z.string().describe("End date for the search.").optional(),
  includeRawContent: z.enum(["none", "text", "markdown"]).describe("Include raw content in the results.").optional(),
});

const scrapeInputSchema = z.object({ urls: z.array(z.url()).min(1).describe("HTTP or HTTPS URLs to extract.") });

const imageSearchInputSchema = z.object({
  query: z.string().min(1).max(512).regex(/\S/).describe("Image search query naming the public subject, character, or product."),
  limit: z.int().min(1).max(MAX_IMAGE_CANDIDATES).describe("Maximum number of image candidates.").optional(),
});

type TavilySearchInput = z.infer<typeof searchInputSchema>;

type TavilyScrapeInput = z.infer<typeof scrapeInputSchema>;

type TavilyImageSearchInput = z.infer<typeof imageSearchInputSchema>;

interface TavilyRuntimeConfig extends SearchRuntimeConfig {
  apiKeys: string[];
}

interface TavilyImageEntry {
  url?: string | null;
  description?: string | null;
}

interface TavilySearchResult {
  url: string;
  title: string;
  content: string;
  score?: number;
  raw_content?: string | null;
  favicon?: string | null;
  published_date?: string | null;
  images?: Array<TavilyImageEntry | string> | null;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
  images?: Array<TavilyImageEntry | string> | null;
}

interface TavilyExtractResult {
  url: string;
  raw_content?: string | null;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: Array<{ url: string; error: string }>;
}

class TavilyBackend implements SearchBackend {
  public readonly name = "tavily";

  private readonly blacklist: RegExp[];
  /** index -> epoch ms until which the key is skipped (Infinity: invalid until the config changes). In memory only. */
  private readonly keyBlockedUntil = new Map<number, number>();

  constructor(
    private readonly config: TavilyRuntimeConfig,
    private readonly clock: Clock,
  ) {
    this.blacklist = compileBlacklist(config.blacklist);
  }

  public createSearchTool(): AgentTool<TavilySearchInput, WebSearchOutput> {
    return {
      name: "search_web",
      description: "Search the web for current information, news, facts, or web content. " + "Returns structured JSON with titles, URLs, and snippets.",

      inputSchema: searchInputSchema,
      execute: async (input) => this.search(input),
    };
  }

  public createImageSearchTool(): AgentTool<TavilyImageSearchInput, ImageSearchOutput> {
    return {
      name: "search_images",
      description: [
        "Find publicly hosted image candidates for an identifiable person, character, product, or object.",
        "Results are candidate clues (image URL, optional source page, title/description), never identity proof.",
        "Inspect the actual pixels with import_image_reference before using one as a generation reference.",
      ].join(" "),
      inputSchema: imageSearchInputSchema,
      execute: async (input) => this.imageSearch(input),
    };
  }

  public createScrapeTool(): AgentTool<TavilyScrapeInput, WebScrapeOutput> {
    return {
      name: "read_webpage",
      description: "Extract readable content from one or more web pages. " + "Use after search_web when full page text is needed.",
      inputSchema: scrapeInputSchema,
      execute: async (input) => {
        const normalized = normalizeUrlList(input.urls, MAX_URLS_PER_SCRAPE);
        const validUrls: string[] = [];
        const results: WebScrapeOutput["results"] = [];

        for (const entry of normalized) {
          if ("error" in entry) {
            results.push({ url: entry.url, error: entry.error });
          } else {
            validUrls.push(entry.url);
          }
        }

        if (validUrls.length > 0) {
          const output = await this.scrape(validUrls);
          results.push(...output.results);
        }

        return { provider: this.name, results };
      },
    };
  }

  /**
   * Keys are used in order, never rotated: each request starts at the first key not marked unusable.
   * 432/433 (quota) block a key for the cooldown, 401 until restart/config change; 429 only moves this
   * request to the next key. Anything else (5xx, 400, network) is rethrown without switching.
   */
  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const keys = this.config.apiKeys;
    const now = this.clock.now();
    let rateLimited: AppError | undefined;
    let tried = 0;
    for (let index = 0; index < keys.length; index++) {
      if ((this.keyBlockedUntil.get(index) ?? 0) > now) continue;
      this.keyBlockedUntil.delete(index);
      tried++;
      const response = await httpFetch(endpoint, {
        purpose: "public",
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${keys[index]}` },
        body: JSON.stringify(body),
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
      });
      if (response.ok) return (await response.json()) as T;
      const status = response.status;
      const upstream = (await response.text().catch(() => "")).slice(0, 300);
      if (status === 432 || status === 433) {
        this.keyBlockedUntil.set(index, this.clock.now() + TAVILY_QUOTA_COOLDOWN_MS);
        log.warn("tavily.key_quota_exhausted", { key: index + 1, status });
      } else if (status === 401) {
        this.keyBlockedUntil.set(index, Infinity);
        log.warn("tavily.key_rejected", { key: index + 1, status });
      } else if (status === 429) {
        rateLimited = new AppError(SEARCH_ERRORS.search_rate_limited, { effect: "none", detail: `HTTP ${status} ${upstream}` });
        log.warn("tavily.key_rate_limited", { key: index + 1, status });
      } else {
        // The upstream text goes to the log only (through `detail`); the model reads the registered sentence.
        throw new AppError(status >= 500 ? "search_request_failed" : "search_upstream_rejected", { effect: "none", detail: `HTTP ${status} ${upstream}` });
      }
    }
    if (rateLimited && tried > 0) throw rateLimited;
    throw new AppError(SEARCH_ERRORS.search_keys_unavailable, { effect: "none" });
  }

  private async search(input: TavilySearchInput): Promise<WebSearchOutput> {
    const limit = clampLimit(input.limit);
    const body = {
      query: input.query,
      search_depth: input.searchDepth ?? TAVILY_SEARCH_DEPTH,
      topic: input.topic,
      max_results: limit,
      time_range: input.timeRange,
      start_date: input.startDate,
      end_date: input.endDate,
      include_raw_content: input.includeRawContent,
    };

    try {
      const response = await this.post<TavilySearchResponse>(TAVILY_SEARCH_ENDPOINT, body);

      const rawResults = Array.isArray(response.results) ? response.results : [];
      const mapped = rawResults.map((result) => ({ title: result.title ?? "", url: result.url ?? "", snippet: result.content ?? "", score: result.score }));
      const filtered = filterBlockedResults(mapped, this.blacklist);
      const deduped = dedupeByUrl(filtered);

      return { provider: this.name, query: input.query, results: deduped };
    } catch (error) {
      log.warn("tavily.search_failed", { ...errorFields(error) });
      return { provider: this.name, query: input.query, results: [], ...searchFailure(error) };
    }
  }

  private async imageSearch(input: TavilyImageSearchInput): Promise<ImageSearchOutput> {
    if (!input.query.trim() || input.query.length > 512)
      return { provider: this.name, query: "", results: [], ...searchFailure(new AppError(SEARCH_ERRORS.search_query_invalid, { effect: "none" })) };
    const limit = Math.min(clampLimit(input.limit), MAX_IMAGE_CANDIDATES);
    const body = {
      query: input.query,
      search_depth: TAVILY_SEARCH_DEPTH,
      max_results: limit,
      include_images: true,
      include_image_descriptions: true,
    };

    try {
      const response = await this.post<TavilySearchResponse>(TAVILY_SEARCH_ENDPOINT, body);

      const rawResults = Array.isArray(response.results) ? response.results : [];
      const topLevel = Array.isArray(response.images) ? response.images : [];
      const candidates = normalizeImageCandidates(
        [
          ...rawResults
            .slice(0, 16)
            .flatMap((result) =>
              Array.isArray(result.images)
                ? result.images.slice(0, 16).map((image) => ({ ...toImageCandidate(image), sourcePageUrl: result.url, title: result.title }))
                : [],
            ),
          ...topLevel.slice(0, 32).map(toImageCandidate),
        ],
        { blacklist: this.blacklist, limit },
      );

      return { provider: this.name, query: input.query, results: candidates };
    } catch (error) {
      log.warn("tavily.image_search_failed", { ...errorFields(error) });
      return { provider: this.name, query: input.query, results: [], ...searchFailure(error) };
    }
  }

  private async scrape(urls: string[]): Promise<WebScrapeOutput> {
    try {
      const response = await this.post<TavilyExtractResponse>(TAVILY_EXTRACT_ENDPOINT, { urls });

      const results: WebScrapeOutput["results"] = [];

      if (Array.isArray(response.results)) {
        for (const result of response.results) {
          results.push({ url: result.url, content: result.raw_content ?? undefined });
        }
      }

      if (Array.isArray(response.failed_results)) {
        for (const result of response.failed_results) {
          // Tavily's reason is for the log; the model reads one registered sentence.
          log.info("tavily.extract_page_failed", { reason: String(result.error ?? "").slice(0, 300) });
          results.push({ url: result.url, error: modelText("search_extract_failed") });
        }
      }

      return { provider: this.name, results };
    } catch (error) {
      log.warn("tavily.extract_failed", { ...errorFields(error) });
      const message = searchFailure(error).error.message;
      return { provider: this.name, results: urls.map((url) => ({ url, error: message })) };
    }
  }
}

/** The primary `apiKey` first, then the backups in `apiKeys`: trimmed, non-empty, de-duplicated. */
export function resolveTavilyKeys(config: TavilyConfig | undefined): string[] {
  const all = [config?.apiKey, ...(Array.isArray(config?.apiKeys) ? config.apiKeys : [])];
  return [
    ...new Set(
      all
        .filter((key): key is string => typeof key === "string")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ];
}

export function createTavilyBackend(config: TavilyConfig | undefined, runtime: SearchRuntimeConfig, clock: Clock): SearchBackend {
  const apiKeys = resolveTavilyKeys(config);
  if (!apiKeys.length) {
    throw new AppError(SEARCH_ERRORS.search_config_invalid, { effect: "none", detail: "Tavily provider requires at least one key in tavily.apiKeys" });
  }

  return new TavilyBackend({ ...runtime, apiKeys }, clock);
}

function toImageCandidate(value: unknown) {
  if (typeof value === "string") return { imageUrl: value };
  if (!value || typeof value !== "object") return { imageUrl: undefined };
  return { imageUrl: "url" in value ? value.url : undefined, description: "description" in value ? value.description : undefined };
}

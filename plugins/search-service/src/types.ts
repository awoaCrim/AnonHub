import type { AgentTool } from "@yesimbot/agent-runtime";

import type { SearchToolFailure } from "./errors.js";

export interface SearchRuntimeConfig {
  blacklist: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  rawContent?: string;
  favicon?: string;
  publishedAt?: string;
  metadata?: unknown;
}

/** The failure fields are present only when the call failed; they are `searchFailure(error)` beside the empty `results`. */
export interface WebSearchOutput extends Partial<SearchToolFailure> {
  provider: string;
  query: string;
  results: SearchResult[];
}

export interface ImageSearchCandidate {
  imageUrl: string;
  sourcePageUrl?: string;
  title?: string;
  description?: string;
}

export interface ImageSearchOutput extends Partial<SearchToolFailure> {
  provider: string;
  query: string;
  results: ImageSearchCandidate[];
}

export interface ScrapeResult {
  url: string;
  content?: string;
  metadata?: unknown;
  error?: string;
}

export interface WebScrapeOutput {
  provider: string;
  results: ScrapeResult[];
}

export interface SearchBackend {
  readonly name: string;
  createSearchTool(): AgentTool;
  createScrapeTool?(): AgentTool;
  createImageSearchTool(): AgentTool;
}

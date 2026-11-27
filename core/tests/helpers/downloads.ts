import type { Part } from "@yesimbot/contracts/parts";
import { configureLogging } from "@yesimbot/foundation";
import { vi } from "vitest";

import type { AssetStore } from "../../src/resources/asset.js";
import type { ChannelResources } from "../../src/resources/index.js";
import { persistParts } from "../../src/resources/input.js";
import { fetchPlatformMedia } from "../../src/resources/platform-media.js";
import { parts, type TestElement } from "./elements.js";

/** A download as these tests describe it: an HTTP stream reply. */
export interface DownloadReply {
  readonly status: number;
  readonly headers: Headers;
  readonly data: ReadableStream<Uint8Array>;
}

export interface Downloads {
  readonly http: (url: string, init: { readonly signal?: AbortSignal | null }) => Promise<DownloadReply>;
  readonly logger?: (scope?: string) => { readonly warn?: (event: string, fields: Record<string, unknown>) => void };
}

/**
 * Persists inbound elements the way the kernel does, with each download answered by `downloads.http` (served as
 * the global fetch `httpFetch` calls) and each warning passed to `downloads.logger().warn(event, fields)`.
 */
export async function persistInbound(
  downloads: Downloads,
  elements: readonly TestElement[],
  resources: ChannelResources | { readonly assets: Pick<AssetStore, "put">; readonly videoInput?: boolean },
): Promise<Part[]> {
  serveDownloads(downloads);
  if ("persistParts" in resources) return resources.persistParts(parts(...elements), fetchPlatformMedia);
  return persistParts(parts(...elements), resources as { assets: AssetStore }, fetchPlatformMedia);
}

export function serveDownloads(downloads: Downloads): void {
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const reply = await downloads.http(String(input), { signal: init.signal ?? null });
    return new Response(reply.data, { status: reply.status, headers: reply.headers });
  });
  configureLogging({
    sink: ({ time: _time, level, scope, event, ...fields }) => {
      if (level === "warn") downloads.logger?.(scope)?.warn?.(event, fields);
    },
  });
}

import { AppError, detectImageType, httpFetch, imageDimensions, isAbortError, type HttpFetchSeams } from "@yesimbot/foundation";

import { SEARCH_ERRORS } from "./errors.js";

const MAX_REFERENCE_PIXELS = 40_000_000;
/**
 * Some sites answer a request without a User-Agent with 404 (anime.bang-dream.com), and Fandom answers a full Chrome
 * User-Agent without a browser's other headers with 403 (both 2026-11-24). This bare one passes both.
 */
const USER_AGENT = "Mozilla/5.0";

const NETWORK_CODES: Readonly<Record<string, string>> = {
  network_url_invalid: "search_image_url_invalid",
  network_destination_blocked: "search_image_unsafe_destination",
  network_dns_failed: "search_image_dns_failed",
  network_too_many_redirects: "search_image_too_many_redirects",
  network_timeout: "search_image_timeout",
  network_response_too_large: "search_image_too_large",
};

export interface ReferenceImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
}

/**
 * Downloads one public image a model named. The address is `untrusted` for the network layer: https on the default
 * port, public addresses only (every DNS answer and every redirect hop), the checked address pinned, at most three
 * redirects, one deadline for DNS, headers and body. Failures are registered `search_image_*` codes.
 */
export async function downloadReferenceImage(
  rawUrl: string,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly seams?: HttpFetchSeams;
  },
): Promise<ReferenceImage> {
  const url = parseReferenceUrl(rawUrl);
  try {
    const response = await httpFetch(url, {
      purpose: "untrusted",
      headers: { accept: "image/png,image/jpeg,image/webp", "user-agent": USER_AGENT },
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      signal: options.signal,
      seams: options.seams,
    });
    if (!response.ok) {
      await response.cancel();
      throw new AppError(SEARCH_ERRORS.search_image_download_failed, { effect: "none", detail: `HTTP ${response.status}` });
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType && !["image/png", "image/jpeg", "image/webp", "application/octet-stream"].includes(contentType)) {
      await response.cancel();
      throw new AppError(SEARCH_ERRORS.search_image_invalid, { effect: "none", detail: `content-type ${contentType}` });
    }
    const length = Number(response.headers.get("content-length"));
    const bytes = await response.bytes();
    // A compressed transfer reports its encoded length, so the exact-size check only applies without a content encoding.
    if (
      !response.headers.has("content-encoding") &&
      response.headers.has("content-length") &&
      Number.isFinite(length) &&
      length >= 0 &&
      bytes.byteLength !== length
    )
      throw new AppError(SEARCH_ERRORS.search_image_invalid, { effect: "none", detail: "body shorter or longer than content-length" });
    const image = inspectReferenceImage(bytes);
    if (contentType && contentType !== "application/octet-stream" && contentType !== image.mediaType)
      throw new AppError(SEARCH_ERRORS.search_image_invalid, { effect: "none", detail: `content-type ${contentType} is not ${image.mediaType}` });
    return image;
  } catch (cause) {
    if (isAbortError(cause) || options.signal?.aborted) throw new AppError(SEARCH_ERRORS.search_image_aborted, { effect: "none", cause });
    if (cause instanceof AppError) {
      const code = NETWORK_CODES[cause.code];
      if (code) throw new AppError(code, { effect: "none", cause });
      if (cause.code.startsWith("search_")) throw cause;
    }
    throw new AppError(SEARCH_ERRORS.search_image_download_failed, { effect: "none", cause });
  }
}

/** Type and size of PNG, JPEG or WebP bytes; `search_image_invalid` for anything else or an implausible size. */
export function inspectReferenceImage(bytes: Uint8Array): ReferenceImage {
  const mediaType = detectImageType(bytes);
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp")
    throw new AppError(SEARCH_ERRORS.search_image_invalid, { effect: "none", detail: "unsupported image signature" });
  const size = imageDimensions(bytes);
  if (!size || size.width * size.height > MAX_REFERENCE_PIXELS)
    throw new AppError(SEARCH_ERRORS.search_image_invalid, { effect: "none", detail: "unreadable or implausible dimensions" });
  return { bytes, mediaType, ...size };
}

function parseReferenceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new AppError(SEARCH_ERRORS.search_image_url_invalid, { effect: "none", cause });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new AppError(SEARCH_ERRORS.search_image_url_invalid, { effect: "none" });
  return url;
}

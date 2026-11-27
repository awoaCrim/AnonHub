import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { AppError, detectImageType, httpFetch, isPublicAddress, type HttpFetchSeams } from "@yesimbot/foundation";

import { RESOURCE_ERRORS, resourceError, resourceErrorCode, type ResourceReadErrorCode } from "./errors.js";
import { RESOURCE_MAX_BYTES, type ResourceOpenResult } from "./index.js";

/** One download, redirects included; the egress itself waits up to 20 s for a connection. */
const REMOTE_IMAGE_TIMEOUT_MS = 30_000;
/** Content types that say nothing about the payload; the bytes decide. */
const UNTYPED: readonly string[] = ["application/octet-stream", "binary/octet-stream", "application/unknown"];

export interface RemoteImageOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Test seams of `httpFetch` (the resolver). */
  readonly seams?: HttpFetchSeams;
}

/**
 * Downloads one picture from a public https address for `read` (user, 2026-11-20: 「推文中的图片也看不到」: a tweet names its
 * pictures by URL, and the preview server reaches pbs.twimg.com only through the runtime egress). The address is
 * `untrusted` (convention 05): every hop, redirects included, is https on the default port without credentials, to a
 * host whose addresses are all public, so a chat cannot point the bot at its own machine or network. Only a PNG, JPEG,
 * GIF or WebP of at most 5 MiB comes back; nothing is stored.
 */
export async function fetchRemoteImage(uri: string, options: RemoteImageOptions = {}): Promise<ResourceOpenResult> {
  if (options.signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
  try {
    const response = await httpFetch(uri, {
      purpose: "untrusted",
      timeoutMs: options.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS,
      maxBytes: RESOURCE_MAX_BYTES,
      headers: { accept: "image/*" },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.seams ? { seams: options.seams } : {}),
    });
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const problem: ResourceReadErrorCode | undefined = !response.ok
      ? RESOURCE_ERRORS.resource_unavailable
      : type && !type.startsWith("image/") && !UNTYPED.includes(type)
        ? RESOURCE_ERRORS.resource_not_image
        : undefined;
    if (problem) {
      await response.cancel();
      throw resourceError(problem, { detail: `status ${response.status}` });
    }
    const bytes = await response.bytes();
    const mediaType = detectImageType(bytes);
    if (!mediaType) throw resourceError(RESOURCE_ERRORS.resource_not_image);
    const segment = new URL(response.url).pathname.split("/").at(-1);
    return { bytes, mediaType, ...(segment && /^[\w.-]{1,120}\.[A-Za-z0-9]{2,5}$/.test(segment) ? { filename: segment } : {}) };
  } catch (cause) {
    if (options.signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
    if (resourceErrorCode(cause)) throw cause;
    throw resourceError(readErrorCode(cause), { cause });
  }
}

/**
 * Every address of the host is public; otherwise throws `resource_uri_invalid` (`resource_unavailable` when the
 * name does not resolve). For callers that still make their own requests to an address a model or a user supplied.
 */
export async function assertPublicHost(
  hostname: string,
  resolve: (hostname: string) => Promise<readonly { address: string }[]> = (name) => lookup(name, { all: true, verbatim: true }),
): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly { address: string }[];
  if (isIP(host)) addresses = [{ address: host }];
  else
    try {
      addresses = await resolve(host);
    } catch (cause) {
      throw resourceError(RESOURCE_ERRORS.resource_unavailable, { cause });
    }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw resourceError(RESOURCE_ERRORS.resource_uri_invalid);
}

function readErrorCode(cause: unknown): ResourceReadErrorCode {
  if (!(cause instanceof AppError)) return RESOURCE_ERRORS.resource_unavailable;
  switch (cause.code) {
    case "network_url_invalid":
    case "network_destination_blocked":
      return RESOURCE_ERRORS.resource_uri_invalid;
    case "network_timeout":
      return RESOURCE_ERRORS.resource_timeout;
    case "network_response_too_large":
      return RESOURCE_ERRORS.resource_too_large;
    default:
      return RESOURCE_ERRORS.resource_unavailable;
  }
}

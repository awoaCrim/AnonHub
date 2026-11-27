import { AppError, httpFetch, type HttpFetchSeams } from "@yesimbot/foundation";

import { WECHAT_ERRORS } from "./errors.js";

/** WeChat's own limit for one picture, plus its base64 framing. */
const REMOTE_MEDIA_MAX = 26_214_383;

const REMOTE_MEDIA_TIMEOUT_MS = 30_000;

const REMOTE_MEDIA_REDIRECTS = 3;

export type RemoteMediaFetcher = (url: string, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; mediaType: string }>;

/**
 * Downloads an `<img src="https://…">` the model or a plugin wrote, as an untrusted address (`httpFetch`): every hop,
 * redirects included, must name a host whose addresses are all public, checked before the request is sent, and the
 * body is counted while it streams.
 */
export function remoteMediaFetcher(seams?: HttpFetchSeams): RemoteMediaFetcher {
  return async (source, signal) => {
    let response;
    try {
      response = await httpFetch(source, {
        purpose: "untrusted",
        timeoutMs: REMOTE_MEDIA_TIMEOUT_MS,
        maxBytes: REMOTE_MEDIA_MAX,
        maxRedirects: REMOTE_MEDIA_REDIRECTS,
        ...(signal ? { signal } : {}),
        ...(seams ? { seams } : {}),
      });
    } catch (cause) {
      throw mediaFailure(cause);
    }
    try {
      if (!response.ok) throw new AppError(WECHAT_ERRORS.wechat_media_fetch_failed, { effect: "none", detail: `HTTP ${response.status}` });
      return { bytes: await response.bytes(), mediaType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream" };
    } catch (cause) {
      throw mediaFailure(cause);
    } finally {
      await response.cancel();
    }
  };
}

function mediaFailure(cause: unknown): unknown {
  if (cause instanceof AppError && cause.code.startsWith("wechat_")) return cause;
  if (!(cause instanceof AppError)) return cause;
  const code =
    cause.code === "network_url_invalid"
      ? WECHAT_ERRORS.wechat_media_source_unsupported
      : cause.code === "network_destination_blocked" || cause.code === "network_dns_failed"
        ? WECHAT_ERRORS.wechat_media_source_not_public
        : cause.code === "network_response_too_large"
          ? WECHAT_ERRORS.wechat_media_too_large
          : WECHAT_ERRORS.wechat_media_fetch_failed;
  return new AppError(code, { cause, effect: "none" });
}

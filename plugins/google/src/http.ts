import { AppError, httpFetch, isAbortError, type BoundedResponse, type HttpFetchOptions } from "@yesimbot/foundation";

import { googleError } from "./errors.js";

/** One Google call may take this long, headers and body together. */
const TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;

export type GoogleRequest = Pick<HttpFetchOptions, "method" | "headers" | "body">;

/**
 * One call to a Google API through `httpFetch` (`public`: a known service, routed by the network policy). A redirect is
 * never followed, so a bearer token cannot leave for another address. Provider messages can contain addresses, request
 * content or credentials, so only registered codes leave this function; the transport's own error stays as the cause.
 */
export async function request(url: string | URL, init: GoogleRequest, signal?: AbortSignal, text = false): Promise<unknown> {
  let response: BoundedResponse;
  let body: string;
  try {
    response = await httpFetch(url, {
      ...init,
      purpose: "public",
      timeoutMs: TIMEOUT_MS,
      maxBytes: text ? MAX_TEXT_BYTES : MAX_JSON_BYTES,
      maxRedirects: 0,
      ...(signal ? { signal } : {}),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.cancel();
      throw googleError("google_unavailable", { detail: `unexpected redirect ${response.status}` });
    }
    body = await response.text();
  } catch (cause) {
    throw transportError(cause, signal);
  }
  let data: unknown;
  let parseError: unknown;
  try {
    data = body ? JSON.parse(body) : {};
  } catch (cause) {
    data = {};
    parseError = cause;
  }
  if (!response.ok) {
    const error = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
    const detail = `HTTP ${response.status}`;
    if (error === "invalid_grant" || response.status === 401) throw googleError("google_reconnect_required", { detail });
    if (error === "invalid_client") throw googleError("google_app_invalid", { detail });
    if (response.status === 403) throw googleError("google_permission_denied", { detail });
    if (response.status === 404) throw googleError("google_not_found", { detail });
    if (response.status === 429) throw googleError("google_rate_limited", { detail });
    if (response.status >= 500) throw googleError("google_unavailable", { detail });
    throw googleError("google_request_rejected", { detail });
  }
  if (text) return body;
  if (parseError || (body && (!data || typeof data !== "object")))
    throw googleError("google_invalid_response", { ...(parseError === undefined ? {} : { cause: parseError }) });
  return data;
}

function transportError(cause: unknown, signal?: AbortSignal): AppError {
  if (cause instanceof AppError && cause.code.startsWith("google_")) return cause;
  if (cause instanceof AppError && cause.code === "network_response_too_large") return googleError("google_response_too_large", { cause });
  if (signal?.aborted || isAbortError(cause) || (cause instanceof AppError && cause.code === "network_timeout"))
    return googleError("google_timeout", { cause });
  return googleError("google_unavailable", { cause });
}

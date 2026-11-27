import { cachedFetch } from "./cache";

let unauthorized: UnauthorizedHandler | undefined;

type UnauthorizedHandler = (path: string) => void;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  signal?: AbortSignal;
  /** Authoritative reads must bypass cached responses and older in-flight requests. */
  fresh?: boolean;
  /** Login reports bad credentials with 401; that must not end an existing session. */
  allowUnauthorized?: boolean;
  /** Upload a native Blob/File directly, without reading or JSON-encoding it in the browser. */
  rawBody?: Blob;
}

/** Same-origin requests with JSON responses. Error text shown to users comes from fixed client strings, never server bodies. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
    readonly path?: string,
    readonly restored?: boolean,
  ) {
    super(code);
  }
}

export function onUnauthorized(handler: UnauthorizedHandler | undefined): void {
  unauthorized = handler;
}

/** For callers that issue their own fetches (legacy state modules). */
export function notifyUnauthorized(path: string): void {
  unauthorized?.(path);
}

export async function api<T>(path: string, body?: unknown, options: RequestOptions = {}, fetcher: typeof fetch = fetch): Promise<T> {
  const raw = options.rawBody !== undefined;
  const writing = body !== undefined || raw;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  // An upload body may take minutes on a slow link; the server ends it if the bytes stop (readRaw).
  const timeout = setTimeout(abort, raw ? 5 * 60_000 : 30_000);
  try {
    const init: RequestInit = {
      method: options.method ?? (writing ? "POST" : "GET"),
      credentials: "same-origin",
      cache: "no-store",
      headers: writing ? { Accept: "application/json", "Content-Type": raw ? "application/octet-stream" : "application/json" } : { Accept: "application/json" },
      body: raw ? options.rawBody : body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    };
    const response = await cachedFetch(fetcher, path, init, options.fresh);
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!response.ok) {
      const code = typeof (data as { message?: unknown })?.message === "string" ? (data as { message: string }).message : `http_${response.status}`;
      const retry = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      if (response.status === 401 && !options.allowUnauthorized) unauthorized?.(path);
      const details = data as { path?: unknown; restored?: unknown } | undefined;
      throw new ApiError(
        response.status,
        code,
        Number.isInteger(retry) && retry >= 1 && retry <= 60 ? retry : undefined,
        typeof details?.path === "string" ? details.path : undefined,
        typeof details?.restored === "boolean" ? details.restored : undefined,
      );
    }
    return data as T;
  } catch (error) {
    if (controller.signal.aborted) throw new ApiError(0, writing ? "write_unknown" : "read_timeout");
    if (writing && !(error instanceof ApiError)) throw new ApiError(0, "write_unknown");
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

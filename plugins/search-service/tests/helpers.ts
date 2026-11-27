import { vi } from "vitest";

export type FetchHandler = (url: string, init: RequestInit & { headers: Headers; signal: AbortSignal }) => Response | Promise<Response>;

/** Replaces the global `fetch` that the foundation's `httpFetch` calls; the handler sees the URL and the request. */
export function stubFetch(handler: FetchHandler) {
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) =>
    handler(String(input), { ...init, headers: new Headers(init?.headers), signal: init?.signal as AbortSignal }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** The bearer token of each recorded request. */
export function bearers(fetch: ReturnType<typeof stubFetch>): string[] {
  return fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("authorization") ?? "");
}

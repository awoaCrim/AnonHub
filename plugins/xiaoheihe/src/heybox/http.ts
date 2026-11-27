import { AppError, httpFetch, systemClock, type BoundedResponse, type Clock } from "@yesimbot/foundation";

import { signedParams, workshopParams } from "./signing.js";

export const API_BASE = "https://api.xiaoheihe.cn";

const WEB_BASE = "https://www.xiaoheihe.cn";

const DOMAINS = new Set(["xiaoheihe.cn", "api.xiaoheihe.cn", "www.xiaoheihe.cn"]);

const REQUEST_TIMEOUT_MS = 25_000;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const AUTH_STATUSES = new Set(["relogin", "not_login", "need_login", "login_required", "need_google_check"]);

/** Cookies as xiaoheihe-cli stores them, so its `session.json` can be reused unchanged. */
export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
}

export interface HeyboxRequest {
  params?: Record<string, string | number>;
  /** Present for writes: sent as a form POST, signed for Workshop, and never retried. */
  form?: Record<string, string>;
  /** Response statuses accepted besides "ok". */
  allowStatus?: readonly string[];
}

/**
 * Serial, rate-limited client of the xiaoheihe web API. Fails closed: no automatic retries (a POST is never repeated),
 * upstream messages are never echoed (they can carry session material), and only fixed error codes leave this module.
 * Requests go through `httpFetch` (`public`: a known service, routed by the network policy) with a 25 s timeout and no
 * redirects, so a cookie never follows a redirect.
 */
export class HeyboxHttp {
  private readonly jar = new Map<string, StoredCookie>();
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(
    cookies: readonly StoredCookie[] = [],
    private readonly options: { intervalMs?: number; onCookies?: (cookies: StoredCookie[]) => void; clock?: Clock } = {},
  ) {
    for (const cookie of cookies) if (isXiaoheiheCookie(cookie)) this.jar.set(cookie.name, { path: "/", domain: ".xiaoheihe.cn", ...cookie });
  }

  cookies(): StoredCookie[] {
    return [...this.jar.values()].map((cookie) => ({ ...cookie }));
  }

  request(path: string, request: HeyboxRequest = {}): Promise<Record<string, unknown>> {
    if (!/^\/[A-Za-z0-9_/.-]*$/.test(path) || path.startsWith("//")) throw new AppError("invalid_api_path", { effect: "none" });
    const work = this.queue.then(() => this.send(path, request));
    this.queue = work.catch(() => {});
    return work;
  }

  private async send(path: string, request: HeyboxRequest): Promise<Record<string, unknown>> {
    const clock = this.options.clock ?? systemClock();
    const wait = (this.options.intervalMs ?? 600) - (clock.now() - this.last);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const query: Record<string, string> = {
      os_type: "web",
      app: "heybox",
      client_type: "web",
      version: "999.0.4",
      web_version: "3.0",
      x_app: "heybox_website",
      x_client_type: "web",
      x_os_type: "Mac",
      ...Object.fromEntries(Object.entries(request.params ?? {}).map(([key, value]) => [key, String(value)])),
      ...signedParams(path, Math.floor(clock.now() / 1000)),
    };
    if (request.form) Object.assign(query, workshopParams(query));
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
      Origin: WEB_BASE,
      Referer: WEB_BASE + "/",
      Accept: "application/json",
    };
    if (this.jar.size) headers.Cookie = [...this.jar.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    if (request.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    this.last = clock.now();
    let response: BoundedResponse;
    try {
      response = await httpFetch(`${API_BASE}${path}?${new URLSearchParams(query)}`, {
        purpose: "public",
        method: request.form ? "POST" : "GET",
        headers,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        ...(request.form ? { body: new URLSearchParams(request.form).toString() } : {}),
      });
    } catch (error) {
      // For writes the outcome is unknown; callers must treat this as uncertain delivery.
      throw error instanceof AppError ? error : new AppError("network_failed", { effect: "unknown", cause: error });
    }
    // A rejected write may still have been applied.
    const effect = request.form ? "unknown" : "none";
    this.absorbCookies(response, clock);
    const refusal =
      response.status === 401 || response.status === 403
        ? "authentication_required"
        : response.status === 429
          ? "rate_limited"
          : !response.ok
            ? "upstream_http_error"
            : undefined;
    if (refusal) {
      await response.cancel();
      throw new AppError(refusal, { effect });
    }
    let data: unknown;
    try {
      data = JSON.parse(await response.text());
    } catch (error) {
      // A body past the size limit is the shared client's own failure; anything else is not JSON.
      if (error instanceof AppError) throw error;
      throw new AppError("invalid_upstream_response", { effect, cause: error });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new AppError("invalid_upstream_response", { effect });
    const status = (data as { status?: unknown }).status;
    if (status === "ok" || (typeof status === "string" && request.allowStatus?.includes(status))) return data as Record<string, unknown>;
    if (typeof status === "string" && AUTH_STATUSES.has(status)) throw new AppError("authentication_required", { effect });
    if (status === "show_captcha" || status === "need_captcha") throw new AppError("captcha_required", { effect });
    throw new AppError("upstream_rejected", { effect });
  }

  private absorbCookies(response: Pick<BoundedResponse, "headers">, clock: Clock): void {
    const lines = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    let changed = false;
    for (const line of lines) {
      const [pair, ...attributes] = line.split(";");
      const index = pair!.indexOf("=");
      if (index < 1) continue;
      const name = pair!.slice(0, index).trim();
      const value = pair!.slice(index + 1).trim();
      const attribute = (key: string) =>
        attributes
          .map((item) => item.trim())
          .find((item) => item.toLowerCase().startsWith(key + "="))
          ?.split("=")[1];
      const domain = attribute("domain") ?? ".xiaoheihe.cn";
      if (!isXiaoheiheCookie({ domain })) continue;
      const expired = /^(?:0|-\d+)$/.test(attribute("max-age") ?? "") || (attribute("expires") && Date.parse(attribute("expires")!) < clock.now());
      if (expired || !value) changed = this.jar.delete(name) || changed;
      else if (this.jar.get(name)?.value !== value) {
        this.jar.set(name, { name, value, domain, path: attribute("path") ?? "/", secure: attributes.some((item) => item.trim().toLowerCase() === "secure") });
        changed = true;
      }
    }
    if (changed) this.options.onCookies?.(this.cookies());
  }
}

export const isXiaoheiheCookie = (cookie: Pick<StoredCookie, "domain">) => DOMAINS.has((cookie.domain ?? ".xiaoheihe.cn").replace(/^\./, ""));

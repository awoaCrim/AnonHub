import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { Agent, ProxyAgent, type Dispatcher } from "undici";

import { AppError, isAbortError } from "./errors.js";

const DEFAULT_USER_AGENT = "Mozilla/5.0";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const UNTRUSTED_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 20_000;

const NON_PUBLIC = blockList(
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ],
  [
    ["::", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ],
);

const GLOBAL_UNICAST_V6 = blockList([], [["2000::", 3]]);

const PRIVATE = blockList(
  [
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
  ],
  [
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
  ],
);

let policy: NetworkPolicy = {};
let routed: Pick<Dispatcher, "dispatch"> | undefined;

/**
 * `model`: model services. `public`: known public services. Both follow the network policy (proxy, direct hosts).
 * `untrusted`: an address from a model or a user: https on its default port only, no local names (`localhost`, `.local`,
 * single labels), public addresses only, the resolved IP pinned for the connection, every redirect hop checked before it
 * is sent, at most 3 hops. `internal`: this machine or the private
 * network only, direct, no redirects followed.
 */
export type FetchPurpose = "model" | "public" | "untrusted" | "internal";

export interface NetworkPolicy {
  /** http(s) proxy for `model`, `public` and `untrusted` traffic. */
  readonly proxy?: string;
  /** Comma-separated hosts (`.suffix` for a domain and its subdomains) that bypass the proxy. */
  readonly directHosts?: string;
  readonly userAgent?: string;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Test seams. */
export interface HttpFetchSeams {
  readonly lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly isPublic?: (address: string) => boolean;
  /** Lets `untrusted` use plain http against a local test server. */
  readonly insecureHttp?: boolean;
}

export interface HttpFetchOptions extends Omit<RequestInit, "signal" | "redirect"> {
  readonly purpose: FetchPurpose;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects?: number;
  /**
   * What `timeoutMs` covers. `"body"` (the default): the whole exchange, body included. `"headers"`: only the wait
   * for the response headers, for a long-lived stream (server-sent events) whose reader bounds its own idle time;
   * `maxBytes` still bounds the body.
   */
  readonly deadline?: "body" | "headers";
  readonly signal?: AbortSignal;
  readonly seams?: HttpFetchSeams;
}

/** A response whose body stops with `network_response_too_large` past the limit, while it streams. */
export interface BoundedResponse {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  cancel(): Promise<void>;
}

/** The network policy; the host sets it at startup and again when `network.json` changes. */
export function configureNetwork(next: NetworkPolicy): void {
  if (next.proxy !== undefined) {
    let url: URL;
    try {
      url = new URL(next.proxy);
    } catch (error) {
      throw new AppError("network_url_invalid", { effect: "none", detail: "proxy", cause: error });
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new AppError("network_url_invalid", { effect: "none", detail: "proxy protocol" });
  }
  policy = { ...next };
  routed = undefined;
}

/** Whether an IP address is on the public internet. IPv4-mapped IPv6 addresses are judged as IPv4. */
/**
 * The proxy a request to `hostname` goes through under the policy, for a child process that makes its own requests (an
 * extension's npm install); undefined when it goes direct.
 */
export function proxyFor(hostname: string): string | undefined {
  return policy.proxy && !directHost(hostname) ? policy.proxy : undefined;
}

export function isPublicAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, "");
  const family = isIP(value);
  if (family === 4) return !NON_PUBLIC.check(value, "ipv4");
  if (family !== 6) return false;
  const mapped = mappedIPv4(value);
  if (mapped) return !NON_PUBLIC.check(mapped, "ipv4");
  return GLOBAL_UNICAST_V6.check(value, "ipv6") && !NON_PUBLIC.check(value, "ipv6");
}

/** The `fetch` handed to AI SDK providers: `purpose: "model"` routing, no size limit (responses stream). */
export function modelFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", policy.userAgent ?? DEFAULT_USER_AGENT);
  return globalThis.fetch(input, { ...init, headers, dispatcher: policyDispatcher() } as RequestInit);
}

/** The one way to make an outbound HTTP request. A timeout and a size limit are always given. */
export async function httpFetch(input: string | URL, options: HttpFetchOptions): Promise<BoundedResponse> {
  const { timeoutMs, maxBytes, deadline = "body", signal } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
  signal?.throwIfAborted();
  const headersOnly = deadline === "headers" ? headersDeadline(timeoutMs) : undefined;
  const timeout = headersOnly?.signal ?? AbortSignal.timeout(timeoutMs);
  try {
    return await exchange(input, options, timeout, headersOnly?.stop);
  } catch (error) {
    headersOnly?.stop();
    throw error;
  }
}

/** A timeout that `stop` cancels once the response headers are in. */
function headersDeadline(timeoutMs: number): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearTimeout(timer) };
}

async function exchange(
  input: string | URL,
  options: HttpFetchOptions,
  timeout: AbortSignal,
  headersArrived: (() => void) | undefined,
): Promise<BoundedResponse> {
  const { purpose, timeoutMs, maxBytes, maxRedirects, deadline: _deadline, signal, seams, ...init } = options;
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const hops = purpose === "internal" ? 0 : purpose === "untrusted" ? Math.min(maxRedirects ?? UNTRUSTED_REDIRECTS, UNTRUSTED_REDIRECTS) : (maxRedirects ?? 5);
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", policy.userAgent ?? DEFAULT_USER_AGENT);
  let url = parseUrl(input, purpose, seams);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  for (let hop = 0; ; hop++) {
    const route = await routeFor(url, purpose, seams, timeoutMs, { signal, timeout, combined });
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
        signal: combined,
        dispatcher: route.dispatcher,
      } as RequestInit);
    } catch (error) {
      await route.close();
      throw failure(error, signal, timeout);
    }
    if (REDIRECTS.has(response.status) && hops > 0) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      await route.close();
      if (!location) throw new AppError("network_failed", { effect: "unknown", detail: `redirect ${response.status} without location` });
      if (hop >= hops) throw new AppError("network_too_many_redirects", { effect: "unknown" });
      const next = parseUrl(new URL(location, url).href, purpose, seams);
      if (next.origin !== url.origin) for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      } else if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array) && !(body instanceof URLSearchParams))
        throw new AppError("network_failed", { effect: "unknown", detail: "a streamed body cannot follow a redirect" });
      url = next;
      continue;
    }
    headersArrived?.();
    return bounded(response, url.href, maxBytes, signal, timeout, route.close);
  }
}

function parseUrl(input: string | URL, purpose: FetchPurpose, seams?: HttpFetchSeams): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new AppError("network_url_invalid", { effect: "none", cause: error });
  }
  const protocols = purpose === "untrusted" && !seams?.insecureHttp ? ["https:"] : ["http:", "https:"];
  if (!protocols.includes(url.protocol)) throw new AppError("network_url_invalid", { effect: "none", detail: url.protocol });
  if (purpose === "untrusted" && (url.username || url.password)) throw new AppError("network_url_invalid", { effect: "none", detail: "credentials in URL" });
  // A local test server needs its port; everything else an untrusted address names is a web page on the default port.
  if (purpose === "untrusted" && !seams?.insecureHttp && url.port) throw new AppError("network_url_invalid", { effect: "none", detail: "port" });
  if (purpose === "untrusted" && localName(url.hostname)) throw new AppError("network_url_invalid", { effect: "none", detail: "local name" });
  return url;
}

async function routeFor(
  url: URL,
  purpose: FetchPurpose,
  seams: HttpFetchSeams | undefined,
  timeoutMs: number,
  abort: { signal: AbortSignal | undefined; timeout: AbortSignal; combined: AbortSignal },
): Promise<{ dispatcher: Pick<Dispatcher, "dispatch">; close: () => Promise<void> }> {
  if (purpose === "model" || purpose === "public") return { dispatcher: policyDispatcher(), close: async () => undefined };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly ResolvedAddress[];
  try {
    // The lookup counts against the request's deadline and stops with the caller's signal.
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await untilAborted((seams?.lookup ?? ((name) => dnsLookup(name, { all: true, verbatim: true })))(host), abort.combined);
  } catch (error) {
    if (abort.combined.aborted) {
      const stopped = failure(error, abort.signal, abort.timeout);
      // Nothing was sent yet.
      throw stopped instanceof AppError && stopped.code === "network_timeout"
        ? new AppError("network_timeout", { effect: "none", detail: host, cause: error })
        : stopped;
    }
    throw new AppError("network_dns_failed", { effect: "none", detail: host, cause: error });
  }
  if (!addresses.length) throw new AppError("network_dns_failed", { effect: "none", detail: host });
  const isPublic = seams?.isPublic ?? isPublicAddress;
  const allowed = purpose === "untrusted" ? addresses.every(({ address }) => isPublic(address)) : addresses.every(({ address }) => isPrivateAddress(address));
  if (!allowed) throw new AppError("network_destination_blocked", { effect: "none", detail: host });
  // Through a proxy the proxy resolves the name again; directly, the connection is pinned to the checked addresses, tried
  // in turn: `localhost` resolves to ::1 first on Linux while a service may listen on 127.0.0.1 alone.
  if (purpose === "untrusted" && policy.proxy && !directHost(host)) return { dispatcher: policyDispatcher(), close: async () => undefined };
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  const agent = new Agent({
    connect: {
      timeout: Math.min(timeoutMs, CONNECT_TIMEOUT_MS),
      autoSelectFamily: true,
      lookup: (_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, pinned);
        else callback(null, pinned[0]!.address, pinned[0]!.family);
      },
    } as Agent.Options["connect"],
  });
  return { dispatcher: agent, close: () => agent.destroy().catch(() => undefined) };
}

function bounded(
  response: Response,
  url: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
  timeout: AbortSignal,
  close: () => Promise<void>,
): BoundedResponse {
  const declared = Number(response.headers.get("content-length"));
  let body: ReadableStream<Uint8Array> | null = null;
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    void close();
    throw new AppError("network_response_too_large", { effect: "unknown" });
  }
  if (response.body) {
    const reader = response.body.getReader();
    let total = 0;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      void close();
    };
    body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          finish();
          controller.error(failure(error, signal, timeout));
          return;
        }
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          finish();
          controller.error(new AppError("network_response_too_large", { effect: "unknown" }));
          return;
        }
        controller.enqueue(chunk.value);
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
        finish();
      },
    });
  } else void close();
  const stream = body;
  const bytes = async (): Promise<Uint8Array> => {
    if (!stream) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  };
  return {
    url,
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body: stream,
    bytes,
    text: async () => new TextDecoder().decode(await bytes()),
    json: async () => {
      const text = new TextDecoder().decode(await bytes());
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new AppError("network_failed", { effect: "done", detail: "response is not JSON", cause: error });
      }
    },
    cancel: async () => {
      await stream?.cancel().catch(() => undefined);
    },
  };
}

function failure(error: unknown, signal: AbortSignal | undefined, timeout: AbortSignal): unknown {
  if (error instanceof AppError) return error;
  if (signal?.aborted) return signal.reason ?? error;
  if (timeout.aborted) return new AppError("network_timeout", { effect: "unknown", cause: error });
  if (isAbortError(error)) return error;
  return new AppError("network_failed", { effect: "unknown", cause: error });
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

function policyDispatcher(): Pick<Dispatcher, "dispatch"> {
  if (routed) return routed;
  const direct = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });
  if (!policy.proxy) return (routed = direct);
  // ProxyAgent times the proxy socket and the tunnelled TLS handshake separately (10 s each by default).
  const viaProxy = new ProxyAgent({ uri: policy.proxy, proxyTls: { timeout: CONNECT_TIMEOUT_MS }, requestTls: { timeout: CONNECT_TIMEOUT_MS } });
  routed = {
    // Every dispatch is routed, redirects included, so an external redirect cannot proxy an internal service.
    dispatch(options, handler) {
      return (directHost(new URL(String(options.origin)).hostname) ? direct : viaProxy).dispatch(options, handler);
    },
  };
  return routed;
}

function directHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (localName(host)) return true;
  if (isIP(host) && !isPublicAddress(host)) return true;
  return (policy.directHosts ?? "").split(",").some((entry) => {
    const rule = entry.trim().toLowerCase();
    return !!rule && (host === rule || (rule.startsWith(".") && (host === rule.slice(1) || host.endsWith(rule))));
  });
}

/** A name only this machine or its network resolves: `localhost`, mDNS `.local`, a single label such as a container name. */
function localName(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || (!host.includes(".") && !isIP(host));
}

function isPrivateAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, "");
  const family = isIP(value);
  if (family === 4) return PRIVATE.check(value, "ipv4");
  if (family !== 6) return false;
  const mapped = mappedIPv4(value);
  return mapped ? PRIVATE.check(mapped, "ipv4") : PRIVATE.check(value, "ipv6");
}

/** `::ffff:a.b.c.d` (in any spelling) as `a.b.c.d`. */
function mappedIPv4(address: string): string | undefined {
  const groups = expandIPv6(address);
  if (!groups || groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) return undefined;
  return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
}

function expandIPv6(address: string): number[] | undefined {
  let text = address.split("%")[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    text = text.slice(0, -dotted[1]!.length) + `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = text.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: fill }, () => "0"), ...right].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

function blockList(ipv4: ReadonlyArray<readonly [string, number]>, ipv6: ReadonlyArray<readonly [string, number]>): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of ipv4) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of ipv6) list.addSubnet(network, prefix, "ipv6");
  return list;
}

import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import { contentHash } from "@yesimbot/foundation";
import WebSocket from "ws";

import { memberId } from "./accounts.js";
import type { AdminAuth } from "./admin-auth.js";
import type { Host, HttpContext } from "./host.js";
import type { TenantManagerClient } from "./tenant-manager-client.js";

const blockedHeaders =
  /^(cookie|authorization|proxy-authorization|host|connection|upgrade|keep-alive|te|trailer|transfer-encoding|set-cookie|forwarded|x-forwarded-.*|x-real-ip|x-yesimbot-.*|x-internal-.*)$/i;

export type DesktopRelay = (socket: WebSocket, request: IncomingMessage) => Promise<boolean>;

export function relayHeaders(source: IncomingHttpHeaders): Record<string, string | string[]> {
  const target: Record<string, string | string[]> = {};
  const connection = String(source.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((x) => x.trim());
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && !blockedHeaders.test(key) && !connection.includes(key.toLowerCase())) target[key] = value;
  return target;
}

/** Pinned @cordisjs/plugin-server adapter: runs before router body parsing. */
export function installTenantRuntimeProxy(ctx: Host, auth: AdminAuth, manager: TenantManagerClient, ownerRuntimeId?: string) {
  if (ownerRuntimeId !== undefined && !memberId.test(ownerRuntimeId)) throw new Error("invalid_owner_runtime_id");
  const selectedRuntime = (session: ReturnType<AdminAuth["sessionFromCookie"]>) =>
    session?.role === "member" ? session.accountId : session ? ownerRuntimeId : undefined;
  const reserved = (path: string) =>
    /^\/yesimbot\/admin(?:\/|$)/.test(path) ||
    path === "/yesimbot/account" ||
    /^\/yesimbot\/account\/runtime(?:\/|$)/.test(path) ||
    path === "/yesimbot/api/v1/bootstrap" ||
    path === "/yesimbot/accounts";
  const bootstrap = (path: string) =>
    path === "/" ||
    path === "/yesimbot" ||
    path === "/yesimbot/login" ||
    /^\/(?:client|element|index|vue-router|vue|vueuse)\.js$/.test(path) ||
    path === "/style.css" ||
    path === "/logo.png" ||
    /^\/(?:@|assets\/|vite\/)/.test(path);
  const middleware = async (http: HttpContext, next: () => Promise<unknown>) => {
    if (ownerRuntimeId && /^\/yesimbot\/hooks\/[0-9a-f-]{36}\/[a-f0-9]{64}$/.test(http.path)) {
      if (http.method !== "POST") {
        http.status = 404;
        return;
      }
      try {
        if ((await manager.runtime(ownerRuntimeId)).state !== "running") {
          http.status = 503;
          return;
        }
        await relay(http, manager, ownerRuntimeId, http.path, () => true);
      } catch {
        http.status = 503;
        http.body = { message: "runtime_unavailable" };
      }
      return;
    }
    // A public capability URL has no browser session. The child verifies its own
    // hook token; never expose an arbitrary tenant relay path here.
    const hook = /^\/yesimbot\/hooks\/tenant\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([a-f0-9]{64})$/.exec(http.path);
    if (hook) {
      if (http.method !== "POST" || !memberId.test(hook[1])) {
        http.status = 404;
        return;
      }
      try {
        if ((await manager.runtime(hook[1])).state !== "running") {
          http.status = 503;
          return;
        }
        await relay(http, manager, hook[1], `/yesimbot/hooks/${hook[2]}/${hook[3]}`, () => true);
      } catch {
        http.status = 503;
        http.body = { message: "runtime_unavailable" };
      }
      return;
    }
    const cookie = http.get("cookie"),
      session = auth.sessionFromCookie(cookie);
    if (session?.role === "member") http.set("Cache-Control", "private, no-store");
    if (reserved(http.path)) {
      await next();
      if (session?.role === "member") http.set("Cache-Control", "private, no-store");
      return;
    }
    if (http.path.startsWith("/yesimbot/tenant-assets/")) {
      const asset = tenantAssetPath(http.path);
      if (!asset || !["GET", "HEAD"].includes(http.method)) {
        http.status = 404;
        return;
      }
      // A migrated owner may retain tenant-scoped asset URLs while running here.
      if (!ownerRuntimeId && asset.id === (await ctx.yesimbot.identity.tenantId())) return next();
      try {
        if ((await manager.runtime(asset.id)).state !== "running") {
          http.status = 404;
          return;
        }
        await relay(http, manager, asset.id, asset.path, () => true);
      } catch {
        http.status = 503;
        http.body = { message: "runtime_unavailable" };
      }
      return;
    }
    if (!session && /(?:^|;)\s*yesimbot_admin=/.test(cookie) && !bootstrap(http.path)) {
      http.set("Cache-Control", "private, no-store");
      http.status = 401;
      http.body = { message: "Login required." };
      return;
    }
    const runtimeId = selectedRuntime(session);
    if (!runtimeId) return next();
    if (session?.role !== "member" && http.path === "/yesimbot/api/v1/features") return next();
    // Cloud ownership/account administration stays local; the owner's bot data follows its runtime.
    if (session?.role !== "member" && !http.path.startsWith("/yesimbot/api/v1/") && !http.path.startsWith("/yesimbot/model-settings")) return next();
    http.set("Cache-Control", "private, no-store");
    // The child's router matches paths case-insensitively and with a trailing slash.
    const chatRead =
      /^\/yesimbot\/api\/v1\/chat(?:\/|$)/i.test(http.path) ||
      (/^\/yesimbot\/api\/v1\/events\/?$/i.test(http.path) &&
        String(http.query.topics ?? "")
          .split(",")
          .some((topic) => topic.trim() === "chat"));
    if (
      !auth.sameOrigin(http) &&
      (!["GET", "HEAD", "OPTIONS"].includes(http.method) || (chatRead && (http.get("origin") || http.get("sec-fetch-site") === "cross-site")))
    ) {
      http.status = 403;
      http.body = { message: "same_origin_required" };
      return;
    }
    let runtime;
    try {
      runtime = await manager.runtime(runtimeId);
    } catch {
      if (bootstrap(http.path)) return next();
      http.status = 503;
      http.body = { message: "manager_unavailable" };
      return;
    }
    if (runtime.state !== "running") {
      if (bootstrap(http.path)) return next();
      http.status = 503;
      http.body = { message: "runtime_not_ready" };
      return;
    }
    if (auth.sessionFromCookie(cookie) !== session) {
      http.status = 401;
      return;
    }
    const original = http.originalUrl;
    if (!safeRelayPath(original)) {
      http.status = 400;
      return;
    }
    try {
      await relay(
        http,
        manager,
        runtimeId,
        original,
        () => auth.sessionFromCookie(cookie) === session,
        (check) => auth.onRevocation(check),
        true,
        session?.username,
        contentHash(cookie),
      );
    } catch {
      http.status = 503;
      http.body = { message: "runtime_unavailable" };
    }
  };
  const removeMiddleware = ctx.server.prepend(middleware);
  const bridges = new Set<() => void>();
  const revoke = () => {
    for (const check of bridges) check();
  };
  const unsubscribe = auth.onRevocation(revoke);
  const bridge = async (socket: WebSocket, request: IncomingMessage, desktop = false) => {
    const cookie = request.headers.cookie ?? "";
    const session = auth.sessionFromCookie(cookie);
    const origin = request.headers.origin ?? "";
    const runtimeId = selectedRuntime(session);
    const valid = () => !!runtimeId && auth.sessionFromCookie(cookie) === session && socket.readyState === WebSocket.OPEN;
    const originHttp = {
      get: (key: string) => (key === "origin" ? origin : String(request.headers[key] ?? "")),
      origin: `${(request.socket as { encrypted?: boolean }).encrypted ? "https" : "http"}://${request.headers.host}`,
    };
    if (!valid() || !auth.sameOrigin(originHttp as Parameters<AdminAuth["sameOrigin"]>[0])) {
      socket.close(1008);
      return;
    }
    // Buffer browser frames until the authenticated upstream handshake is ready.
    // The browser connection can open before runtime/key lookups finish.
    socket.pause();
    let upstream: WebSocket | undefined;
    const close = () => {
      socket.close(1008);
      upstream?.close(1008);
    };
    const check = () => {
      if (!valid()) close();
    };
    bridges.add(check);
    const timer = setInterval(check, 1000);
    socket.on("close", () => {
      clearInterval(timer);
      bridges.delete(check);
      upstream?.close();
    });
    try {
      if ((await manager.runtime(runtimeId!)).state !== "running" || !valid()) {
        close();
        return;
      }
      const url = new URL(manager.path(runtimeId!, desktop ? "/desktop" : "/ws"), manager.endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      upstream = new WebSocket(url, {
        headers: { ...(await manager.headers()), ...(desktop ? { "x-yesimbot-control-login": contentHash(cookie) } : {}) },
        maxPayload: 1024 * 1024,
        handshakeTimeout: 10000,
        perMessageDeflate: false,
        followRedirects: false,
        rejectUnauthorized: true,
      });
      upstream.on("open", () => {
        if (valid()) socket.resume();
        else close();
      });
      upstream.on("error", close);
      upstream.on("close", () => socket.close());
      const forward = (destination: WebSocket, data: WebSocket.RawData, binary: boolean) => {
        if (
          !valid() ||
          (Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length) >
            1024 * 1024 ||
          destination.bufferedAmount > 1024 * 1024 ||
          destination.readyState !== WebSocket.OPEN
        ) {
          close();
          return;
        }
        destination.send(data, { binary });
      };
      socket.on("message", (data, binary) => forward(upstream!, data, binary));
      upstream.on("message", (data, binary) => forward(socket, data, binary));
    } catch {
      close();
    }
  };
  ctx.server.ws("/yesimbot/runtime/status", (socket, request) => bridge(socket, request));
  ctx.on("dispose", () => {
    removeMiddleware();
    unsubscribe();
    auth.clear();
    for (const check of bridges) check();
  });
  return (async (socket, request) => {
    if (!selectedRuntime(auth.sessionFromCookie(request.headers.cookie ?? ""))) return false;
    await bridge(socket, request, true);
    return true;
  }) satisfies DesktopRelay;
}

/** Public asset exception: UUID plus exactly one content-addressed filename. */
export function tenantAssetPath(path: string): { id: string; path: string } | undefined {
  const match = /^\/yesimbot\/tenant-assets\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match || !memberId.test(match[1])) return;
  let filename: string;
  try {
    filename = decodeURIComponent(match[2]);
  } catch {
    return;
  }
  // Control characters are deliberately forbidden in decoded asset filenames.
  // oxlint-disable-next-line no-control-regex
  if (filename.length > 240 || !/^[a-f0-9]{40}(?:[.-][^/\\%\x00-\x1f\x7f]{1,199})?$/.test(filename) || filename.includes("..")) return;
  return { id: match[1], path: `/yesimbot/tenant-assets/${match[1]}/${encodeURIComponent(filename)}` };
}

/** Reject path normalization before combining the request with a capability-bearing UUID prefix. */
function safeRelayPath(original: string): boolean {
  if (!original.startsWith("/") || original.startsWith("//") || /[\\\r\n]/.test(original)) return false;
  // Queries can contain arbitrary URLs; only path segments participate in traversal.
  for (let segment of original.split("?", 1)[0].split("/")) {
    while (true) {
      if (
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        Array.from(segment).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      )
        return false;
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return false;
      }
      if (decoded === segment) break;
      // Each decode shortens an encoded segment; nested encodings cannot loop.
      segment = decoded;
    }
  }
  return true;
}

async function relay(
  http: HttpContext,
  manager: TenantManagerClient,
  id: string,
  original: string,
  valid: () => boolean,
  onRevocation?: (check: () => void) => () => unknown,
  retryRead = true,
  username?: string,
  controlLogin?: string,
) {
  const url = new URL(manager.path(id, `/http${original}`), manager.endpoint);
  const headers = { ...relayHeaders(http.req.headers), ...(await manager.headers()) };
  if (username && original.split("?", 1)[0] === "/yesimbot/api/v1/chat/send")
    Object.assign(headers, { "x-yesimbot-chat-name": Buffer.from(username).toString("base64url") });
  if (controlLogin && original.split("?", 1)[0] === "/yesimbot/api/v1/devices/control") Object.assign(headers, { "x-yesimbot-control-login": controlLogin });
  if (!valid()) {
    http.status = 401;
    return;
  }
  let refreshBackendSession = false;
  await new Promise<void>((resolve) => {
    let responseStream: import("node:http").IncomingMessage | undefined;
    const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: http.method, headers }, (response) => {
      responseStream = response;
      if (!valid()) {
        response.destroy();
        http.status = 401;
        resolve();
        return;
      }
      // A supervised local restart expires only the child's cookie. The manager
      // discards that cookie on 401; retry a bodyless read without logging out the owner.
      if (
        response.statusCode === 401 &&
        retryRead &&
        ["GET", "HEAD"].includes(http.method) &&
        !http.req.headers["content-length"] &&
        !http.req.headers["transfer-encoding"]
      ) {
        refreshBackendSession = true;
        response.resume();
        resolve();
        return;
      }
      http.status = response.statusCode ?? 502;
      for (const [key, value] of Object.entries(relayHeaders(response.headers))) http.set(key, value);
      http.set("Cache-Control", "private, no-store");
      http.body = response;
      resolve();
    });
    const check = () => {
      if (!valid()) {
        upstream.destroy();
        responseStream?.destroy();
        if (http.res.headersSent) http.res.destroy();
      }
    };
    const unsubscribe = onRevocation?.(check);
    const timer = onRevocation ? setInterval(check, 1000) : undefined;
    timer?.unref();
    const cleanup = () => {
      if (timer) clearInterval(timer);
      unsubscribe?.();
    };
    upstream.once("close", cleanup);
    http.res.once("close", () => {
      cleanup();
      upstream.destroy();
      responseStream?.destroy();
    });
    upstream.setTimeout(30000, () => upstream.destroy());
    upstream.on("error", () => {
      http.status = 502;
      http.body = { message: "runtime_unavailable" };
      resolve();
    });
    http.req.once("aborted", () => upstream.destroy());
    if (!retryRead && ["GET", "HEAD"].includes(http.method)) upstream.end();
    else http.req.pipe(upstream);
  });
  if (refreshBackendSession) await relay(http, manager, id, original, valid, onRevocation, false, username, controlLogin);
}

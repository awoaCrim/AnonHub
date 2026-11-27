import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { Context as HttpContext } from "koa";
import { afterEach, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ calls: [] as Array<{ url: string; headers: Record<string, string>; stream: PassThrough }> }));
vi.mock("node:http", async (original) => ({
  ...(await original<object>()),
  request: (url: URL, options: { headers: Record<string, string> }, callback: (response: PassThrough) => void) => {
    const stream = new PassThrough();
    Object.assign(stream, { setTimeout: vi.fn() });
    network.calls.push({ url: String(url), headers: options.headers, stream });
    stream.on("finish", () => {
      const response = new PassThrough();
      Object.assign(response, { statusCode: 202, headers: {} });
      callback(response);
      response.end(JSON.stringify({ messageId: "accepted-by-child" }));
    });
    return stream;
  },
}));

import { installTenantRuntimeProxy } from "../src/tenant-runtime-proxy.js";

/** Koishi's server prepends middleware ahead of the router; the host exposes that as `prepend`. */
const prependTo = (list: unknown[]) => (middleware: unknown) => {
  list.unshift(middleware);
  return () => {
    const index = list.indexOf(middleware);
    if (index >= 0) list.splice(index, 1);
  };
};

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const call of network.calls.splice(0)) call.stream.destroy();
  for (const dispose of disposals.splice(0)) dispose();
});

it("selects each member's child for chat HTTP and SSE without trusting URL/header identity", async () => {
  const alice = { role: "member", accountId: "11111111-1111-4111-8111-111111111111", username: "alice" };
  const bob = { role: "member", accountId: "22222222-2222-4222-8222-222222222222", username: "bob" };
  let active: typeof alice | undefined = alice;
  let running = true;
  const auth = {
    sessionFromCookie: () => active,
    sameOrigin: (http: { get(name: string): string }) => http.get("origin") === "https://console.test",
    onRevocation: () => () => {},
    clear: vi.fn(),
  };
  const manager = {
    endpoint: new URL("http://manager.test"),
    runtime: vi.fn(async () => ({ state: running ? "running" : "stopped" })),
    path: (id: string, suffix: string) => `/v1/runtimes/${id}${suffix}`,
    headers: async () => ({ Authorization: "Bearer server-only" }),
  };
  const middleware: Array<(http: HttpContext, next: () => void) => Promise<void>> = [];
  installTenantRuntimeProxy(
    { server: { prepend: prependTo(middleware), ws: vi.fn() }, on: (_event: string, callback: () => void) => disposals.push(callback) } as never,
    auth as never,
    manager as never,
  );
  const invoke = async (path: string, method: string, origin = "https://console.test") => {
    const headers = { cookie: "parent-cookie", authorization: "browser-token", origin, "x-yesimbot-chat-name": "forged", "x-yesimbot-chat-proof": "forged" };
    const req = new PassThrough();
    Object.assign(req, { headers });
    req.end(method === "POST" ? '{"text":"private"}' : undefined);
    const res = new EventEmitter();
    Object.assign(res, { headersSent: false });
    const http = {
      path,
      originalUrl: `${path}?accountId=${bob.accountId}`,
      method,
      req,
      res,
      query: { topics: "chat" },
      get: (name: string) => headers[name as keyof typeof headers] ?? "",
      set: vi.fn(),
      status: 200,
      body: undefined as unknown,
    };
    const next = vi.fn();
    await middleware[0](http as never, next);
    return { http, next };
  };
  for (const member of [alice, bob]) {
    active = member;
    for (const [path, method] of [
      ["/yesimbot/api/v1/chat/send", "POST"],
      ["/yesimbot/api/v1/chat", "GET"],
      ["/yesimbot/api/v1/events", "GET"],
    ]) {
      const { http, next } = await invoke(path, method);
      expect(next).not.toHaveBeenCalled();
      expect(http.status).toBe(202);
      const call = network.calls.at(-1)!;
      expect(call.url).toContain(`/v1/runtimes/${member.accountId}/http${path}`);
      expect(call.headers.cookie).toBeUndefined();
      expect(call.headers.authorization).toBeUndefined();
      expect(call.headers["x-yesimbot-chat-proof"]).toBeUndefined();
      expect(call.headers["x-yesimbot-chat-name"]).toBe(method === "POST" ? Buffer.from(member.username).toString("base64url") : undefined);
      http.res.emit("close");
    }
  }
  const count = network.calls.length;
  for (const path of ["/yesimbot/api/v1/chat", "/YesImBot/API/v1/Chat", "/yesimbot/api/v1/events/", "/yesimbot/api/v1/EVENTS"])
    expect((await invoke(path, "GET", "https://foreign.test")).http.status).toBe(403);
  running = false;
  const stopped = await invoke("/yesimbot/api/v1/chat/send", "POST");
  expect(stopped.http.status).toBe(503);
  expect(stopped.next).not.toHaveBeenCalled();
  expect(network.calls).toHaveLength(count);
  expect((await invoke("/yesimbot/admin/accounts", "GET")).next).toHaveBeenCalledOnce();
});

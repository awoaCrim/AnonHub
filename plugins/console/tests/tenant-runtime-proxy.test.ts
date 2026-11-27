import { createHash, scryptSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Koa from "koa";
import { afterEach, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { AccountStore } from "../src/accounts.js";
import { AdminAuth } from "../src/admin-auth.js";
import { TenantManagerClient } from "../src/tenant-manager-client.js";
import { tenantAssetPath, installTenantRuntimeProxy } from "../src/tenant-runtime-proxy.js";

/** Koishi's server prepends middleware ahead of the router; the host exposes that as `prepend`. */
const prependTo = (list: unknown[]) => (middleware: unknown) => {
  list.unshift(middleware);
  return () => {
    const index = list.indexOf(middleware);
    if (index >= 0) list.splice(index, 1);
  };
};

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(localOwner = false) {
  const dir = await mkdtemp(join(tmpdir(), "yesimbot-relay-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const key = "a".repeat(64);
  await writeFile(join(dir, "key"), key, { mode: 0o600 });
  const salt = Buffer.alloc(16, 1),
    credentialFile = join(dir, "owner.json");
  await writeFile(
    credentialFile,
    JSON.stringify({ version: 1, username: "owner", salt: salt.toString("base64"), hash: scryptSync("owner-password-123", salt, 64).toString("base64") }),
  );
  const auth = new AdminAuth({ enabled: true, credentialFile, sessionHours: 1, publicOrigin: "http://console.test" }, credentialFile);
  const store = new AccountStore(join(dir, "accounts"), async () => "owner");
  await store.ready;
  auth.accounts = store;
  const a = await store.create("alice", "alice-password-123"),
    b = await store.create("bob", "bob-password-123");
  const cookie = `yesimbot_admin=${await auth.login("alice", "alice-password-123")}`;
  const requests: { url: string; cookie?: string; authorization?: string; body: string; chatName?: string; chatProof?: string; controlLogin?: string }[] = [];
  let available = true;
  let unauthorizedReads = 0;
  const managerServer = createServer(async (req, res) => {
    if (!available) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === `/v1/runtimes/${a.id}` || req.url === `/v1/runtimes/${b.id}`) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ runtime: { id: req.url.split("/").at(-1), state: "running" } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      url: req.url!,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
      chatName: req.headers["x-yesimbot-chat-name"] as string,
      chatProof: req.headers["x-yesimbot-chat-proof"] as string,
      controlLogin: req.headers["x-yesimbot-control-login"] as string,
    });
    if (unauthorizedReads-- > 0) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url?.endsWith("/http/stream")) {
      res.writeHead(200);
      res.write("initial-private-chunk");
      return;
    }
    res.setHeader("Set-Cookie", "child-secret=never-browser");
    res.end(`tenant:${req.url}`);
  });
  const managerUrl = await listen(managerServer);
  const managerWS = new WebSocketServer({ server: managerServer });
  cleanup.push(async () => {
    for (const ws of managerWS.clients) ws.terminate();
    managerWS.close();
  });
  const wsRoutes: string[] = [];
  managerWS.on("connection", (socket, req) => {
    wsRoutes.push(req.url!);
    if (req.headers.authorization !== `Bearer ${key}` || req.headers.cookie) {
      socket.close();
      return;
    }
    socket.on("message", (data) => socket.send(data));
  });
  const app = new Koa(),
    disposals: Function[] = [],
    handlers: Record<string, Function> = {};
  app.use(async (http) => {
    http.body = `owner:${http.path}`;
  });
  const ctx = {
    yesimbot: { identity: { tenantId: async () => "d8dd3bbd-2214-44e0-abe2-336212d6671b" } },
    // The host's prepend puts the middleware ahead of Koa's router, as Koishi's server does.
    server: { prepend: prependTo(app.middleware), ws: (path: string, handler: Function) => (handlers[path] = handler) },
    on: (event: string, cb: Function) => {
      if (event === "dispose") disposals.push(cb);
    },
  };
  // The pinned server composes callback() before plugins install middleware.
  const server = createServer(app.callback());
  const desktopRelay = installTenantRuntimeProxy(ctx as never, auth, new TenantManagerClient(managerUrl, join(dir, "key")), localOwner ? a.id : undefined);
  handlers["/yesimbot/api/v1/devices/desktop"] = (socket: WebSocket, request: IncomingMessage) => desktopRelay(socket, request);
  const parentUrl = await listen(server);
  const parentWS = new WebSocketServer({ server });
  cleanup.push(async () => {
    for (const ws of parentWS.clients) ws.terminate();
    parentWS.close();
  });
  parentWS.on("connection", (socket, req) => {
    const handler = handlers[req.url!];
    if (handler) handler(socket, req);
    else socket.close();
  });
  cleanup.push(async () => {
    for (const dispose of disposals) dispose();
  });
  return {
    auth,
    store,
    a,
    b,
    cookie,
    requests,
    wsRoutes,
    parentUrl,
    app,
    setAvailable: (v: boolean) => (available = v),
    expireBackendSession: () => {
      unauthorizedReads = 1;
    },
  };
}
it("routes web chat and its topic to each member's child and replaces forged browser identity", async () => {
  const f = await fixture();
  const bobCookie = `yesimbot_admin=${await f.auth.login("bob", "bob-password-123")}`;
  for (const [cookie, id, name] of [
    [f.cookie, f.a.id, "alice"],
    [bobCookie, f.b.id, "bob"],
  ]) {
    const body = JSON.stringify({ text: "private", clientId: "11111111-1111-4111-8111-111111111111" });
    const response = await fetch(`${f.parentUrl}/yesimbot/api/v1/chat/send?accountId=${f.b.id}`, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://console.test",
        "x-yesimbot-chat-name": "forged",
        "x-yesimbot-chat-proof": "forged",
        "content-type": "application/json",
      },
      body,
    });
    expect(await response.text()).toContain(`/v1/runtimes/${id}/http/yesimbot/api/v1/chat/send`);
    expect(f.requests.at(-1)).toMatchObject({ body, chatName: Buffer.from(name).toString("base64url"), chatProof: undefined, cookie: undefined });
    for (const path of ["/yesimbot/api/v1/chat", "/yesimbot/api/v1/events?topics=chat"]) {
      expect(await (await fetch(f.parentUrl + path, { headers: { cookie } })).text()).toContain(`/v1/runtimes/${id}/http${path}`);
      expect((await fetch(f.parentUrl + path, { headers: { cookie, origin: "http://foreign.test" } })).status).toBe(403);
    }
  }
  f.setAvailable(false);
  expect((await fetch(f.parentUrl + "/yesimbot/api/v1/chat", { headers: { cookie: f.cookie } })).status).toBe(503);
});
it("recovers a child login after a local restart only for bodyless reads, without replaying mutations", async () => {
  const f = await fixture(true);
  const cookie = `yesimbot_admin=${await f.auth.login("owner", "owner-password-123")}`;
  f.expireBackendSession();
  expect((await fetch(f.parentUrl + "/yesimbot/api/v1/bot/summary", { headers: { cookie } })).status).toBe(200);
  expect(f.requests).toHaveLength(2);
  expect(f.auth.sessionFromCookie(cookie)?.role).toBe("owner");
  f.expireBackendSession();
  expect(
    (await fetch(f.parentUrl + "/yesimbot/api/v1/schedules/update", { method: "POST", headers: { cookie, origin: "http://console.test" }, body: "{}" })).status,
  ).toBe(401);
  expect(f.requests).toHaveLength(3);
});
it("routes the owner's bot to its configured local instance while keeping account administration on the server", async () => {
  const f = await fixture(true);
  const cookie = `yesimbot_admin=${await f.auth.login("owner", "owner-password-123")}`;
  const bot = await fetch(`${f.parentUrl}/yesimbot/api/v1/bot/summary?accountId=${f.b.id}`, { headers: { cookie } });
  expect(await bot.text()).toContain(`/v1/runtimes/${f.a.id}/http/yesimbot/api/v1/bot/summary`);
  expect(f.requests.at(-1)?.cookie).toBeUndefined();
  const admin = await fetch(`${f.parentUrl}/yesimbot/admin/context-policy`, { headers: { cookie } });
  expect(await admin.text()).toBe("owner:/yesimbot/admin/context-policy");
  f.setAvailable(false);
  expect((await fetch(`${f.parentUrl}/yesimbot/api/v1/bot/summary`, { headers: { cookie } })).status).toBe(503);
});
it("selects session identity for streamed HTTP; strips cookies/capability responses and never falls back on manager failure", async () => {
  const f = await fixture();
  const response = await fetch(`${f.parentUrl}/configuration?accountId=${f.b.id}&target=http://owner/`, {
    method: "POST",
    headers: { Cookie: f.cookie, Authorization: "browser-secret", Origin: "http://console.test", "Content-Type": "application/octet-stream" },
    body: "raw\u0000upload",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.text()).toContain(`/v1/runtimes/${f.a.id}/http/configuration`);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ cookie: undefined, authorization: `Bearer ${"a".repeat(64)}`, body: "raw\u0000upload" });
  const reserved = await fetch(`${f.parentUrl}/yesimbot/account`, { headers: { Cookie: f.cookie } });
  expect(await reserved.text()).toBe("owner:/yesimbot/account");
  f.setAvailable(false);
  const failed = await fetch(`${f.parentUrl}/configuration`, { headers: { Cookie: f.cookie } });
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("owner:");
});
it("routes a member's archive to its own runtime even with a foreign target query or header", async () => {
  const f = await fixture();
  const payload = { channel: "qq-room", session: "20261103.jsonl" };
  const response = await fetch(`${f.parentUrl}/yesimbot/api/v1/conversations/archive?accountId=${f.b.id}`, {
    method: "POST",
    headers: { Cookie: f.cookie, Origin: "http://console.test", "Content-Type": "application/json", "x-yesimbot-tenant-id": f.b.id },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`/v1/runtimes/${f.a.id}/http/yesimbot/api/v1/conversations/archive`);
  expect(f.requests).toHaveLength(1);
  expect(JSON.parse(f.requests[0].body)).toEqual(payload);
});
it("routes all scheduled tasks to the authenticated member's own runtime", async () => {
  const f = await fixture();
  const response = await fetch(`${f.parentUrl}/yesimbot/api/v1/schedules?accountId=${f.b.id}`, {
    headers: { Cookie: f.cookie, "x-yesimbot-tenant-id": f.b.id },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`/v1/runtimes/${f.a.id}/http/yesimbot/api/v1/schedules`);
  expect(f.requests).toHaveLength(1);
});
it("rejects cross-origin writes and unvalidated assets and disposes its exact middleware", async () => {
  const f = await fixture();
  const response = await fetch(`${f.parentUrl}/configuration`, { method: "POST", headers: { Cookie: f.cookie, Origin: "http://attacker.test" }, body: "bad" });
  expect(response.status).toBe(403);
  expect(f.requests).toHaveLength(0);
  expect((await fetch(`${f.parentUrl}/yesimbot/tenant-assets/not-a-uuid/private`)).status).toBe(404);
  expect((await fetch(`${f.parentUrl}/yesimbot/tenant-assets/${f.a.id}/bad`)).status).toBe(404);
});
it("bridges only a member session to its fixed runtime and immediately closes on revocation", async () => {
  const f = await fixture();
  const ws = new WebSocket(f.parentUrl.replace("http:", "ws:") + "/yesimbot/runtime/status", { headers: { Cookie: f.cookie, Origin: "http://console.test" } });
  cleanup.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const message = new Promise((resolve) => ws.once("message", (data) => resolve(data.toString())));
  ws.send("only-alice");
  expect(await message).toBe("only-alice");
  const closed = new Promise((resolve) => ws.once("close", resolve));
  authRevoke();
  await closed;
  expect(ws.readyState).toBe(WebSocket.CLOSED);
  function authRevoke() {
    f.auth.revokeAccount(f.a.id);
  }
});

it("serves only UUID-scoped hash assets including named Unicode files through the matching runtime", async () => {
  const f = await fixture();
  const hash = "1".repeat(40),
    filename = hash + "-截图.png";
  const path = `/yesimbot/tenant-assets/${f.b.id}/${encodeURIComponent(filename)}`;
  expect(tenantAssetPath(path)).toEqual({ id: f.b.id, path });
  const response = await fetch(f.parentUrl + path);
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.text()).toContain(`/v1/runtimes/${f.b.id}/http${path}`);
  for (const name of ["private", hash + "-%2fsecret", hash + "-%252fsecret", hash + "-..", hash + "-%00.png", hash + "-%5cprivate"]) {
    expect(tenantAssetPath(`/yesimbot/tenant-assets/${f.a.id}/${name}`)).toBeUndefined();
  }
  const write = await fetch(f.parentUrl + path, { method: "POST", body: "forbidden" });
  expect(write.status).toBe(404);
});

it("keeps the migrated owner's tenant asset URLs local without querying the runtime manager", async () => {
  const f = await fixture();
  const path = `/yesimbot/tenant-assets/d8dd3bbd-2214-44e0-abe2-336212d6671b/${"a".repeat(40)}.png`;
  const response = await fetch(f.parentUrl + path);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(`owner:${path}`);
});

it("expired or revoked member cookies cannot fall through to parent private handlers", async () => {
  const f = await fixture();
  f.auth.revokeAccount(f.a.id);
  const response = await fetch(f.parentUrl + "/configuration", { headers: { Cookie: f.cookie } });
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("owner:");
  const portal = await fetch(f.parentUrl + "/yesimbot/account", { headers: { Cookie: f.cookie } });
  expect(await portal.text()).toBe("owner:/yesimbot/account");
});

it("revocation terminates an already-streaming member HTTP response", async () => {
  const f = await fixture();
  const response = await fetch(f.parentUrl + "/stream", { headers: { Cookie: f.cookie } });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("initial-private-chunk");
  const pending = reader.read();
  f.auth.revokeAccount(f.a.id);
  await expect(pending).rejects.toThrow();
});

it("rejects raw and encoded traversal before URL normalization can escape the session runtime", async () => {
  const f = await fixture();
  const target = new URL(f.parentUrl);
  const raw = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: target.hostname, port: target.port, path, headers: { Cookie: f.cookie } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end();
    });
  for (const path of [
    `/../../${f.b.id}/http/private`,
    `/%2e%2e/%2E%2e/${f.b.id}/http/private`,
    `/.%2e/%2e./${f.b.id}/http/private`,
    `/%252e%252e/%252e%252e/${f.b.id}/http/private`,
    `/safe%2f..%2f../${f.b.id}/http/private`,
    `/safe%252f..%252f../${f.b.id}/http/private`,
    `/safe%5c..%5c../${f.b.id}/http/private`,
    `/safe%255c..%255c../${f.b.id}/http/private`,
  ]) {
    expect((await raw(path)).status).toBe(400);
  }
  expect(f.requests).toHaveLength(0);
  const query = "/configuration?source=https://example.test/a/../b&next=%2F..%2F&encoded=%252e%252e";
  const accepted = await raw(query);
  expect(accepted.status).toBe(200);
  expect(f.requests.at(-1)?.url).toBe(`/v1/runtimes/${f.a.id}/http${query}`);
});

it("relays only a fixed public Bot capability path to its owning member without browser authentication", async () => {
  const f = await fixture();
  const hook = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    token = "b".repeat(64);
  const path = `/yesimbot/hooks/tenant/${f.b.id}/${hook}/${token}`;
  const response = await fetch(f.parentUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "hello" }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`/v1/runtimes/${f.b.id}/http/yesimbot/hooks/${hook}/${token}`);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].cookie).toBeUndefined();
  expect((await fetch(f.parentUrl + path)).status).toBe(404);
  expect(f.requests).toHaveLength(1);
  f.setAvailable(false);
  expect((await fetch(f.parentUrl + path, { method: "POST", body: "{}" })).status).toBe(503);
});

it("relays a desktop only to the session runtime, preserving binary frames and revocation", async () => {
  const f = await fixture();
  const ws = new WebSocket(f.parentUrl.replace("http:", "ws:") + "/yesimbot/api/v1/devices/desktop", {
    headers: { Cookie: f.cookie, Origin: "http://console.test", "x-yesimbot-tenant-id": f.b.id },
  });
  cleanup.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const received = new Promise<Buffer>((resolve) => ws.once("message", (data) => resolve(Buffer.from(data as Buffer))));
  const payload = Buffer.from([0, 255, 4, 6]);
  ws.send(payload, { binary: true });
  expect(await received).toEqual(payload);
  expect(f.wsRoutes).toEqual([`/v1/runtimes/${f.a.id}/desktop`]);
  const closed = new Promise((resolve) => ws.once("close", resolve));
  f.auth.revokeAccount(f.a.id);
  await closed;
});

it("binds control forwarding to the parent login rather than browser-supplied identity", async () => {
  const f = await fixture();
  const second = `yesimbot_admin=${await f.auth.login("alice", "alice-password-123")}`;
  for (const cookie of [f.cookie, second]) {
    await fetch(`${f.parentUrl}/yesimbot/api/v1/devices/control`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://console.test", "Content-Type": "application/json", "x-yesimbot-control-login": "forged" },
      body: JSON.stringify({ op: "acquire" }),
    });
  }
  expect(f.requests.map((request) => request.controlLogin)).toEqual([f.cookie, second].map((cookie) => createHash("sha256").update(cookie).digest("hex")));
  expect(f.requests[0].controlLogin).not.toBe(f.requests[1].controlLogin);
});

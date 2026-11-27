import { createHash, scryptSync } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

import Koa from "koa";
import { afterEach, expect, it, vi } from "vitest";

import { AdminAuth } from "../src/admin-auth.js";
import { installEvents } from "../src/webui/events.js";
import { CONTACT_MARK, chooseEncoding, createStaticMiddleware, fillContact, isBackendPath, loadAssets } from "../src/webui/static.js";
import { ChangeSignal, TopicRegistry } from "../src/webui/topics.js";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

function get(url: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function assetsFixture() {
  const dir = await mkdtemp(join(tmpdir(), "yesimbot-webui-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "index.html": "<!doctype html><title>YesImBot</title><script type=module src=/assets/index-abc123.js></script>",
    "assets/index-abc123.js": "console.log('app');".repeat(50),
    "favicon.svg": "<svg/>",
    "privacy.html": `<p>请联系${CONTACT_MARK}。</p><p>或联系${CONTACT_MARK}，说明请求范围。</p>`,
  };
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    if (name.endsWith(".js") || name.endsWith(".html")) {
      await writeFile(file + ".br", brotliCompressSync(content));
      await writeFile(file + ".gz", gzipSync(content));
    }
  }
  return dir;
}

it("names the instance's contact on the public pages, or 本实例管理员 when none is set", async () => {
  // User, 2026-11-27: 联系邮箱「改成可配置」, so the published pages carry no one's address.
  const dir = await assetsFixture();
  const named = fillContact(loadAssets(dir), "a&b@example.com");
  const page = named.get("/privacy.html")!;
  expect(page.body.toString()).toBe(
    '<p>请联系<a href="mailto:a&#38;b@example.com">a&#38;b@example.com</a>。</p><p>或联系<a href="mailto:a&#38;b@example.com">a&#38;b@example.com</a>，说明请求范围。</p>',
  );
  expect([page.br, page.gzip]).toEqual([undefined, undefined]);
  expect(page.etag).not.toBe(loadAssets(dir).get("/privacy.html")!.etag);
  expect(fillContact(loadAssets(dir), "").get("/privacy.html")!.body.toString()).toBe("<p>请联系本实例管理员。</p><p>或联系本实例管理员，说明请求范围。</p>");
  // Other files are left as they are.
  expect(named.get("/index.html")!.br).toBeDefined();
});

it("serves precompressed hashed assets with immutable caching, ETags and SPA fallback", async () => {
  const assets = loadAssets(await assetsFixture());
  const app = new Koa();
  app.use(createStaticMiddleware(assets, { excludedPrefixes: ["/koishi"] }));
  app.use((http) => {
    http.status = 418;
    http.body = "backend";
  });
  const base = await listen(createServer(app.callback()));

  const script = await get(`${base}/assets/index-abc123.js`, { "accept-encoding": "gzip, br" });
  expect(script.status).toBe(200);
  expect(script.headers["content-encoding"]).toBe("br");
  expect(script.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(script.headers["content-type"]).toContain("text/javascript");
  expect(script.headers.vary).toBe("Accept-Encoding");

  const gzip = await get(`${base}/assets/index-abc123.js`, { "accept-encoding": "br;q=0, gzip" });
  expect(gzip.headers["content-encoding"]).toBe("gzip");
  const identity = await get(`${base}/assets/index-abc123.js`);
  expect(identity.headers["content-encoding"]).toBeUndefined();
  expect(identity.body.toString()).toContain("console.log");

  const page = await get(`${base}/channels/onebot:1/sessions/x?tab=detail`, { accept: "text/html" });
  expect(page.status).toBe(200);
  expect(page.headers["cache-control"]).toBe("max-age=0, stale-while-revalidate=604800");
  expect(page.body.toString()).toContain("<title>YesImBot</title>");
  const sessionPage = await get(`${base}/conversations/onebot%3A1/20261028T103000.jsonl`, { accept: "text/html" });
  expect(sessionPage.status).toBe(200);
  const cached = await get(`${base}/`, { accept: "text/html", "if-none-match": String(page.headers.etag) });
  expect(cached.status).toBe(304);
  const head = await get(`${base}/assets/index-abc123.js`, {}, "HEAD");
  expect(head.status).toBe(200);
  expect(Number(head.headers["content-length"])).toBeGreaterThan(0);

  for (const path of [
    "/yesimbot/api/v1/events",
    "/yesimbot/admin/session",
    "/yesimbot/napcat/status",
    "/yesimbot/wechat/status",
    "/yesimbot/wechat/qrcode?generation=1",
    "/koishi/index.js",
    "/koishi",
    "/onebot/abc",
    "/missing.js",
    "/assets/missing-chunk.jsonl",
  ])
    expect((await get(base + path, { accept: "text/html" })).status).toBe(418);
  expect((await get(`${base}/some/page`, { accept: "application/json" })).status).toBe(418);
});

it("negotiates encodings and backend prefixes exactly", () => {
  const asset = { body: Buffer.from("x"), br: Buffer.from("b"), gzip: Buffer.from("g"), type: "", etag: "", immutable: false };
  expect(chooseEncoding("", asset)).toBeUndefined();
  expect(chooseEncoding("*", asset)).toBe("br");
  expect(chooseEncoding("gzip;q=0.5, br;q=0", asset)).toBe("gzip");
  expect(isBackendPath("/yesimbot/api")).toBe(true);
  expect(isBackendPath("/yesimbot/apiary")).toBe(false);
  expect(isBackendPath("/yesimbot/channels")).toBe(false);
  expect(isBackendPath("/yesimbot/wechat/login/cancel")).toBe(true);
  expect(isBackendPath("/yesimbot/wechatter")).toBe(false);
});

async function eventsFixture(options: { heartbeatMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "yesimbot-events-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const credential = join(dir, "credential.json"),
    salt = Buffer.alloc(16, 2);
  await writeFile(
    credential,
    JSON.stringify({ version: 1, username: "owner", salt: salt.toString("base64"), hash: scryptSync("owner-password-1", salt, 64).toString("base64") }),
  );
  const auth = new AdminAuth({ enabled: true, credentialFile: credential, sessionHours: 1 }, credential);
  const topics = new TopicRegistry();
  const routes = new Map<string, (http: Koa.Context) => unknown>();
  const disposers: Array<() => void> = [];
  const ctx = {
    server: { get: (path: string, handler: (http: Koa.Context) => unknown) => routes.set(path, handler) },
    on: (_: string, fn: () => void) => disposers.push(fn),
  };
  installEvents(ctx as never, auth, topics, { heartbeatMs: options.heartbeatMs ?? 60_000, coalesceMs: 5 });
  const app = new Koa();
  app.use(async (http, next) => {
    const handler = routes.get(http.path);
    return handler && http.method === "GET" ? handler(http) : next();
  });
  const base = await listen(createServer(app.callback()));
  const dispose = () => disposers.forEach((off) => off());
  cleanup.push(dispose);
  const cookie = `yesimbot_admin=${await auth.login(undefined, "owner-password-1")}`;
  return { auth, topics, base, cookie, dispose };
}

function stream(url: string, headers: Record<string, string>) {
  const events: Array<{ event: string; data: string }> = [];
  let raw = "";
  let status = 0;
  let ended = false;
  const req = request(url, { headers }, (res) => {
    status = res.statusCode ?? 0;
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      raw += chunk;
      let index;
      while ((index = raw.indexOf("\n\n")) >= 0) {
        const block = raw.slice(0, index);
        raw = raw.slice(index + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data });
        else if (block.startsWith(": ping")) events.push({ event: "ping", data: "" });
      }
    });
    res.on("end", () => (ended = true));
  });
  req.end();
  cleanup.push(() => req.destroy());
  return { events, status: () => status, ended: () => ended };
}

it("streams a snapshot then coalesced updates, heartbeats, and closes when the session ends", async () => {
  const { auth, topics, base, cookie } = await eventsFixture({ heartbeatMs: 30 });
  let value = 1;
  const signal = new ChangeSignal();
  topics.register({ name: "panel", authorize: () => true, get: async () => ({ value }), subscribe: (listener) => signal.subscribe(listener) });

  expect((await get(`${base}/yesimbot/api/v1/events?topics=panel`)).status).toBe(401);
  expect((await get(`${base}/yesimbot/api/v1/events?topics=nope`, { cookie })).status).toBe(403);
  const mixed = stream(`${base}/yesimbot/api/v1/events?topics=nope,panel`, { cookie });
  await vi.waitFor(() => expect(mixed.events.filter((e) => e.event !== "ping").map((e) => e.event)).toEqual(["unavailable", "snapshot"]));
  expect((await get(`${base}/yesimbot/api/v1/events?topics=`, { cookie })).status).toBe(400);

  const live = stream(`${base}/yesimbot/api/v1/events?topics=panel`, { cookie });
  await vi.waitFor(() => expect(live.events[0]).toEqual({ event: "snapshot", data: JSON.stringify({ topic: "panel", revision: 1, data: { value: 1 } }) }));
  value = 2;
  signal.emit();
  signal.emit();
  await vi.waitFor(() => expect(live.events.filter((e) => e.event === "update")).toHaveLength(1));
  expect(JSON.parse(live.events.find((e) => e.event === "update")!.data)).toEqual({ topic: "panel", revision: 2, data: { value: 2 } });
  await vi.waitFor(() => expect(live.events.some((e) => e.event === "ping")).toBe(true));
  // Unchanged payloads (polling topics) are not resent.
  signal.emit();
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(live.events.filter((e) => e.event === "update")).toHaveLength(1);

  auth.logout(cookie);
  await vi.waitFor(() => expect(live.ended()).toBe(true));
  expect(live.events.at(-1)).toEqual({ event: "closed", data: JSON.stringify({ code: "session_ended" }) });
  expect(signal.size).toBe(0);
});

it("stops optional topic data when its grant changes and restores the unchanged snapshot after a new grant", async () => {
  const { topics, base, cookie } = await eventsFixture();
  let granted = true;
  const signal = new ChangeSignal();
  const read = vi.fn(async () => ({ private: "member activity" }));
  topics.register({ name: "usage", authorize: () => granted, get: read, subscribe: (listener) => signal.subscribe(listener) });
  const live = stream(`${base}/yesimbot/api/v1/events?topics=usage`, { cookie });
  await vi.waitFor(() => expect(live.events[0]?.event).toBe("snapshot"));
  granted = false;
  signal.emit();
  await vi.waitFor(() => expect(live.events.at(-1)).toEqual({ event: "unavailable", data: JSON.stringify({ topic: "usage" }) }));
  expect(read).toHaveBeenCalledOnce();
  granted = true;
  signal.emit();
  await vi.waitFor(() =>
    expect(live.events.at(-1)).toEqual({
      event: "update",
      data: JSON.stringify({ topic: "usage", revision: 2, data: { private: "member activity" } }),
    }),
  );
  expect(read).toHaveBeenCalledTimes(2);
});

it("rejects topics the session may not read", async () => {
  const { topics, base, cookie } = await eventsFixture();
  topics.register({ name: "secret", authorize: () => false, get: async () => 1, subscribe: () => () => {} });
  expect((await get(`${base}/yesimbot/api/v1/events?topics=secret`, { cookie })).status).toBe(403);
});

it("keeps the WebUI backend and everything it imports free of Koishi packages", () => {
  const src = new URL("../src/", import.meta.url);
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(new URL(file, src), "utf8");
    expect(source, file).not.toMatch(/from "(koishi|@koishijs\/[^"]+|@satorijs\/[^"]+|minato|schemastery|cordis)"/);
    for (const [, target] of source.matchAll(/from "(\.{1,2}\/[^"]+)\.js"/g)) {
      const next = new URL(target + ".ts", new URL(file, src)).pathname.slice(new URL(src).pathname.length);
      visit(next);
    }
  };
  for (const name of readdirSync(new URL("webui/", src))) if (statSync(new URL("webui/" + name, src)).isFile()) visit("webui/" + name);
  for (const file of ["panel-source.ts", "webui/plugins.ts", "webui/system.ts", "config/store.ts", "config/catalog.ts", "config/secrets.ts"])
    expect(seen.has(file)).toBe(true);
  expect(createHash("sha256")).toBeDefined();
});

it("closes authenticated event streams and releases subscriptions when the backend disposes", async () => {
  const { topics, base, cookie, dispose } = await eventsFixture({ heartbeatMs: 20 });
  const signal = new ChangeSignal();
  topics.register({ name: "plugins", authorize: () => true, get: async () => ({}), subscribe: (listener) => signal.subscribe(listener) });
  const live = stream(`${base}/yesimbot/api/v1/events?topics=plugins`, { cookie });
  await vi.waitFor(() => expect(live.events.some((event) => event.event === "snapshot")).toBe(true));
  expect(signal.size).toBe(1);
  signal.emit();
  dispose();
  await vi.waitFor(() => expect(live.ended()).toBe(true));
  expect(signal.size).toBe(0);
  expect(live.events.at(-1)).toEqual({ event: "closed", data: JSON.stringify({ code: "server_closed" }) });
});

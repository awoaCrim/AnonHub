import { scryptSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { partsFromElements } from "@yesimbot/contracts/parts";
import { closeStateDb, configureStorage, systemClock } from "@yesimbot/foundation";
import { afterEach, expect, it, vi } from "vitest";

import { memoryLibraryService } from "../../memorizer/src/library-service.js";
import { MemoryLibrary } from "../../memorizer/src/library.js";
import { EvidenceStore } from "../../memorizer/src/store/evidence.js";
import { MemoryStore } from "../../memorizer/src/store/memory.js";
import { sqliteMemoryTable } from "../../memorizer/src/store/sqlite.js";
import { AccountStore } from "../src/accounts.js";
import { AdminAuth } from "../src/admin-auth.js";
import { ConfigStore } from "../src/config/store.js";
import { createInstanceTools } from "../src/instance-management.js";
import { webChatContext } from "../src/webui/chat-bot.js";
import { installMemory } from "../src/webui/memory.js";
import { fakeHost } from "./fixtures/fake-host.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-instance-memory-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const ctx = fakeHost({ baseDir: root });
  // The memory table lives in the shared SQLite under this test's root (convention 08).
  // A test may build several fixtures; each one gets its own database file.
  closeStateDb();
  configureStorage({ dataRoot: root });
  cleanup.push(() => closeStateDb());
  Object.assign(ctx, { loader: { config: { plugins: {} } } });
  // The owner's message reaches a stub messenger: only the authentication it carries matters here.
  Object.assign(ctx, { yesimbot: { identity: {}, messenger: { accept: async () => {} } } });
  const bot = ctx.openWebChat(() => {});
  let now = 0;
  const credential = join(root, "owner.json");
  const salt = Buffer.alloc(16, 7);
  await writeFile(
    credential,
    JSON.stringify({ version: 1, username: "owner", salt: salt.toString("base64"), hash: scryptSync("correct", salt, 64).toString("base64") }),
  );
  const auth = new AdminAuth({ enabled: true, credentialFile: credential, sessionHours: 1 }, credential, { now: () => now, timeZone: "Asia/Shanghai" });
  const login = async () => `yesimbot_admin=${await auth.login("owner", "correct")}`;
  const cookie = await login();
  const ingress = (value = cookie) => {
    const session = auth.sessionFromCookie(value);
    void bot.receive(
      "owner",
      "manage memory",
      "source",
      now,
      "",
      [],
      () => !!session && session.role !== "member" && auth.sessionFromCookie(value) === session,
    );
  };
  let hold: { entered: () => void; wait: Promise<void> } | undefined;
  const store = new MemoryStore(sqliteMemoryTable(), {
    clock: systemClock(),
    tenantId: TENANT,
    isOwner: (context) => bot.isAuthenticatedContext(context),
    indexer: {
      modelId: "test",
      queryPrefix: "",
      embed: async () => {
        const current = hold;
        hold = undefined;
        if (current) {
          current.entered();
          await current.wait;
        }
        return [1, 0];
      },
    },
  });
  const evidence = new EvidenceStore(root);
  ctx.services.set("yesimbotMemory", memoryLibraryService(new MemoryLibrary({ store, evidence })));
  ingress();
  const fact = { type: "preference" as const, content: "长期事实".repeat(100), importance: 0.8, confidence: 0.9, tags: [] };
  const memory = await store.create({ ...fact, scope: "channel", context: webChatContext }, "a");
  const source = {
    platform: "web",
    selfId: "bot",
    channel: { id: "owner", type: 1 },
    user: { id: "owner" },
    messageId: "raw-evidence",
    timestamp: 1,
    parts: partsFromElements([]),
  };
  await evidence.append(memory.id, [source]);
  const config = new ConfigStore(ctx, { selfService: true });
  const tools = (role: "main" | "service" = "service", scope = webChatContext, transport = bot, runtime = ctx) =>
    createInstanceTools(runtime, config, { scope, bot: transport, role, logSecrets: new Set() });
  const call = (name: string, value: unknown = {}, role: "main" | "service" = "service") =>
    tools(role)
      .find((tool) => tool.name === name)!
      .execute(value, {} as never);
  const blockEmbedding = () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const wait = new Promise<void>((resolve) => (release = resolve));
    hold = { entered, wait };
    return { started, release };
  };
  return {
    ctx,
    root,
    config,
    bot,
    auth,
    cookie,
    login,
    ingress,
    store,
    evidence,
    fact,
    memory,
    tools,
    call,
    blockEmbedding,
    expire: () => {
      now = 3600_001;
    },
  };
}

it("pages the current owner's full library as summaries and reads one full record, independently of recall and history", async () => {
  const f = await fixture();
  await f.store.create({ ...f.fact, content: "second fact", scope: "channel", context: webChatContext }, "b");
  const foreign = new MemoryStore(sqliteMemoryTable(), { clock: systemClock(), tenantId: OTHER });
  await foreign.create({ ...f.fact, content: "foreign private fact", scope: "channel", context: webChatContext }, "foreign");
  await f.store.create({ ...f.fact, content: "forgotten fact", scope: "channel", context: webChatContext }, "forgotten");
  await f.store.forget("forgotten", "test");
  expect(await f.store.queryVisible(webChatContext, ["owner"], { query: "not-matched" })).toEqual([]);
  const page = await f.call("instance_memory_read", { action: "list", limit: 1 }, "main");
  expect(page).toMatchObject({ memories: [{ id: "a", revision: 1, visibility: "owner" }], nextCursor: "a" });
  expect(Array.from(page.memories[0].summary)).toHaveLength(160);
  expect(page.memories[0].content).toBeUndefined();
  expect(JSON.stringify(page)).not.toMatch(/embedding|raw-evidence|evidence\/|tenantId/);
  expect(await f.call("instance_memory_read", { action: "list", cursor: page.nextCursor }, "main")).toMatchObject({
    memories: [{ id: "b", visibility: "owner" }],
  });
  const read = await f.call("instance_memory_read", { action: "read", id: "a" }, "main");
  expect(read).toMatchObject({ id: "a", content: f.fact.content, visibility: "owner", revision: 1 });
  expect(JSON.stringify(read)).not.toMatch(/embedding|raw-evidence|evidence\/|tenantId/);
  for (const id of ["foreign", "forgotten", "missing"])
    expect(await f.call("instance_memory_read", { action: "read", id })).toEqual({ error: "memory_not_found", status: 404 });
  const group = { type: "guild" as const, platform: "onebot", selfId: "qqbot", channelId: "room", guildId: "room" };
  expect(await f.store.queryVisible(group, ["owner"])).toEqual([]);
});

it("permits only the current authenticated WebChat runtime, with mutations on main and service", async () => {
  const f = await fixture();
  expect(
    f
      .tools("main")
      .filter((tool) => tool.name.startsWith("instance_memory_"))
      .map((tool) => tool.name),
  ).toEqual(["instance_memory_read", "instance_memory_write"]);
  expect(
    f
      .tools("computer" as never)
      .filter((tool) => tool.name.startsWith("instance_memory_"))
      .map((tool) => tool.name),
  ).toEqual(["instance_memory_read"]);
  for (const tool of f.tools().filter((entry) => entry.name.startsWith("instance_memory_"))) {
    expect(tool.capability).toEqual({
      platforms: ["web"],
      contexts: ["direct"],
      sensitive: true,
      executionKind: /write/.test(tool.name) ? "service" : "read",
    });
  }
  const other = fakeHost({ yesimbot: { identity: {} } });
  expect(f.tools("service", webChatContext, f.bot, other)).toEqual([]);
  expect(f.tools("service", { ...webChatContext, platform: "onebot" })).toEqual([]);
  expect(f.tools("service", webChatContext, { platform: "web", selfId: "bot" } as never)).toEqual([]);
  const read = f.tools("main").find((tool) => tool.name === "instance_memory_read")!;
  f.auth.logout(f.cookie);
  expect(await read.execute({ action: "read", id: "a" }, {} as never)).toEqual({ error: "instance_authentication_required" });
  expect(f.tools()).toEqual([]);
  f.ingress(await f.login());
  expect(await read.execute({ action: "read", id: "a" }, {} as never)).toMatchObject({ id: "a" });
});

it("uses the real managed revision checks and rejects foreign tenants and caller-supplied paths", async () => {
  const f = await fixture();
  for (const value of [{ id: "a", tenantId: OTHER }, { id: "a", path: "/tmp/memory.db" }, { id: "../owner" }])
    expect(await f.call("instance_memory_read", { action: "read", ...value })).toEqual({ error: "invalid_instance_request" });
  for (const value of [{ limit: 201 }, { limit: 0 }, { limit: "1" }, { cursor: "x".repeat(513) }, { query: "coffee" }])
    expect(await f.call("instance_memory_read", { action: "list", ...value })).toEqual({ error: "invalid_instance_request" });
  const edits = await Promise.all(
    ["updated stable fact", "concurrent correction"].map((content) => f.call("instance_memory_write", { action: "update", id: "a", revision: 1, content })),
  );
  expect(edits.filter((result) => result.revision === 2)).toHaveLength(1);
  expect(edits.filter((result) => result.error === "memory_revision_conflict")).toHaveLength(1);
  expect(await f.call("instance_memory_read", { action: "read", id: "a" })).toMatchObject({ id: "a", revision: 2, visibility: "owner" });
  // A call without what its action needs is refused with what to add, and nothing is changed.
  expect(await f.call("instance_memory_write", { action: "update", id: "a", revision: 2 })).toMatchObject({
    status: "rejected",
    message: expect.stringContaining("content"),
  });
  expect(await f.call("instance_memory_write", { action: "delete", id: "a" })).toMatchObject({
    status: "rejected",
    message: expect.stringContaining("revision"),
  });
  expect(await f.call("instance_memory_read", { action: "read" })).toMatchObject({ status: "rejected" });
  expect(await f.call("instance_memory_write", { action: "update", id: "a", revision: 1, content: "stale" })).toEqual({
    error: "memory_revision_conflict",
    status: 409,
  });
  expect(await f.call("instance_memory_write", { action: "delete", id: "a", revision: 1 })).toEqual({ error: "memory_revision_conflict", status: 409 });
  expect(await f.evidence.read("a")).toHaveLength(1);
  expect(await f.call("instance_memory_write", { action: "delete", id: "a", revision: 2 })).toEqual({ deleted: true });
  expect(await f.store.get("a")).toBeUndefined();
  expect(await f.evidence.read("a")).toEqual([]);
});

it("shares the real owner service with the HTTP API while rejecting member cookies, logout and cross-origin writes", async () => {
  const f = await fixture();
  const accounts = new AccountStore(join(f.root, "accounts.json"), () => f.auth.ownerUsername());
  f.auth.accounts = accounts;
  await accounts.create("alice", "member-password-123");
  const memberCookie = `yesimbot_admin=${await f.auth.login("alice", "member-password-123")}`;
  expect(f.auth.sessionFromCookie(memberCookie)?.role).toBe("member");
  const routes = new Map<string, (http: never) => Promise<void>>();
  Object.assign(f.ctx, {
    server: {
      get: (path: string, handler: (http: never) => Promise<void>) => routes.set(`GET ${path}`, handler),
      post: (path: string, handler: (http: never) => Promise<void>) => routes.set(`POST ${path}`, handler),
    },
  });
  installMemory(f.ctx, f.auth);
  const request = async (method: "GET" | "POST", cookie: string, origin = "http://console.test") => {
    const headers: Record<string, string> = { cookie, origin, "content-type": "application/json" };
    const http = {
      status: 200,
      body: undefined as unknown,
      query: {},
      origin: "http://console.test",
      secure: false,
      request: { body: { action: "delete", id: "a", revision: 1 } },
      get: (name: string) => headers[name] ?? "",
      set() {},
    };
    await routes.get(`${method} /yesimbot/api/v1/memory`)!(http as never);
    return http;
  };
  expect((await request("GET", f.cookie)).body).toMatchObject({ memories: [{ id: "a" }] });
  expect((await request("GET", memberCookie)).status).toBe(403);
  expect((await request("POST", memberCookie)).status).toBe(403);
  expect((await request("POST", f.cookie, "http://foreign.test")).status).toBe(403);
  f.auth.logout(f.cookie);
  expect((await request("POST", f.cookie)).status).toBe(401);
  expect(await f.store.get("a")).toMatchObject({ revision: 1 });
  expect(await f.evidence.read("a")).toHaveLength(1);
});

it.each(["update", "delete"] as const)("rechecks the same real login session for queued memory %s", async (action) => {
  for (const failure of ["logout", "expiry", "new-login"] as const) {
    const f = await fixture();
    const gate = f.blockEmbedding();
    const blocker = f.store.create({ ...f.fact, content: "queued unrelated stable fact", scope: "channel", context: webChatContext }, "blocker");
    await gate.started;
    const pending = f.call("instance_memory_write", { action, id: "a", revision: 1, ...(action === "update" ? { content: "queued correction" } : {}) });
    if (failure === "expiry") f.expire();
    else f.auth.logout(f.cookie);
    if (failure === "new-login") {
      f.ingress(await f.login());
      expect(f.bot.isAuthenticatedContext(webChatContext)).toBe(true);
    }
    gate.release();
    await blocker;
    expect(await pending).toEqual({ error: "instance_authentication_required" });
    expect(await f.store.get("a")).toMatchObject({ content: f.fact.content, revision: 1 });
    expect(await f.evidence.read("a")).toHaveLength(1);
  }
});

it("withholds an in-flight read and edit when the authorizing session is replaced", async () => {
  const f = await fixture();
  const gate = f.blockEmbedding();
  const edit = f.call("instance_memory_write", { action: "update", id: "a", revision: 1, content: "slow indexed correction" });
  await gate.started;
  const read = f.call("instance_memory_read", { action: "read", id: "a" }, "main");
  f.auth.logout(f.cookie);
  f.ingress(await f.login());
  gate.release();
  expect(await edit).toEqual({ error: "instance_authentication_required" });
  expect(await read).toEqual({ error: "instance_authentication_required" });
  expect(await f.store.get("a")).toMatchObject({ revision: 1, content: f.fact.content });
});

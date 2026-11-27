import { scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { AccountStore } from "../src/accounts.js";
import { AdminAuth, installAdminAuth } from "../src/admin-auth.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "yesimbot-accounts-"));
  directories.push(dir);
  const credential = join(dir, "credential.json"),
    salt = Buffer.alloc(16, 4);
  await writeFile(
    credential,
    JSON.stringify({ version: 1, username: "owner", salt: salt.toString("base64"), hash: scryptSync("original-owner", salt, 64).toString("base64") }),
  );
  const auth = new AdminAuth({ enabled: true, credentialFile: credential, sessionHours: 1 }, credential);
  const store = new AccountStore(join(dir, "accounts.json"), () => auth.ownerUsername());
  auth.accounts = store;
  await store.ready;
  return { dir, credential, auth, store };
}
it("serializes private atomic identity mutations and survives reload without password disclosure", async () => {
  const { store } = await fixture();
  const [a, b] = await Promise.all([store.create("Alice", "alice-password-123"), store.create("bob", "bob-password-123")]);
  expect(a.id).not.toBe(b.id);
  expect(a.username).toBe("alice");
  expect((await stat(store.file)).mode & 0o777).toBe(0o600);
  expect(await readFile(store.file, "utf8")).not.toContain("alice-password");
  const restored = new AccountStore(store.file, async () => "owner");
  await restored.ready;
  expect(restored.list()).toHaveLength(2);
  expect(await restored.authenticate("ALICE", "alice-password-123")).toMatchObject({ id: a.id });
  await expect(store.create("OWNER", "valid-password-123")).rejects.toThrow("username_unavailable");
  await expect(store.create("alice", "valid-password-123")).rejects.toThrow("username_unavailable");
  await expect(store.create("bad/name", "valid-password-123")).rejects.toThrow("invalid_username");
  await expect(store.create("valid", "short")).rejects.toThrow("invalid_password");
});
it("preserves owner password-only login and denies member parent authority; reset and disable revoke sessions", async () => {
  const { auth, store } = await fixture();
  const a = await store.create("alice", "alice-password-123");
  const ownerToken = await auth.login(undefined, "original-owner");
  expect(auth.sessionFromCookie(`yesimbot_admin=${ownerToken}`)).toMatchObject({ role: "owner", accountId: "owner" });
  const token = await auth.login("alice", "alice-password-123"),
    cookie = `yesimbot_admin=${token}`;
  expect(auth.sessionFromCookie(cookie)).toMatchObject({ role: "member", accountId: a.id });
  const http = { get: () => cookie, set() {}, status: 200, body: undefined, origin: "http://localhost", secure: false };
  expect(auth.requireOwner(http)).toBe(false);
  expect(http.status).toBe(403);
  await store.update(a.id, { password: "replacement-password" });
  expect(auth.sessionFromCookie(cookie)).toBeUndefined();
  expect(await auth.login("alice", "alice-password-123")).toBeUndefined();
  const next = await auth.login("alice", "replacement-password");
  expect(next).toBeDefined();
  await store.update(a.id, { enabled: false });
  expect(auth.sessionFromCookie(`yesimbot_admin=${next}`)).toBeUndefined();
  expect(await auth.login("alice", "replacement-password")).toBeUndefined();
});
it("public session excludes credential version", async () => {
  const { dir, credential, store } = await fixture();
  const routes: Record<string, Function> = {};
  const ctx = {
    baseDir: dir,
    server: { get: (p: string, f: Function) => (routes[p] = f), post: (p: string, f: Function) => (routes[p] = f) },
    on: () => () => {},
  };
  const auth = installAdminAuth(ctx as never, { enabled: true, credentialFile: credential, sessionHours: 1 });
  auth.accounts = store;
  await store.create("alice", "alice-password-123");
  const token = await auth.login("alice", "alice-password-123");
  const http = { get: () => `yesimbot_admin=${token}`, set() {}, body: undefined as unknown };
  routes["/yesimbot/admin/session"](http);
  expect(http.body).toEqual({
    enabled: true,
    authenticated: true,
    username: "alice",
    role: "member",
    accountId: store.list()[0].id,
    expiresAt: expect.any(Number),
  });
});

it("owner routes redact credentials, members cannot manage accounts, and self setup ignores supplied target IDs", async () => {
  const { auth, store } = await fixture();
  const { installAccountRoutes } = await import("../src/accounts.js");
  const routes: Record<string, Function> = {};
  const ctx = { server: { get: (p: string, f: Function) => (routes[`GET ${p}`] = f), post: (p: string, f: Function) => (routes[`POST ${p}`] = f) } };
  const calls: unknown[][] = [];
  let stopFails = false;
  const manager = {
    runtime: async (...args: unknown[]) => {
      calls.push(args);
      if (args[1] === "stop" && stopFails) throw new Error("private Docker path/password");
      return { id: args[0], state: "running" };
    },
  };
  installAccountRoutes(ctx as never, auth, store, manager as never);
  const owner = `yesimbot_admin=${await auth.login(undefined, "original-owner")}`;
  const a = await store.create("alice", "alice-password-123"),
    b = await store.create("bob", "bob-password-123");
  const member = `yesimbot_admin=${await auth.login("alice", "alice-password-123")}`;
  const http = (cookie: string, body: object = {}, params = {}) => ({
    get: (key: string) => ({ cookie, origin: "http://console.test", "content-type": "application/json" })[key] ?? "",
    origin: "http://console.test",
    secure: false,
    status: 200,
    body: undefined as unknown,
    request: { body },
    params,
    set() {},
  });
  const list = http(member);
  await routes["GET /yesimbot/admin/accounts"](list);
  expect(list.status).toBe(403);
  const start = http(member, { qqAccount: "12345678", accountId: b.id, target: "http://owner" });
  await routes["POST /yesimbot/account/runtime/start"](start);
  expect(calls.at(-1)).toEqual([a.id, "start", "12345678"]);
  const ownerList = http(owner);
  await routes["GET /yesimbot/admin/accounts"](ownerList);
  expect(JSON.stringify(ownerList.body)).not.toMatch(/salt|hash|version|password/);
  stopFails = true;
  const disable = http(owner, { enabled: false }, { id: a.id });
  await routes["POST /yesimbot/admin/accounts/:id/enabled"](disable);
  expect(auth.sessionFromCookie(member)).toBeUndefined();
  expect(store.get(a.id)?.enabled).toBe(false);
  expect(disable.body).toMatchObject({ message: "runtime_stop_failed_access_revoked" });
  expect(JSON.stringify(disable.body)).not.toContain("private Docker");
  const ownReset = http(owner, { password: "new-owner-password" }, { id: "owner" });
  await routes["POST /yesimbot/admin/accounts/:id/password"](ownReset);
  expect(ownReset.status).toBe(400);
  expect(await auth.login(undefined, "original-owner")).toBeDefined();
});

it("rejects an in-flight password check after the current account snapshot is disabled", async () => {
  const { store } = await fixture();
  const account = await store.create("alice", "alice-password-123");
  const pending = store.authenticate("alice", "alice-password-123");
  await store.update(account.id, { enabled: false });
  expect(await pending).toBeUndefined();
});

it("recovers self setup after registration failed during account creation and rechecks revocation before start", async () => {
  const { auth, store } = await fixture();
  const { installAccountRoutes } = await import("../src/accounts.js");
  const routes: Record<string, Function> = {};
  const ctx = { server: { get: (p: string, f: Function) => (routes[`GET ${p}`] = f), post: (p: string, f: Function) => (routes[`POST ${p}`] = f) } };
  const calls: unknown[][] = [],
    registered = new Map<string, string | undefined>();
  let unavailable = true,
    revokeDuringRegister = false;
  const manager = {
    runtime: async (id: string, action?: string, qq?: string) => {
      calls.push([id, action, qq]);
      if (unavailable) throw new Error("manager_unavailable");
      if (action === "register") {
        if (registered.get(id) && registered.get(id) !== qq) throw new Error("qq-account-immutable");
        registered.set(id, qq);
        if (revokeDuringRegister) auth.revokeAccount(id);
      }
      if (!registered.has(id)) throw new Error("not_found");
      return { id, state: action === "start" ? "starting" : "stopped", qqAccount: registered.get(id) };
    },
  };
  installAccountRoutes(ctx as never, auth, store, manager as never);
  const owner = `yesimbot_admin=${await auth.login(undefined, "original-owner")}`;
  const http = (cookie: string, body: object) => ({
    get: (key: string) => ({ cookie, origin: "http://console.test", "content-type": "application/json" })[key] ?? "",
    origin: "http://console.test",
    secure: false,
    status: 200,
    body: undefined as unknown,
    request: { body },
    set() {},
  });
  const create = http(owner, { username: "alice", password: "alice-password-123" });
  await routes["POST /yesimbot/admin/accounts"](create);
  const id = store.list()[0].id;
  expect(create.body).toMatchObject({ account: { id, runtime: { state: "error" } } });
  expect(registered.has(id)).toBe(false);
  unavailable = false;
  const member = `yesimbot_admin=${await auth.login("alice", "alice-password-123")}`;
  calls.length = 0;
  const start = http(member, { qqAccount: "12345678", accountId: "foreign-id", target: "http://foreign" });
  await routes["POST /yesimbot/account/runtime/start"](start);
  expect(calls).toEqual([
    [id, "register", "12345678"],
    [id, "start", "12345678"],
  ]);
  expect(start.body).toMatchObject({ runtime: { id, state: "starting", qqAccount: "12345678" } });
  const changedQQ = http(member, { qqAccount: "87654321" });
  await routes["POST /yesimbot/account/runtime/start"](changedQQ);
  expect(changedQQ.status).toBe(503);
  expect(registered.get(id)).toBe("12345678");
  calls.length = 0;
  revokeDuringRegister = true;
  const revoked = http(member, { qqAccount: "12345678" });
  await routes["POST /yesimbot/account/runtime/start"](revoked);
  expect(revoked.status).toBe(401);
  expect(calls).toEqual([[id, "register", "12345678"]]);
});

it("stores plugin grants, pushes them to the manager and keeps sessions when grants change", async () => {
  const { auth, store, dir } = await fixture();
  const { installAccountRoutes } = await import("../src/accounts.js");
  const { OPTIONAL_MEMBER_PLUGIN_NAMES } = await import("../src/shared/plugin-catalog.js");
  const routes: Record<string, Function> = {};
  const ctx = { server: { get: (p: string, f: Function) => (routes[`GET ${p}`] = f), post: (p: string, f: Function) => (routes[`POST ${p}`] = f) } };
  const calls: unknown[][] = [];
  let failRegister = false;
  const manager = {
    runtime: async (...args: unknown[]) => {
      calls.push(args);
      if (args[1] === "register" && failRegister) throw new Error("manager_unavailable");
      return { id: args[0], state: "stopped" };
    },
  };
  installAccountRoutes(ctx as never, auth, store, manager as never);
  const owner = `yesimbot_admin=${await auth.login(undefined, "original-owner")}`;
  const http = (body: object = {}, params = {}) => ({
    get: (key: string) => ({ cookie: owner, origin: "http://console.test", "content-type": "application/json" })[key] ?? "",
    origin: "http://console.test",
    secure: false,
    status: 200,
    body: undefined as { account: { id: string; plugins: string[] }; message?: string } | undefined,
    request: { body },
    params,
    set() {},
  });
  const bad = http({ username: "alice", password: "alice-password-123", plugins: ["yesimbot-console"] });
  await routes["POST /yesimbot/admin/accounts"](bad);
  expect(bad.status).toBe(400);
  expect(store.list()).toEqual([]);

  const create = http({ username: "alice", password: "alice-password-123", plugins: ["yesimbot-xiaoheihe", "yesimbot-memorizer"] });
  await routes["POST /yesimbot/admin/accounts"](create);
  const id = create.body!.account.id;
  expect(create.body!.account.plugins).toEqual(["yesimbot-memorizer", "yesimbot-xiaoheihe"]);
  expect(calls.filter((call) => call[1] === "register").at(-1)).toEqual([id, "register", undefined, ["yesimbot-memorizer", "yesimbot-xiaoheihe"]]);

  const member = `yesimbot_admin=${await auth.login("alice", "alice-password-123")}`;
  const version = store.get(id)!.version;
  const change = http({ plugins: ["yesimbot-workspace"] }, { id });
  await routes["POST /yesimbot/admin/accounts/:id/plugins"](change);
  expect(change.body!.account.plugins).toEqual(["yesimbot-workspace"]);
  expect(calls.filter((call) => call[1] === "register").at(-1)).toEqual([id, "register", undefined, ["yesimbot-workspace"]]);
  expect(store.get(id)!.version).toBe(version);
  expect(auth.sessionFromCookie(member)).toBeDefined();

  failRegister = true;
  const unsynced = http({ plugins: [] }, { id });
  await routes["POST /yesimbot/admin/accounts/:id/plugins"](unsynced);
  expect(unsynced.body).toMatchObject({ account: { plugins: [] }, message: "runtime_policy_sync_failed" });

  // Registries written before grants existed keep every optional plugin.
  const legacy = await store.create("bob", "bob-password-123");
  const raw = JSON.parse(await readFile(join(dir, "accounts.json"), "utf8"));
  delete raw.accounts.find((a: { id: string }) => a.id === legacy.id).plugins;
  await writeFile(join(dir, "accounts.json"), JSON.stringify(raw), { mode: 0o600 });
  const reloaded = new AccountStore(join(dir, "accounts.json"), () => auth.ownerUsername());
  await reloaded.ready;
  const { memberPlugins } = await import("../src/accounts.js");
  expect(memberPlugins(reloaded.get(legacy.id)!)).toEqual(OPTIONAL_MEMBER_PLUGIN_NAMES);
});

it("deletes a friend only with their name typed back, and only after the manager takes the deletion", async () => {
  const { auth, store } = await fixture();
  const { installAccountRoutes } = await import("../src/accounts.js");
  const routes: Record<string, Function> = {};
  const ctx = { server: { get: (p: string, f: Function) => (routes[`GET ${p}`] = f), post: (p: string, f: Function) => (routes[`POST ${p}`] = f) } };
  const removed: string[] = [];
  let managerDown = true;
  const manager = {
    runtime: async (id: string) => ({ id, state: "stopped" }),
    remove: async (id: string) => {
      if (managerDown) throw new Error("runtime_operation_failed");
      removed.push(id);
    },
  };
  installAccountRoutes(ctx as never, auth, store, manager as never);
  const owner = `yesimbot_admin=${await auth.login(undefined, "original-owner")}`;
  const http = (body: object, params: object, cookie = owner) => ({
    get: (key: string) => ({ cookie, origin: "http://console.test", "content-type": "application/json" })[key] ?? "",
    origin: "http://console.test",
    secure: false,
    status: 200,
    body: undefined as { deleted?: boolean; message?: string } | undefined,
    request: { body },
    params,
    set() {},
  });
  const alice = await store.create("alice", "alice-password-123");
  const member = `yesimbot_admin=${await auth.login("alice", "alice-password-123")}`;
  const route = routes["POST /yesimbot/admin/accounts/:id/delete"];

  for (const username of [undefined, "bob", "alic"]) {
    const wrong = http({ username }, { id: alice.id });
    await route(wrong);
    expect(wrong.status).toBe(400);
  }
  // Friends cannot delete anyone, themselves included.
  const self = http({ username: "alice" }, { id: alice.id }, member);
  await route(self);
  expect(self.status).not.toBe(200);
  // The manager could not take it: the friend stays, still signed in.
  const down = http({ username: "alice" }, { id: alice.id });
  await route(down);
  expect(down.status).toBe(503);
  expect(store.get(alice.id)).toBeDefined();
  expect(auth.sessionFromCookie(member)).toBeDefined();

  managerDown = false;
  const done = http({ username: "Alice" }, { id: alice.id });
  await route(done);
  expect(done.body).toEqual({ deleted: true });
  expect(removed).toEqual([alice.id]);
  expect(store.get(alice.id)).toBeUndefined();
  expect(auth.sessionFromCookie(member)).toBeUndefined();
  // The name can be used again for a new friend.
  expect((await store.create("alice", "alice-password-456")).id).not.toBe(alice.id);
});

it("does not register retired public computer management APIs alongside normal account setup", async () => {
  const { auth, store } = await fixture();
  const { installAccountRoutes } = await import("../src/accounts.js");
  const routes: Record<string, Function> = {};
  const ctx = { server: { get: (p: string, f: Function) => (routes[`GET ${p}`] = f), post: (p: string, f: Function) => (routes[`POST ${p}`] = f) } };
  const calls: unknown[] = [];
  const manager = {
    runtime: async (id: string) => ({ id, state: "stopped" }),
    computers: async () => calls.push("computers"),
    computerAction: async (...args: unknown[]) => calls.push(args),
    setComputerDefaults: async (...args: unknown[]) => calls.push(args),
  };
  installAccountRoutes(ctx as never, auth, store, manager as never);
  expect(Object.keys(routes).filter((route) => route.includes("/yesimbot/admin/computers"))).toEqual([]);
  expect(routes["GET /yesimbot/admin/accounts"]).toBeTypeOf("function");
  expect(routes["POST /yesimbot/admin/accounts"]).toBeTypeOf("function");
  expect(routes["GET /yesimbot/account/runtime"]).toBeTypeOf("function");
  expect(routes["POST /yesimbot/account/runtime/start"]).toBeTypeOf("function");
  expect(calls).toEqual([]);
});

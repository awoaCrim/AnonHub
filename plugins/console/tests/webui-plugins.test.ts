import { PassThrough } from "node:stream";

import { systemClock } from "@yesimbot/foundation";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ConfigError } from "../src/config/store.js";
import type { LogsSnapshot } from "../src/shared/webui.js";
import { installPlugins } from "../src/webui/plugins.js";
import { installSystem, redactLog } from "../src/webui/system.js";
import { TopicRegistry } from "../src/webui/topics.js";

const fake = vi.hoisted(() => ({
  snapshot: vi.fn(),
  schema: vi.fn(),
  invalidate: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
  setEnabled: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  move: vi.fn(),
}));
vi.mock("../src/config/store.js", () => ({
  ConfigError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly path?: string,
      readonly restored?: boolean,
    ) {
      super("raw secret exception");
    }
  },
  ConfigStore: class {
    catalog = { snapshot: fake.snapshot, schema: fake.schema, invalidate: fake.invalidate };
    read = fake.read;
    update = fake.update;
    setEnabled = fake.setEnabled;
    add = fake.add;
    remove = fake.remove;
    move = fake.move;
  },
}));

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.useRealTimers();
});
beforeEach(() => {
  for (const fn of Object.values(fake)) fn.mockReset();
  fake.snapshot.mockResolvedValue({ revision: "v1", writable: true, tree: [], available: [] });
  fake.schema.mockResolvedValue({ schema: { type: "object", dict: { custom: { type: "string", meta: { role: "secret" } } } }, dynamics: {}, usage: "" });
  for (const key of ["update", "setEnabled", "add", "remove", "move"] as const) fake[key].mockResolvedValue({ revision: "v2" });
});

interface TestHttp {
  status: number;
  body: Record<string, unknown>;
  query: Record<string, unknown>;
  request: { body?: unknown };
  req: PassThrough;
  set: ReturnType<typeof vi.fn>;
  get(name: string): string;
}

function fixture(tenant = false) {
  const routes = new Map<string, (http: TestHttp) => unknown>();
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const config = { port: 5140, host: "127.0.0.1", plugins: { example: { apiKey: "named-secret", custom: "schema-secret" } } };
  const logListeners: Array<(record: { id: number; timestamp: number; level: string; name: string; content: string }) => void> = [];
  const target = {
    record: (row: { id: number; timestamp: number; type: string; name: string; content: string }) =>
      logListeners.forEach((listener) => listener({ id: row.id, timestamp: row.timestamp, level: row.type, name: row.name, content: row.content })),
  };
  const ctx = {
    baseDir: "/private/runtime",
    loader: { config },
    on(name: string, fn: (...args: unknown[]) => unknown) {
      const list = hooks.get(name) ?? [];
      list.push(fn);
      hooks.set(name, list);
    },
    clock: systemClock(),
    onLog(listener: (typeof logListeners)[number]) {
      logListeners.push(listener);
      return () => void logListeners.splice(logListeners.indexOf(listener), 1);
    },
    server: {
      get: (path: string, fn: (http: TestHttp) => unknown) => routes.set("GET " + path, fn),
      post: (path: string, fn: (http: TestHttp) => unknown) => routes.set("POST " + path, fn),
    },
  };
  const current = { session: { role: "owner" } as { role: string } | undefined, sameOrigin: true };
  const auth = { sessionFromCookie: () => current.session, sameOrigin: () => current.sameOrigin };
  const topics = new TopicRegistry();
  const { catalog, logSecrets } = installPlugins(ctx as never, auth as never, topics);
  installSystem(ctx as never, auth as never, topics, catalog, logSecrets, tenant);
  const dispose = () => hooks.get("dispose")?.forEach((fn) => fn());
  cleanup.push(dispose);
  const emit = (name: string) => hooks.get(name)?.forEach((fn) => fn());
  async function call(method: string, path: string, body?: unknown, extra: Record<string, unknown> = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const http: TestHttp = {
      body: {},
      status: 200,
      query: {},
      request: { body },
      req: new PassThrough(),
      set: vi.fn(),
      get: (name: string) => headers[name] ?? "",
      ...extra,
    };
    await routes.get(`${method} /yesimbot/api/v1/${path}`)!(http);
    return http;
  }
  return { topics, current, call, emit, config, target, logListeners, dispose, ctx };
}

it("denies system metadata and logs inside a tenant even with the manager's owner cookie", async () => {
  const { call, topics } = fixture(true);
  const http = await call("GET", "system");
  expect([http.status, http.body]).toEqual([403, { message: "owner_required" }]);
  expect(topics.get("logs")!.authorize({ role: "owner" } as never)).toBe(false);
});

it("protects every plugin/system route and denies parent members before touching config", async () => {
  const { current, call, topics } = fixture();
  const paths = [
    ["GET", "plugins/schema"],
    ["GET", "plugins/config"],
    ["GET", "system"],
    ...["update", "enabled", "add", "remove", "move"].map((op) => ["POST", "plugins/" + op]),
  ];
  for (const [method, path] of paths) {
    current.session = undefined;
    let http = await call(method, path);
    expect([http.status, http.body]).toEqual([401, { message: "login_required" }]);
    expect(http.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    current.session = { role: "member" };
    http = await call(method, path);
    expect([http.status, http.body]).toEqual([403, { message: "owner_required" }]);
  }
  for (const name of ["plugins", "logs"]) expect(topics.get(name)!.authorize({ role: "member" } as never)).toBe(false);
  expect(fake.read).not.toHaveBeenCalled();
  expect(fake.update).not.toHaveBeenCalled();
});

it("enforces same-origin writes and rejects explicit cross-site reads", async () => {
  const { current, call } = fixture();
  current.sameOrigin = false;
  expect((await call("POST", "plugins/remove", { revision: "v1", path: "example" })).body).toEqual({ message: "same_origin_required" });
  expect(
    (await call("GET", "plugins/config", undefined, { query: { path: "example" }, get: (key: string) => (key === "origin" ? "https://foreign.test" : "") }))
      .status,
  ).toBe(403);
  expect((await call("GET", "system", undefined, { get: (key: string) => (key === "sec-fetch-site" ? "cross-site" : "") })).status).toBe(403);
  expect(fake.remove).not.toHaveBeenCalled();
});

it("delegates stable REST shapes to the shared transactional store", async () => {
  const { call, topics } = fixture();
  await call("GET", "plugins/schema", undefined, { query: { name: "example" } });
  await call("GET", "plugins/config", undefined, { query: { path: "group:a/~example:x" } });
  expect(fake.schema).toHaveBeenCalledWith("example");
  expect(fake.read).toHaveBeenCalledWith("group:a/~example:x");
  const common = { revision: "v1", path: "example" };
  await call("POST", "plugins/update", { ...common, config: { custom: { $secret: true } } });
  await call("POST", "plugins/enabled", { ...common, enabled: false });
  await call("POST", "plugins/add", { revision: "v1", parent: "", name: "example" });
  await call("POST", "plugins/remove", common);
  await call("POST", "plugins/move", { ...common, target: "group:b", index: 0 });
  expect(fake.update).toHaveBeenCalledWith("v1", "example", { custom: { $secret: true } });
  expect(fake.setEnabled).toHaveBeenCalledWith("v1", "example", false);
  expect(fake.add).toHaveBeenCalledWith("v1", "", "example");
  expect(fake.remove).toHaveBeenCalledWith("v1", "example");
  expect(fake.move).toHaveBeenCalledWith("v1", "example", "group:b", 0);
  expect(await topics.get("plugins")!.get({} as never)).toEqual({ revision: "v1", writable: true, tree: [], available: [] });
});

it("returns fixed safe ConfigError responses without leaking exception text", async () => {
  const { call } = fixture();
  for (const [status, code] of [
    [409, "config_changed"],
    [404, "not_found"],
    [403, "locked"],
    [403, "not_permitted"],
    [400, "invalid_config"],
  ] as const) {
    fake.read.mockRejectedValueOnce(new ConfigError(status, code, code === "invalid_config" ? "connections.0.id" : undefined));
    const http = await call("GET", "plugins/config", undefined, { query: { path: "example" } });
    expect(http.status).toBe(status);
    expect(http.body.message).toBe(code);
    expect(JSON.stringify(http.body)).not.toContain("raw secret");
  }
  fake.update.mockRejectedValueOnce(new ConfigError(503, "apply_failed", undefined, true));
  expect((await call("POST", "plugins/update", { revision: "v1", path: "example", config: {} })).body).toEqual({ message: "apply_failed", restored: true });
  fake.read.mockRejectedValueOnce(new Error("password=raw-secret"));
  expect((await call("GET", "plugins/config", undefined, { query: { path: "example" } })).body).toEqual({ message: "apply_failed", restored: false });
});

it("bounds JSON bodies, rejects malformed values, and supports larger plugin collections", async () => {
  const { call } = fixture();
  for (const body of [
    undefined,
    [],
    { revision: "v1", path: "example", config: [] },
    { revision: "v1", path: "example", config: { long: "x".repeat(256 * 1024) } },
  ]) {
    if (body === undefined) continue;
    expect((await call("POST", "plugins/update", body)).status).toBe(400);
  }
  expect((await call("POST", "plugins/update", { revision: "v1", path: "example", config: { long: "x".repeat(9000) } })).status).toBe(200);
  expect((await call("POST", "plugins/enabled", { revision: "v1", path: "example", enabled: "true" })).status).toBe(400);
  expect((await call("POST", "plugins/move", { revision: "v1", path: "example", target: "", index: -1 })).status).toBe(400);
  const req = new PassThrough();
  const response = call("POST", "plugins/update", undefined, { req });
  req.end('{"password":"unclosed');
  expect((await response).body).toEqual({ message: "invalid_config" });
});

it("pushes plugin changes only with subscribers and clears pending work on dispose", async () => {
  vi.useFakeTimers();
  const { emit, topics, dispose } = fixture();
  emit("config");
  expect(vi.getTimerCount()).toBe(0);
  const notify = vi.fn();
  const off = topics.get("plugins")!.subscribe(notify);
  emit("internal/runtime");
  emit("internal/schema");
  emit("config");
  await vi.advanceTimersByTimeAsync(100);
  expect(notify).toHaveBeenCalledTimes(1);
  off();
  emit("config");
  expect(vi.getTimerCount()).toBe(0);
  topics.get("plugins")!.subscribe(notify);
  emit("config");
  dispose();
  await vi.advanceTimersByTimeAsync(100);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(topics.get("plugins")).toBeUndefined();
});

it("pushes runtime status changes and invalidates schemas only while alive", async () => {
  vi.useFakeTimers();
  const { emit, topics, dispose } = fixture();
  const notify = vi.fn();
  topics.get("plugins")!.subscribe(notify);
  emit("internal/status");
  await vi.advanceTimersByTimeAsync(100);
  expect(notify).toHaveBeenCalledTimes(1);
  fake.invalidate.mockClear();
  emit("internal/status");
  expect(fake.invalidate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(notify).toHaveBeenCalledTimes(2);
  emit("internal/status");
  dispose();
  emit("internal/status");
  emit("internal/status");
  await vi.advanceTimersByTimeAsync(100);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("exposes only read-only system fields and bounded redacted logs, then removes the logger target", async () => {
  const { call, logListeners, topics, dispose } = fixture();
  const system = await call("GET", "system");
  expect(system.body).toEqual({ port: 5140, host: "127.0.0.1", baseDir: "/private/runtime", nodeVersion: process.version, uptime: expect.any(Number) });
  expect(logListeners).toHaveLength(1);
  for (let id = 1; id <= 505; id++)
    logListeners[0]!({
      id,
      timestamp: Date.now(),
      level: "info",
      name: "example",
      content: `line ${id} named-secret schema-secret Bearer other-secret`,
    });
  const notify = vi.fn();
  const off = topics.get("logs")!.subscribe(notify);
  logListeners[0]!({ id: 506, timestamp: 2000000000000, level: "warn", name: "example", content: "apiKey=external-secret" });
  expect(notify).toHaveBeenCalledTimes(1);
  off();
  const body = (await topics.get("logs")!.get({ role: "owner" } as never)) as LogsSnapshot;
  expect(body.entries).toHaveLength(500);
  expect(body.entries[0].id).toBe(7);
  expect(body.entries.at(-1)).toEqual({ id: 506, timestamp: 2000000000000, level: "warn", name: "example", content: "apiKey=[redacted]" });
  for (const value of ["named-secret", "schema-secret", "other-secret", "external-secret"]) expect(JSON.stringify(body)).not.toContain(value);
  dispose();
  expect(logListeners).toHaveLength(0);
  expect(topics.get("logs")).toBeUndefined();
});

it("redacts authorization headers, URL credentials, and quoted secrets", () => {
  expect(redactLog('https://user:pass@host.test Authorization: Bearer abcd {"password":"hello world"}', [])).toBe(
    'https://[redacted]@host.test Authorization: [redacted] [redacted] {"password":[redacted]}',
  );
});

it("redacts submitted schema secrets even when Loader fails and rolls configuration back", async () => {
  const { call, target, topics } = fixture();
  fake.update.mockImplementationOnce(async () => {
    target.record!({ id: 1, timestamp: Date.now(), type: "error", level: 1, name: "example", content: "apply failed with new-custom-secret", meta: {} });
    throw new ConfigError(503, "apply_failed", undefined, true);
  });
  expect((await call("POST", "plugins/update", { revision: "v1", path: "example", config: { custom: "new-custom-secret" } })).status).toBe(503);
  const logs = await topics.get("logs")!.get({ role: "owner" } as never);
  expect(JSON.stringify(logs)).not.toContain("new-custom-secret");
  expect(JSON.stringify(logs)).toContain("[redacted]");
});

it("rechecks the session after asynchronous configuration reads", async () => {
  const { call, current } = fixture();
  fake.read.mockImplementationOnce(async () => {
    current.session = undefined;
    return { revision: "v1", config: { private: "owner-only" } };
  });
  const response = await call("GET", "plugins/config", undefined, { query: { path: "example" } });
  expect([response.status, response.body]).toEqual([401, { message: "login_required" }]);
});

it("does not recursively expand redaction markers for short configured secrets", () => {
  expect(redactLog("abc", ["a", "b", "c", "d", "e"])).toBe("[redacted][redacted][redacted]");
  expect(redactLog("literal .+ secret", [".+"])).toBe("literal [redacted] secret");
});

it("reports the actual server listener when address settings live in the server plugin", async () => {
  const { call, config, ctx } = fixture();
  Reflect.deleteProperty(config, "port");
  Reflect.deleteProperty(config, "host");
  Object.assign(ctx.server, { port: 5141, listenHost: "0.0.0.0" });
  const system = await call("GET", "system");
  expect(system.body).toMatchObject({ port: 5141, host: "0.0.0.0" });
  // The bound port also wins over a legacy root-level configured port.
  Object.assign(config, { port: 1234, host: "legacy-host" });
  expect((await call("GET", "system")).body).toMatchObject({ port: 5141, host: "0.0.0.0" });
});

it("drops records from before this process started", async () => {
  const { target, topics } = fixture();
  target.record!({ id: 1001, timestamp: 1, type: "info", level: 2, name: "old", content: "previous boot", meta: {} });
  target.record!({ id: 1002, timestamp: Date.now(), type: "info", level: 2, name: "current", content: "this boot", meta: {} });
  const logs = (await topics.get("logs")!.get({ role: "owner" } as never)) as LogsSnapshot;
  expect(logs.entries.map((row) => row.id)).toEqual([1002]);
});

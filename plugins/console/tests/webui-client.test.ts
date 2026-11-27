import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it, vi } from "vitest";
import { createMemoryHistory } from "vue-router";

import { vueFlags } from "../web/build-flags.mjs";
import { formatSessionName } from "../web/src/lib/format";
import { createLiveClient } from "../web/src/lib/live";
import { listCodec, nextQuery, numberCodec, readQuery } from "../web/src/lib/route-state";
import { createSession, safeReturnPath } from "../web/src/lib/session";
import { botHealth, statusRows } from "../web/src/pages/overview-model";
import { createAppRouter, createRoutes } from "../web/src/router";
import { createDraft } from "./legacy-draft-fixture";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0)) await task();
  vi.restoreAllMocks();
});

const features = { napcat: true, accounts: false, tenant: false, usage: true };
function bootstrapFetch(authenticated: () => boolean, calls: string[] = []) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(path);
    if (path === "/yesimbot/admin/login") {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ message: "bad" }), { status: body.password === "right-password" ? 200 : 401 });
    }
    const ok = authenticated();
    return new Response(
      JSON.stringify({ authenticated: ok, features, ...(ok ? { session: { username: "owner", role: "owner", expiresAt: Date.now() + 60_000 } } : {}) }),
    );
  }) as unknown as typeof fetch;
}

const stubRoutes = () => createRoutes().map((route) => ({ ...route, component: { render: () => null } }) as never);

it("keeps the exact page and view state across a refresh and returns there after login", async () => {
  let signedIn = false;
  const calls: string[] = [];
  const session = createSession(bootstrapFetch(() => signedIn, calls));
  const router = createAppRouter(session, createMemoryHistory(), stubRoutes());

  const target = router.resolve("/settings/models?connection=a&tab=chat").fullPath;
  await router.push(target);
  expect(router.currentRoute.value.name).toBe("login");
  expect(router.currentRoute.value.query.returnTo).toBe(target);

  signedIn = true;
  await session.login("", "right-password");
  await router.replace(safeReturnPath(router.currentRoute.value.query.returnTo));
  expect(router.currentRoute.value.path).toBe("/settings/models");
  expect(router.currentRoute.value.query).toEqual({ connection: "a", tab: "chat" });

  // A refresh is a fresh router reading the same URL: no detour to the overview.
  const refreshed = createAppRouter(createSession(bootstrapFetch(() => true)), createMemoryHistory(), stubRoutes());
  await refreshed.push(target);
  expect(refreshed.currentRoute.value.path).toBe("/settings/models");
  expect(refreshed.currentRoute.value.query).toEqual({ connection: "a", tab: "chat" });
  // A bookmark from the previous navigation lands on the same view.
  await refreshed.push("/models?connection=a&tab=chat");
  expect(refreshed.currentRoute.value.fullPath).toBe(target);
  await refreshed.push("/no/such/page");
  expect(refreshed.currentRoute.value.name).toBe("not-found");
});

it("bootstraps once and navigates warm without network requests", async () => {
  const calls: string[] = [];
  const session = createSession(bootstrapFetch(() => true, calls));
  const router = createAppRouter(session, createMemoryHistory(), stubRoutes());
  await Promise.all([router.push("/"), session.ensure()]);
  for (const path of ["/settings/models", "/platforms", "/plugins", "/", "/usage"]) await router.push(path);
  expect(calls.filter((path) => path.endsWith("/bootstrap"))).toHaveLength(1);

  const failed = createSession(bootstrapFetch(() => false));
  await expect(failed.login("", "wrong")).rejects.toMatchObject({ status: 401 });
  expect(safeReturnPath("//evil.example")).toBe("/");
  expect(safeReturnPath("/login?x=1")).toBe("/");
  expect(safeReturnPath("/platforms")).toBe("/platforms");
});

class FakeSource {
  static instances: FakeSource[] = [];
  readyState = 0;
  listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string) {
    FakeSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    if (type !== "error") this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(data === undefined ? {} : { data: JSON.stringify(data) });
  }
  close() {
    this.readyState = 2;
  }
}

it("keeps data through disconnects, retries hard failures and never reloads the page", async () => {
  FakeSource.instances = [];
  const reload = vi.fn();
  vi.stubGlobal("location", { reload, assign: reload, replace: reload });
  cleanup.push(() => vi.unstubAllGlobals());
  const sessionEnded = vi.fn();
  const scheduled: Array<() => void> = [];
  const live = createLiveClient({
    createSource: (url) => new FakeSource(url),
    onSessionEnded: sessionEnded,
    onHardFailure: async () => true,
    schedule: (fn) => scheduled.push(fn),
  });
  const panel = live.use<{ value: number }>("panel");
  const other = live.use("conversations");
  await Promise.resolve();
  expect(FakeSource.instances).toHaveLength(1);
  expect(FakeSource.instances[0].url).toBe("/yesimbot/api/v1/events?topics=conversations%2Cpanel");

  const first = FakeSource.instances[0];
  first.emit("snapshot", { topic: "panel", revision: 1, data: { value: 1 } });
  expect(panel.state).toMatchObject({ data: { value: 1 }, stale: false });
  expect(live.status.value).toBe("open");

  // Network drop: the browser keeps retrying; data stays visible but stale.
  first.emit("error");
  expect(panel.state).toMatchObject({ data: { value: 1 }, stale: true });
  expect(live.status.value).toBe("reconnecting");
  first.emit("update", { topic: "panel", revision: 2, data: { value: 2 } });
  expect(panel.state).toMatchObject({ data: { value: 2 }, stale: false });

  // Hard failure (HTTP error closes the source): retried with backoff by us.
  first.readyState = 2;
  first.emit("error");
  await vi.waitFor(() => expect(scheduled).toHaveLength(1));
  scheduled[0]();
  await Promise.resolve();
  expect(FakeSource.instances).toHaveLength(2);

  other.release();
  await Promise.resolve();
  expect(FakeSource.instances.at(-1)!.url).toBe("/yesimbot/api/v1/events?topics=panel");

  FakeSource.instances.at(-1)!.emit("closed", { code: "session_ended" });
  expect(sessionEnded).toHaveBeenCalledOnce();
  expect(panel.state.data).toEqual({ value: 2 });
  expect(reload).not.toHaveBeenCalled();
  live.stop();
});

it("stores view state in the query without default noise", () => {
  expect(nextQuery({ a: "1" }, "page", 3, 1, numberCodec)).toEqual({ a: "1", page: "3" });
  expect(nextQuery({ page: "3" }, "page", 1, 1, numberCodec)).toEqual({});
  expect(readQuery({ page: "x" }, "page", 1, numberCodec)).toBe(1);
  expect(readQuery({ tags: "a,b" }, "tags", [], listCodec)).toEqual(["a", "b"]);
});

it("persists drafts per page and tolerates unavailable storage", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const draft = createDraft<{ name: string }>("models", 1, storage);
  draft.save({ name: "x" });
  expect(draft.load()?.value).toEqual({ name: "x" });
  expect(createDraft("models", 2, storage).load()).toBeUndefined();
  draft.clear();
  expect(draft.load()).toBeUndefined();
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {},
  };
  const safe = createDraft("x", 1, broken);
  expect(() => safe.save(1)).not.toThrow();
  expect(safe.load()).toBeUndefined();
});

it("summarizes the bot status from panel data and the bound computers", () => {
  const panel = {
    generatedAt: "",
    health: { online: true, botCount: 2, botErrorCount: 0, memory: { app: 1, total: 2 }, uptimeSeconds: 1 },
    model: {
      chatModel: "p:chat",
      visionModel: null,
      defaultChat: null,
      defaultEmbedding: null,
      providers: ["p"],
      chatModels: 2,
      embeddingModels: 0,
      imageInput: true,
      imageBudget: null,
      describeImage: false,
    },
    config: { basePath: "", allowedChannels: 0, configPath: "" },
    plugins: [{ key: "yesimbot-memorizer:a", label: "A", enabled: true, status: "attention", detail: "", configPath: "" }],
    adapters: [{ key: "o", name: "OneBot", platform: "onebot", enabled: true, state: "online", configPath: "" }],
    onboarding: { complete: true, steps: [] },
    recent: [],
    attention: [],
  } satisfies Parameters<typeof statusRows>[0];
  const rows = statusRows(panel);
  expect(rows.find((row) => row.id === "platforms")).toMatchObject({
    label: "聊天平台",
    value: "在线",
    detail: "QQ 在线",
    tone: "ok",
    to: "/settings/platforms",
  });
  // All platforms offered by the platform page share the same overview status.
  const withoutQQ = statusRows({
    ...panel,
    adapters: [{ key: "x", name: "微信", platform: "wechat-bridge", enabled: true, state: "online", configPath: "" }],
  }).find((row) => row.id === "platforms");
  expect(withoutQQ).toMatchObject({ value: "在线", detail: "微信 在线", tone: "ok" });
  const both = statusRows({
    ...panel,
    adapters: [...panel.adapters, { key: "w", name: "微信", platform: "wechat-bridge", enabled: true, state: "error", error: "设备离线", configPath: "" }],
  }).find((row) => row.id === "platforms");
  // The link opens the platform that needs a look.
  expect(both).toMatchObject({ value: "1/2 个在线", detail: "设备离线", tone: "danger", to: "/settings/platforms?platform=wechat-bridge" });
  expect(rows.map((row) => [row.id, row.value, row.detail, row.tone, row.to])).toEqual([
    ["platforms", "在线", "QQ 在线", "ok", "/settings/platforms"],
    ["model", "chat", "p", "ok", "/settings/models"],
  ]);
  const device = (name: string, online: boolean, revokedAt?: number) =>
    ({ deviceId: name, tenantId: "t", name, platform: "linux", capabilities: ["computer.shell"], createdAt: 0, online, revokedAt }) as const;
  const computer = (computers: Parameters<typeof statusRows>[2]) => statusRows(panel, undefined, computers).find((row) => row.id === "computer");
  expect(computer([device("A", true)])).toMatchObject({ value: "在线", detail: "A", tone: "ok", to: "/settings/extensions?section=yesimbot-workspace" });
  expect(computer([device("A", false), device("B", true), device("C", true, 1)])).toMatchObject({ value: "1/2 台在线", detail: "A、B", tone: "ok" });
  expect(computer([device("A", false)])).toMatchObject({ value: "离线", tone: "warn" });
  expect(computer([])).toMatchObject({ value: "还没有接入", tone: "" });
  expect(botHealth(panel)).toEqual({ tone: "ok", title: "运行正常" });
  expect(botHealth({ ...panel, attention: [{ level: "warning", message: "x" }] }).tone).toBe("warn");
  expect(botHealth({ ...panel, health: { ...panel.health, online: false } })).toEqual({ tone: "danger", title: "机器人离线" });
  expect(botHealth(undefined).tone).toBe("idle");
});

it("ships the whole app as one script and one stylesheet", async () => {
  const { build } = await import("vite");
  const { default: vue } = await import("@vitejs/plugin-vue");
  const outDir = await mkdtemp(join(tmpdir(), "yesimbot-web-build-"));
  cleanup.push(() => rm(outDir, { recursive: true, force: true }));
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({
      root: fileURLToPath(new URL("../web", import.meta.url)),
      configFile: false,
      logLevel: "silent",
      // Vitest sets NODE_ENV=test; compile SFCs exactly as the production build does.
      plugins: [vue({ isProduction: true })],
      // Measure what ships: vitest sets NODE_ENV=test, which would otherwise bundle Vue's dev build.
      mode: "production",
      define: { "process.env.NODE_ENV": JSON.stringify("production"), ...vueFlags },
      build: { outDir, emptyOutDir: true, target: "es2020", modulePreload: { polyfill: false } },
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  const html = readFileSync(join(outDir, "index.html"), "utf8");
  const initial = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  expect(initial.some((path) => path.endsWith(".js"))).toBe(true);
  // Every page ships in the first load: each extra request costs seconds on the public path. There is no
  // byte limit (user decision 2026-11-07); only the single script + stylesheet shape is checked.
  expect(initial.filter((path) => path.endsWith(".js"))).toHaveLength(1);
  expect(initial.filter((path) => path.endsWith(".css"))).toHaveLength(1);
  expect(html).not.toMatch(/koishi|element/i);
}, 60_000);

it("merges several query writes issued in the same tick", async () => {
  const { writeQuery, stringCodec } = await import("../web/src/lib/route-state");
  const session = createSession(bootstrapFetch(() => true));
  const router = createAppRouter(session, createMemoryHistory(), stubRoutes());
  await router.push("/?c=chat&page=4");
  await Promise.all([writeQuery(router, "q", "abc", "", stringCodec), writeQuery(router, "page", 1, 1, numberCodec)]);
  expect(router.currentRoute.value.query).toEqual({ c: "chat", q: "abc" });
});

it("shows UTC session file names in local time", () => {
  const local = new Date(Date.UTC(2026, 9, 29, 2, 30, 56));
  const pad = (n: number) => String(n).padStart(2, "0");
  expect(formatSessionName("20261029T023056Z.jsonl")).toBe(
    `${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`,
  );
  expect(formatSessionName("20261029T023056")).toBe("10-29 02:30");
  expect(formatSessionName("legacy-name.jsonl")).toBe("legacy-name");
});

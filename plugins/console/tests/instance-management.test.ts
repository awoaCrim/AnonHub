import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppError, defineModuleConfig } from "@yesimbot/foundation";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { ConfigStore } from "../src/config/store.js";
import type { InstalledPackage } from "../src/host.js";
import { createInstanceTools, installInstanceManagement } from "../src/instance-management.js";
import { webChatContext } from "../src/webui/chat-bot.js";
import { fakeHost } from "./fixtures/fake-host.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

async function fixture() {
  const ctx = fakeHost();
  const config = {
    plugins: {
      "yesimbot:main": {
        basePath: "host-only",
        logLevel: 2,
        session: { compact: { enabled: true } },
        admins: [{ platform: "onebot", userId: "10001" }],
        password: "saved-secret",
        future: { retained: true },
      },
      "yesimbot-schedule:local": { password: "saved-secret", future: { retained: true } },
      "yesimbot-google:google": { clientId: "shared-app", clientSecret: "shared-secret", redirectUri: "https://console.test/callback", password: "own-secret" },
      "yesimbot-mcp-client:mcp": { mcpServers: { native: { command: "/host/bin/tool", env: { SECRET: "native-secret" } } } },
      "yesimbot-model-provider:models": { apiKey: "host-model-key" },
      "http:host": { password: "infrastructure-secret" },
      "yesimbot-console:admin": { admin: { enabled: true } },
      "native-operator-plugin:private": { password: "operator-secret" },
    },
  };
  const shape = defineModuleConfig(
    "instance-fixture",
    z.looseObject({
      basePath: z.string().optional(),
      logLevel: z.number().optional(),
      session: z.any().optional(),
      password: z.string().optional().meta({ secret: true }),
      future: z.any().optional(),
      admins: z.array(z.object({ platform: z.string(), userId: z.string() })).optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional().meta({ secret: true }),
      redirectUri: z.string().optional(),
      mcpServers: z
        .record(
          z.string(),
          z.object({
            type: z.string().optional(),
            command: z.string().optional(),
            url: z.string().optional(),
            env: z.union([z.record(z.string(), z.string()), z.string()]).optional(),
            headers: z.union([z.record(z.string(), z.string()), z.string()]).optional(),
          }),
        )
        .optional(),
    }),
  );
  const loader = {
    config,
    entry: ctx,
    writable: true,
    isTruthyLike: () => true,
    resolve: vi.fn(async () => ({ moduleConfig: shape })),
    reload: vi.fn(async () => ({ isActive: true })),
    unload: vi.fn(),
    writeConfig: vi.fn(async () => {}),
  };
  Object.assign(ctx, { loader });
  const use = vi.fn(() => vi.fn());
  // The owner's message reaches a stub messenger: only the authentication it carries matters here.
  const core = { agent: { use }, identity: {}, messenger: { accept: vi.fn(async () => {}) } };
  Object.assign(ctx, { yesimbot: core });
  const bot = ctx.openWebChat(() => {});
  let authenticated = true;
  await bot.receive("owner", "hello", "message", Date.now(), "", [], () => authenticated);
  const host = ctx;
  const store = new ConfigStore(host, { selfService: true });
  const extensions = { list: vi.fn((): InstalledPackage[] => []), install: vi.fn((name: unknown) => ({ name: String(name) })), remove: vi.fn(async () => {}) };
  Object.assign(ctx, { extensions });
  const logSecrets = new Set<string>();
  const tools = (role: "main" | "computer" | "content" | "service" = "service") =>
    createInstanceTools(host, store, { scope: webChatContext, bot, role, logSecrets });
  const call = (name: string, value: unknown = {}, role: "main" | "service" = "service") =>
    tools(role)
      .find((tool) => tool.name === name)!
      .execute(value, {} as never);
  return {
    ctx,
    host,
    core,
    config,
    loader,
    bot,
    store,
    extensions,
    logSecrets,
    tools,
    call,
    use,
    expire: () => {
      authenticated = false;
    },
  };
}

it("registers the same instance service for every role, with writes for the main agent and a service worker only", async () => {
  const f = await fixture();
  installInstanceManagement(f.host, f.logSecrets);
  const plugin = f.use.mock.calls[0][0] as never as { setup: Function };
  const main = plugin.setup(webChatContext, f.bot, { executionRole: "main" });
  const worker = plugin.setup(webChatContext, f.bot, { executionRole: "service" });
  const computer = plugin.setup(webChatContext, f.bot, { executionRole: "computer" });
  const writes = [
    "instance_config_write",
    "instance_extension_write",
    "instance_mcp_script_install",
    "instance_task_control",
    "instance_schedule_update",
    "instance_schedule_delete",
  ];
  // Like Muse, the main agent makes simple instance changes itself; a computer or content worker only reads.
  for (const role of [main, worker]) expect(role.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(writes));
  expect(main.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["instance_config_read", "instance_tasks", "instance_schedules", "instance_connections"]),
  );
  expect(computer.tools.every((tool) => tool.capability.executionKind === "read")).toBe(true);
  expect(computer.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["instance_tasks", "instance_schedules"]));
  expect(worker.tools.every((tool) => tool.capability.platforms[0] === "web" && tool.capability.sensitive)).toBe(true);
  f.expire();
  expect(plugin.setup(webChatContext, f.bot, { executionRole: "service" })).toBeNull();
});

it("derives the instance from its trusted transport and rejects forged, expired or foreign runtime contexts", async () => {
  const f = await fixture();
  const other = await fixture();
  expect(
    createInstanceTools(other.host, other.store, {
      scope: webChatContext,
      bot: f.bot,
      role: "service",
      logSecrets: other.logSecrets,
    }),
  ).toEqual([]);
  expect(
    createInstanceTools(f.host, f.store, {
      scope: { ...webChatContext, platform: "onebot" },
      bot: f.bot,
      role: "service",
      logSecrets: f.logSecrets,
    }),
  ).toEqual([]);
  expect(
    createInstanceTools(f.host, f.store, {
      scope: webChatContext,
      bot: { platform: "web", selfId: "bot" } as never,
      role: "service",
      logSecrets: f.logSecrets,
    }),
  ).toEqual([]);
  const retained = f.tools().find((tool) => tool.name === "instance_config_write")!;
  f.expire();
  expect(await retained.execute({ action: "update", path: "yesimbot-schedule:local", revision: f.store.revision(), config: {} }, {} as never)).toEqual({
    error: "instance_authentication_required",
  });
  expect(f.loader.writeConfig).not.toHaveBeenCalled();
});

it("reads projected schemas and masked config while preserving fields and rejecting stale revisions or host changes", async () => {
  const f = await fixture();
  const read = await f.call("instance_config_read", { action: "read", path: "yesimbot:main" });
  expect(read.config).toEqual({ password: { $secret: true, sourcePath: ["password"] }, future: { retained: true } });
  expect(JSON.stringify(read.schema)).not.toContain("basePath");
  const result = await f.call("instance_config_write", {
    action: "update",
    path: "yesimbot:main",
    revision: read.revision,
    config: { ...read.config, password: "new-secret" },
  });
  expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(f.config.plugins["yesimbot:main"]).toEqual({
    basePath: "host-only",
    logLevel: 2,
    session: { compact: { enabled: true } },
    admins: [{ platform: "onebot", userId: "10001" }],
    password: "new-secret",
    future: { retained: true },
  });
  expect(f.logSecrets.has("new-secret")).toBe(true);
  expect(await f.call("instance_config_write", { action: "update", path: "yesimbot:main", revision: read.revision, config: read.config })).toMatchObject({
    error: "config_changed",
    status: 409,
  });
  expect(
    await f.call("instance_config_write", {
      action: "update",
      path: "yesimbot:main",
      revision: f.store.revision(),
      config: { ...read.config, basePath: "/other-instance" },
    }),
  ).toMatchObject({ error: "locked", status: 403 });
  expect(
    await f.call("instance_config_write", { action: "update", tenantId: "another-instance", path: "yesimbot:main", revision: f.store.revision(), config: {} }),
  ).toEqual({
    error: "invalid_instance_request",
  });
  expect(f.loader.writeConfig).toHaveBeenCalledTimes(1);
});

it("never lets the bot read or change the admins that decide who may use sensitive tools", async () => {
  const f = await fixture();
  const read = await f.call("instance_config_read", { action: "read", path: "yesimbot:main" });
  expect(JSON.stringify(read)).not.toContain("10001");
  expect(JSON.stringify(read.schema)).not.toContain("admins");
  expect(
    await f.call("instance_config_write", {
      action: "update",
      path: "yesimbot:main",
      revision: read.revision,
      config: { ...read.config, admins: [{ platform: "onebot", userId: "666" }] },
    }),
  ).toMatchObject({ error: "locked", status: 403 });
  // Omitting the field keeps it; the saved list is untouched either way.
  await f.call("instance_config_write", {
    action: "update",
    path: "yesimbot:main",
    revision: read.revision,
    config: { ...read.config, future: { retained: false } },
  });
  expect(f.config.plugins["yesimbot:main"].admins).toEqual([{ platform: "onebot", userId: "10001" }]);
});

it("keeps infrastructure and shared Google app settings outside self-service edits", async () => {
  const f = await fixture();
  const snapshot = await f.call("instance_config_read", { action: "list" });
  expect(snapshot.tree.map((entry) => entry.name)).not.toContain("http");
  expect(snapshot.tree.map((entry) => entry.name)).not.toContain("native-operator-plugin");
  expect(await f.call("instance_config_read", { action: "read", path: "http:host" })).toMatchObject({ error: "not_found" });
  expect(await f.call("instance_config_read", { action: "read", path: "yesimbot-model-provider:models" })).toMatchObject({ error: "locked" });
  expect(await f.call("instance_config_read", { action: "read", path: "native-operator-plugin:private" })).toMatchObject({ error: "not_permitted" });
  for (const [path, field, value] of [["yesimbot-google:google", "clientId", "other-app"]] as const) {
    const read = await f.call("instance_config_read", { action: "read", path });
    expect(read.config[field]).toBeUndefined();
    expect(
      await f.call("instance_config_write", { action: "update", path, revision: read.revision, config: { ...read.config, [field]: value } }),
    ).toMatchObject({
      error: "locked",
    });
  }
  expect(f.loader.writeConfig).not.toHaveBeenCalled();
});

// User, 2026-11-18: the bot could not add an MCP server it had built (「全部放开」, stdio included).
it("lets the bot manage MCP servers while their env and header values stay hidden from it", async () => {
  const f = await fixture();
  const read = await f.call("instance_config_read", { action: "read", path: "yesimbot-mcp-client:mcp" });
  // env may be one text block, so it is hidden as a whole; passing the marker back keeps it.
  expect(read.config.mcpServers.native).toEqual({ command: "/host/bin/tool", env: { $secret: true, sourcePath: ["mcpServers", "native", "env"] } });
  expect(JSON.stringify(read)).not.toContain("native-secret");
  const config = {
    mcpServers: {
      ...read.config.mcpServers,
      fxtwitter: { type: "stdio", command: "node", env: { TOKEN: "new-token" } },
      remote: { type: "http", url: "https://mcp.example.test/mcp", headers: "Authorization: Bearer remote-token" },
    },
  };
  expect(
    await f.call("instance_config_write", { action: "update", path: "yesimbot-mcp-client:mcp", revision: read.revision, config }, "main"),
  ).not.toHaveProperty("error");
  expect(f.config.plugins["yesimbot-mcp-client:mcp"]).toEqual({
    mcpServers: {
      native: { command: "/host/bin/tool", env: { SECRET: "native-secret" } },
      fxtwitter: { type: "stdio", command: "node", env: { TOKEN: "new-token" } },
      remote: { type: "http", url: "https://mcp.example.test/mcp", headers: "Authorization: Bearer remote-token" },
    },
  });
  // New credentials are scrubbed from the logs like any other secret.
  expect([...f.logSecrets]).toEqual(expect.arrayContaining(["new-token", "Authorization: Bearer remote-token"]));
  const again = await f.call("instance_config_read", { action: "read", path: "yesimbot-mcp-client:mcp" });
  expect(JSON.stringify(again)).not.toMatch(/new-token|remote-token|native-secret/);
});

// User, 2026-11-19: the bot sets MCP up by itself; scripts it wrote on its computer run in the main program.
it("copies an MCP script from the conversation's computer into this instance and answers the stdio entry that runs it", async () => {
  const f = await fixture();
  const base = await mkdtemp(join(tmpdir(), "yesimbot-mcp-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  f.ctx.baseDir = base;
  const script = "#!/usr/bin/env node\nconsole.log('mcp');\n";
  const invoke = vi.fn(async (_device: string, request: { input: { path: string } }) =>
    request.input.path === "fxtwitter-mcp.mjs"
      ? { status: "succeeded", output: { data: Buffer.from(script).toString("base64") } }
      : { status: "rejected", code: "not_found" },
  );
  Object.assign(f.core, { devices: { workspaceDevice: () => "computer-1", invoke } });
  const install = (value: unknown) =>
    f
      .tools("main")
      .find((tool) => tool.name === "instance_mcp_script_install")!
      .execute(value, { messages: [], abortSignal: new AbortController().signal } as never);

  const result = await install({ path: "fxtwitter-mcp.mjs" });
  const target = join(base, "mcp", "fxtwitter-mcp.mjs");
  expect(result).toMatchObject({ path: target, replaced: false, stdio: { type: "stdio", command: "node", args: [target] } });
  expect(await readFile(target, "utf8")).toBe(script);
  expect((await stat(target)).mode & 0o777).toBe(0o600);
  expect(invoke).toHaveBeenCalledWith(
    "computer-1",
    expect.objectContaining({ capability: "workspace.files", method: "read", input: { path: "fxtwitter-mcp.mjs" } }),
    expect.anything(),
  );
  expect(await install({ path: "fxtwitter-mcp.mjs" })).toMatchObject({ replaced: true });

  // The computer's own refusal comes back; names stay inside the MCP directory and Node-only.
  expect(await install({ path: "missing.mjs" })).toEqual({ error: "mcp_script_read_failed", computer: { status: "rejected", code: "not_found" } });
  for (const name of ["../escape.mjs", "tool.py", ".hidden.mjs", "a/b.mjs"])
    expect(await install({ path: "fxtwitter-mcp.mjs", name })).toEqual({ error: "invalid_mcp_script_name" });
  Object.assign(f.core, { devices: { workspaceDevice: () => undefined, invoke } });
  expect(await install({ path: "fxtwitter-mcp.mjs" })).toEqual({ error: "mcp_computer_unavailable" });
  // A computer or content worker never changes the instance.
  expect(f.tools("computer").map((tool) => tool.name)).not.toContain("instance_mcp_script_install");
});

it("restores the previous configuration when an apply fails and never reads unschematized secrets", async () => {
  const f = await fixture();
  const before = structuredClone(f.config);
  const read = await f.call("instance_config_read", { action: "read", path: "yesimbot-schedule:local" });
  f.loader.reload.mockResolvedValueOnce({ isActive: false });
  expect(
    await f.call("instance_config_write", { action: "update", path: "yesimbot-schedule:local", revision: read.revision, config: { password: "new-password" } }),
  ).toMatchObject({ error: "apply_failed", restored: true });
  expect(f.config).toEqual(before);
  f.loader.resolve.mockResolvedValue({} as never);
  f.store.catalog.invalidate();
  expect(await f.call("instance_config_read", { action: "read", path: "yesimbot-schedule:local" })).toEqual({ error: "schema_unavailable" });
});

it("reads connections without touching the chat: public account fields and the settings page, never an OAuth URL or credentials", async () => {
  const f = await fixture();
  const snapshot = vi.fn(async () => ({
    available: true,
    configured: true,
    clientSecret: "private-client",
    accounts: [
      { id: "account", email: "owner@example.test", permissions: { gmail: "read" }, connectedAt: 1, needsReconnect: false, accessToken: "private-token" },
    ],
  }));
  f.ctx.services.set("yesimbotGoogle", { snapshot });
  const result = await f.call("instance_connections");
  expect(result.services[0].settingsPath).toBe("/settings/connections");
  expect(result.services[0]).not.toHaveProperty("action");
  expect(result.services[0].accounts[0].email).toBe("owner@example.test");
  expect(JSON.stringify(result)).not.toMatch(/private-client|private-token|authorizationUrl/);
});

// User, 2026-11-26: connectors, MCP and extensions are added by the user or by the bot itself (「最好也允许bot自行添加」).
it("lets the main agent and a service worker install and remove an extension from npm, never a computer worker", async () => {
  const f = await fixture();
  expect(await f.call("instance_extension_write", { action: "install", name: "yesimbot-extension-weather" }, "main")).toEqual({
    name: "yesimbot-extension-weather",
    status: "installing",
  });
  expect(f.extensions.install).toHaveBeenCalledWith("yesimbot-extension-weather", undefined);
  f.extensions.list.mockReturnValue([{ name: "yesimbot-extension-weather", version: "1.0.0", module: "weather", state: { state: "running" } }]);
  expect(await f.call("instance_extension_read", {}, "main")).toEqual({
    items: [{ name: "yesimbot-extension-weather", version: "1.0.0", module: "weather", status: "running" }],
  });
  expect(await f.call("instance_extension_write", { action: "remove", name: "yesimbot-extension-weather" })).toEqual({ ok: true });
  expect(f.extensions.remove).toHaveBeenCalledWith("yesimbot-extension-weather");
  expect(f.tools("computer").some((tool) => tool.name === "instance_extension_write")).toBe(false);
});

it("lets the bot and a member's own console edit an installed extension, which neither the catalog nor the grant lists", async () => {
  const f = await fixture();
  Object.assign(f.config.plugins, { weather: { city: "上海" } });
  expect(f.store.permitted("weather")).toBe(false);
  f.extensions.list.mockReturnValue([{ name: "yesimbot-extension-weather", version: "1.0.0", module: "weather", state: { state: "running" } }]);
  expect(f.store.permitted("weather")).toBe(true);
  expect(f.store.listed("weather")).toBe(true);
  vi.stubEnv("YESIMBOT_TENANT_ID", "4b0b0c9e-5c43-4f6a-9d3e-0a1b2c3d4e5f");
  try {
    const member = new ConfigStore(f.host);
    expect(member.permitted("weather")).toBe(true);
    expect(member.permitted("yesimbot-xiaoheihe")).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("returns a refused install's registered code to the bot", async () => {
  const f = await fixture();
  f.extensions.install.mockImplementation(() => {
    throw new AppError("input_invalid", { effect: "none" });
  });
  expect(await f.call("instance_extension_write", { action: "install", name: "Bad Name" }, "main")).toEqual({ error: "input_invalid" });
});

it("rechecks browser authentication when a queued configuration mutation reaches the shared writer", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = f.store.transaction(f.store.revision(), () => gate);
  const pending = f.call("instance_config_write", {
    action: "update",
    path: "yesimbot-schedule:local",
    revision: f.store.revision(),
    config: { password: "changed" },
  });
  await vi.waitFor(() => expect(f.loader.resolve).toHaveBeenCalled());
  f.expire();
  release();
  await blocked;
  expect(await pending).toEqual({ error: "instance_authentication_required" });
  expect(f.loader.writeConfig).not.toHaveBeenCalled();
});

it("lets the main agent see and manage background tasks across every conversation", async () => {
  const f = await fixture();
  const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const rows = [
    {
      id: id(1),
      channel: "direct-onebot-1",
      session: "s.jsonl",
      kind: "computer",
      status: "running",
      instruction: "很长的说明".repeat(40),
      createdAt: 1,
      updatedAt: 5,
      key: "k1",
    },
    {
      id: id(2),
      channel: "shared-onebot-216",
      session: "s.jsonl",
      kind: "content",
      status: "waiting",
      instruction: "等人工",
      createdAt: 2,
      updatedAt: 4,
      key: "k2",
      handoff: { id: id(9), state: "pending", reason: "登录" },
    },
    ...Array.from({ length: 22 }, (_, n) => ({
      id: id(10 + n),
      channel: "direct-web-bot-owner",
      session: "s.jsonl",
      kind: "service",
      status: "succeeded",
      instruction: `done ${n}`,
      result: "ok",
      createdAt: 3,
      updatedAt: 3 - n / 100,
      key: `k${n}`,
      notification: "delivered",
      source: { secret: true },
    })),
  ];
  const tasks = {
    store: { list: vi.fn(async () => rows) },
    cancel: vi.fn(async (task: string) => ({ id: task, status: "cancelled" })),
    update: vi.fn(async (task: string, instruction: string) => ({ id: task, instruction })),
    resolveHandoff: vi.fn(async (task: string) => ({ id: task, status: "running" })),
  };
  Object.assign(f.core, { tasks });
  const overview = (await f.call("instance_tasks", {}, "main")) as {
    tasks: { id: string; conversation: string; instruction: string }[];
    olderFinished: number;
  };
  expect(overview.tasks.map((task) => task.id).slice(0, 2)).toEqual([id(1), id(2)]);
  expect(overview.tasks).toHaveLength(22);
  expect(overview.olderFinished).toBe(2);
  expect(overview.tasks[1]).toMatchObject({ conversation: "shared-onebot-216", handoff: { id: id(9), state: "pending" } });
  expect(Array.from(overview.tasks[0]!.instruction)).toHaveLength(101);
  const full = await f.call("instance_tasks", { id: id(10) }, "main");
  expect(full).toMatchObject({ id: id(10), conversation: "direct-web-bot-owner", result: "ok" });
  expect(JSON.stringify(full)).not.toMatch(/secret|"key"|notification/);
  expect(await f.call("instance_tasks", { id: id(99) }, "main")).toEqual({ error: "task_not_found" });

  expect(await f.call("instance_task_control", { id: id(1), action: "cancel" }, "main")).toEqual({ id: id(1), status: "cancelled" });
  expect(tasks.cancel).toHaveBeenCalledWith(id(1));
  expect(await f.call("instance_task_control", { id: id(1), action: "update", instruction: "  也看看日志  " }, "main")).toMatchObject({
    instruction: "也看看日志",
  });
  expect(await f.call("instance_task_control", { id: id(2), action: "resolve_handoff", handoffId: id(9) }, "main")).toMatchObject({ status: "running" });
  expect(tasks.resolveHandoff).toHaveBeenCalledWith(id(2), id(9), "");
  // Interrupted tasks have no reminder to close any more; the main conversation checks them itself.
  expect(await f.call("instance_task_control", { id: id(1), action: "dismiss" }, "main")).toEqual({ error: "invalid_instance_request" });
  expect(await f.call("instance_task_control", { id: id(1), action: "update" }, "main")).toEqual({ error: "invalid_instance_request" });
  expect(await f.call("instance_task_control", { id: "../x", action: "cancel" }, "main")).toEqual({ error: "invalid_instance_request" });
  // An expired login stops a change, even through a tool the turn already holds.
  const control = f.tools("main").find((tool) => tool.name === "instance_task_control")!;
  f.expire();
  expect(await control.execute({ id: id(1), action: "cancel" }, {} as never)).toEqual({ error: "instance_authentication_required" });
  expect(tasks.cancel).toHaveBeenCalledOnce();
});

it("lets the main agent see, change and delete schedules across every conversation, bound to their revision", async () => {
  const f = await fixture();
  const revision = "c".repeat(64);
  const row = (id: string, prompt: string) => ({
    id,
    revision,
    title: `t-${id}`,
    prompt,
    notes: null,
    platform: "onebot",
    selfId: "1",
    channelId: "216",
    type: "guild",
    kind: "cron",
    at: null,
    cron: "0 9 * * *",
    state: "enabled",
    purpose: "task",
    delivery: "channel",
    nextRunAt: "2026-11-18T01:00:00.000Z",
    lastResult: { occurrenceAt: "x", status: "completed", finishedAt: "y", notified: true, raw: "provider secret" },
    private: "hidden",
  });
  const manager = {
    list: vi.fn(async () => [row("a", "早报".repeat(100)), row("b", "签到")]),
    runs: vi.fn(async () => ({
      runs: [
        { id: "r1", scheduleId: "a", status: "completed", error: { code: "turn_failed", message: "raw" } },
        { id: "r2", scheduleId: "other" },
      ],
      nextCursor: "n1",
      retainedLimit: 50,
    })),
    update: vi.fn(async (id: string, current: string) => {
      if (current !== revision) throw Error("schedule_changed");
    }),
    delete: vi.fn(async () => {}),
  };
  const get = f.ctx.get.bind(f.ctx);
  vi.spyOn(f.ctx, "get").mockImplementation(((name: string) => (name === "yesimbotSchedule" ? manager : get(name))) as never);
  const listed = (await f.call("instance_schedules", {}, "main")) as { schedules: { id: string; prompt: string; channelId: string }[] };
  expect(listed.schedules.map((item) => [item.id, item.channelId])).toEqual([
    ["a", "216"],
    ["b", "216"],
  ]);
  expect(Array.from(listed.schedules[0]!.prompt)).toHaveLength(121);
  expect(JSON.stringify(listed)).not.toMatch(/provider secret|hidden/);
  const one = (await f.call("instance_schedules", { id: "a" }, "main")) as {
    schedule: { prompt: string };
    runs: { id: string; error?: unknown }[];
    nextCursor: string;
  };
  expect(one.schedule.prompt).toBe("早报".repeat(100));
  expect(one.runs).toEqual([expect.objectContaining({ id: "r1", error: { code: "turn_failed", message: "执行轮次失败，未确认任务完成。" } })]);
  expect(one.nextCursor).toBe("n1");
  expect(await f.call("instance_schedules", { id: "zz" }, "main")).toEqual({ error: "schedule_not_found" });

  expect(await f.call("instance_schedule_update", { id: "a", revision, patch: { title: "新早报" } }, "main")).toMatchObject({
    ok: true,
    schedule: { id: "a" },
  });
  expect(manager.update).toHaveBeenCalledWith("a", revision, { title: "新早报" });
  expect(await f.call("instance_schedule_update", { id: "a", revision: "d".repeat(64), patch: { title: "x" } }, "main")).toEqual({ error: "schedule_changed" });
  expect(await f.call("instance_schedule_update", { id: "a", revision, patch: { state: "paused" } }, "main")).toEqual({ error: "invalid_schedule" });
  expect(await f.call("instance_schedule_update", { id: "a", revision, patch: { kind: "cron" } }, "main")).toEqual({ error: "invalid_schedule" });
  expect(await f.call("instance_schedule_delete", { id: "b", revision }, "main")).toEqual({ ok: true, id: "b" });
  expect(manager.delete).toHaveBeenCalledWith("b", revision);
  expect(await f.call("instance_schedule_delete", { id: "b", revision: "short" }, "main")).toEqual({ error: "invalid_instance_request" });
  // The schedule plugin must be one this instance may manage.
  vi.spyOn(f.store, "permitted").mockReturnValue(false);
  expect(await f.call("instance_schedules", {}, "main")).toEqual({ error: "schedules_not_permitted" });
  expect(manager.update).toHaveBeenCalledTimes(2);
});

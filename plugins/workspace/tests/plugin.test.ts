import { mkdir, mkdtemp, rm, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EphemeralImageProjectionStore, type AgentTool } from "@yesimbot/agent-runtime";
import { configForm, manualClock, parseConfig } from "@yesimbot/foundation";
import { RuntimeIdentity } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { moduleConfig, WorkspaceService } from "../src/index.js";
import type { WorkspacePluginConfig } from "../src/types.js";

const Config = (raw: unknown) => parseConfig(moduleConfig, raw);

const tenant = "11111111-1111-4111-8111-111111111111";
const openPolicy = {
  version: 1 as const,
  direct: { enabled: true, tools: ["*"] },
  group: { enabled: true, tools: ["*"] },
  actors: [{ kind: "any" as const, platform: "*", conversationId: "*" }],
};

async function createWorkspace(config?: WorkspacePluginConfig) {
  const baseDir = await mkdtemp(join(tmpdir(), "yesimbot-workspace-test-"));
  const plugins: WorkspaceService[] = [];
  const readers: Array<{ scheme: string; setup: (...args: never[]) => unknown }> = [];
  const disposeAgent = vi.fn();
  const disposeReader = vi.fn();
  const ctx = {
    baseDir,
    logger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
    on: vi.fn(),
    yesimbot: {
      config: { basePath: "data/yesimbot" },
      identity: new RuntimeIdentity(baseDir, tenant),
      devices: {
        useWorkspaceResolver: vi.fn(() => vi.fn()),
        activity: new ComputerActivity(),
        invoke: vi.fn(async () => ({ status: "succeeded", output: { exitCode: 0 } })),
      },
      agent: {
        use: vi.fn((plugin: WorkspaceService) => {
          plugins.push(plugin);
          return disposeAgent;
        }),
      },
      resource: {
        use: vi.fn((reader: { scheme: string; setup: (...args: never[]) => unknown }) => {
          readers.push(reader);
          return disposeReader;
        }),
        get: vi.fn(async () => ({ path: baseDir, assets: {}, artifacts: {} })),
      },
    },
  };
  const resolvedConfig = config ?? { bash: { enableNetwork: false, mounts: [] } };
  const plugin = new WorkspaceService(
    { host: ctx.yesimbot as never, baseDir, clock: manualClock(Date.UTC(2026, 10, 24)) },
    { toolPolicy: openPolicy, ...resolvedConfig },
  );
  return { baseDir, ctx, config: resolvedConfig, disposeAgent, disposeReader, plugin, plugins, readers };
}

describe("WorkspacePlugin", () => {
  it("validates workspace and file-only configurations without creating computer settings", () => {
    for (const input of [{}, { storage: { kind: "conversation" } }, { storage: { kind: "device", deviceId: tenant } }]) {
      expect(Config(input).computer).toBeUndefined();
    }
    const computer = Config({ computer: { deviceId: tenant } });
    expect(computer.computer?.desktopModel).toBeUndefined();
    expect(computer).not.toHaveProperty("mode");
    expect(Config({ computer: {} }).computer?.deviceId).toBe("");
  });

  it("accepts an explicit sandbox default while selecting a visual model", async () => {
    const config = Config({ computer: { deviceId: "", desktopModel: "provider:vision" } });
    expect(config.computer?.deviceId).toBe("");
    expect(config.computer?.desktopModel).toBe("provider:vision");
    const fixture = await createWorkspace(config);
    try {
      await expect(fixture.plugin.start()).resolves.toBeUndefined();
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("describes its own form: titles and no separate computer switches", () => {
    const form = configForm(moduleConfig.schema) as { properties: Record<string, { title?: string; properties?: Record<string, unknown> }> };
    expect(form.properties).not.toHaveProperty("mode");
    expect(form.properties.computer?.title).toBe("自己的电脑");
    expect(Object.keys(form.properties.computer?.properties ?? {})).toEqual(["deviceId", "desktopModel"]);
    expect(form.properties.storage?.title).toBe("文件空间");
  });

  it("offers isolated device files and retains caller identity and operation IDs", async () => {
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const fixture = await createWorkspace({
      computer: { deviceId },
      toolPolicy: { ...openPolicy, direct: { enabled: true, tools: ["readFile", "writeFile", "listFiles"] } },
    });
    try {
      await fixture.plugin.start();
      const scope = { type: "direct" as const, platform: "onebot", selfId: "bot", channelId: "private:alice", userId: "alice" };
      const plugin = await fixture.plugin.setup(scope);
      const tools = plugin!.tools as import("@yesimbot/agent-runtime").AgentTool[];
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["readFile", "writeFile", "listFiles"]));
      const context = {
        runtime: { id: "runtime" },
        turnId: "turn",
        toolCallId: "call",
        messages: [{ role: "custom", type: "yesimbot.message", data: { user: { id: "alice" } } }],
      };
      const write = tools.find((tool) => tool.name === "writeFile")!;
      await write.execute({ path: "file.txt", content: "hello" }, context as never);
      await write.execute({ path: "file.txt", content: "hello" }, context as never);
      const calls = fixture.ctx.yesimbot.devices.invoke.mock.calls as unknown as [
        string,
        { scope: unknown; actors: unknown; operationId: string; capability: string },
      ][];
      expect(calls[0]![0]).toBe(deviceId);
      expect(calls[0]![1]).toMatchObject({ scope, actors: [{ platform: "onebot", userId: "alice" }], capability: "workspace.files" });
      expect(calls[0]![1].operationId).toBe(calls[1]![1].operationId);
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });
  it("uses the selected computer for files, ignoring a different legacy storage device", async () => {
    const selected = "33333333-3333-4333-8333-333333333333";
    const fixture = await createWorkspace({
      storage: { kind: "device", deviceId: tenant },
      computer: { deviceId: selected },
    });
    try {
      await fixture.plugin.start();
      const scope = { type: "direct" as const, platform: "onebot", selfId: "bot", channelId: "private:alice", userId: "alice" };
      const plugin = await fixture.plugin.setup(scope);
      const tools = plugin!.tools as import("@yesimbot/agent-runtime").AgentTool[];
      expect(tools.some((tool) => tool.name === "bash")).toBe(false);
      fixture.ctx.yesimbot.devices.invoke.mockResolvedValueOnce({ status: "succeeded", output: { data: "aGk=" } } as never);
      const read = tools.find((tool) => tool.name === "readFile")!;
      await read.execute({ path: "notes.txt" }, { runtime: { id: "r" }, turnId: "t", toolCallId: "c", messages: [] } as never);
      expect(fixture.ctx.yesimbot.devices.invoke.mock.calls[0]?.[0]).toBe(selected);
      fixture.ctx.yesimbot.devices.invoke.mockRejectedValueOnce(new Error("offline"));
      await expect(read.execute({ path: "notes.txt" }, { runtime: { id: "r" }, turnId: "t", toolCallId: "d", messages: [] } as never)).rejects.toThrow(
        "offline",
      );
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });
  it("edits a text file in device storage by exact replacement, read and written through the device", async () => {
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const fixture = await createWorkspace({ storage: { kind: "device", deviceId }, computer: { deviceId } });
    try {
      await fixture.plugin.start();
      const scope = { type: "direct" as const, platform: "onebot", selfId: "bot", channelId: "private:alice", userId: "alice" };
      const tools = (await fixture.plugin.setup(scope))!.tools as import("@yesimbot/agent-runtime").AgentTool[];
      const edit = tools.find((tool) => tool.name === "editFile")!;
      const read = tools.find((tool) => tool.name === "readFile")!;
      const execution = (id: string) => ({ runtime: { id: "r" }, turnId: "t", toolCallId: id, messages: [] }) as never;
      const invoke = fixture.ctx.yesimbot.devices.invoke;
      const file = (text: string) => ({ status: "succeeded", output: { data: Buffer.from(text).toString("base64") } }) as never;
      // Editing works from what was read.
      invoke.mockResolvedValueOnce(file("a = 1\nb = 1\n"));
      await read.execute({ path: "conf/app.ini" }, execution("r1"));
      invoke.mockResolvedValueOnce(file("a = 1\nb = 1\n")).mockResolvedValueOnce({ status: "succeeded", output: {} } as never);
      expect(await edit.execute({ path: "conf/app.ini", oldString: "a = 1", newString: "a = 2" }, execution("c1"))).toEqual({
        status: "succeeded",
        replacements: 1,
        uri: "workspace:///conf/app.ini",
        diff: "--- a/conf/app.ini\n+++ b/conf/app.ini\n@@ -1,2 +1,2 @@\n-a = 1\n+a = 2\n b = 1",
      });
      const [readCall, writeCall] = invoke.mock.calls.slice(-2) as unknown as [string, { method: string; input: { path: string; data?: string } }][];
      expect([readCall[0], readCall[1].method, readCall[1].input]).toEqual([deviceId, "read", { path: "conf/app.ini" }]);
      expect(writeCall[1].method).toBe("write");
      expect(Buffer.from(writeCall[1].input.data!, "base64").toString()).toBe("a = 2\nb = 1\n");
      // Ambiguous, missing and replace-all cases; nothing is written unless the edit applies.
      invoke.mockResolvedValueOnce(file("x x"));
      await read.execute({ path: "f" }, execution("r2"));
      invoke.mockResolvedValueOnce(file("x x"));
      expect(await edit.execute({ path: "f", oldString: "x", newString: "y" }, execution("c2"))).toMatchObject({ status: "rejected", code: "ambiguous" });
      invoke.mockResolvedValueOnce(file("x x"));
      expect(await edit.execute({ path: "f", oldString: "z", newString: "y" }, execution("c3"))).toMatchObject({ status: "rejected", code: "not_found" });
      invoke.mockResolvedValueOnce(file("$x $x"));
      await read.execute({ path: "f" }, execution("r3"));
      invoke.mockResolvedValueOnce(file("$x $x")).mockResolvedValueOnce({ status: "succeeded", output: {} } as never);
      expect(await edit.execute({ path: "f", oldString: "$x", newString: "$&y", replaceAll: true }, execution("c4"))).toMatchObject({ replacements: 2 });
      const last = invoke.mock.lastCall as unknown as [string, { input: { data: string } }];
      expect(Buffer.from(last[1].input.data, "base64").toString()).toBe("$&y $&y");
      invoke.mockResolvedValueOnce({ status: "failed", code: "file_unavailable" } as never);
      expect(await edit.execute({ path: "missing", oldString: "a", newString: "b" }, execution("c5"))).toMatchObject({
        status: "failed",
        code: "file_unavailable",
      });
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });
  it("ignores retired hosted policy files while preserving sandbox and explicitly paired workspace choices", async () => {
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const scope = { type: "direct" as const, platform: "onebot", selfId: "bot", channelId: "private:alice", userId: "alice" };
    const directory = await mkdtemp(join(tmpdir(), "yesimbot-retired-assignment-"));
    const file = join(directory, "computer.json");
    const previous = process.env.YESIMBOT_COMPUTER_FILE;
    process.env.YESIMBOT_COMPUTER_FILE = file;
    const sandbox = await createWorkspace();
    const device = await createWorkspace({ storage: { kind: "device", deviceId }, computer: { deviceId } });
    try {
      await sandbox.plugin.start();
      await device.plugin.start();
      for (const policy of [undefined, "malformed JSON", JSON.stringify({ version: 1, deviceId: "33333333-3333-4333-8333-333333333333" })]) {
        if (policy !== undefined) await writeFile(file, policy);
        expect(typeof (await sandbox.plugin.setup(scope))?.tools).toBe("function");
        expect((await device.plugin.setup(scope))?.tools?.length).toBeGreaterThan(0);
        const resolveDevice = (device.ctx.yesimbot.devices.useWorkspaceResolver.mock.lastCall as unknown as [(scope: unknown) => string | undefined])[0];
        expect(resolveDevice(scope)).toBe(deviceId);
      }
    } finally {
      if (previous === undefined) delete process.env.YESIMBOT_COMPUTER_FILE;
      else process.env.YESIMBOT_COMPUTER_FILE = previous;
      for (const fixture of [sandbox, device]) {
        await fixture.plugin.stop();
        await rm(fixture.baseDir, { recursive: true, force: true });
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("registers named ResourceReader objects and one agent plugin on start", async () => {
    const fixture = await createWorkspace();
    try {
      await fixture.plugin.start();

      expect(fixture.ctx.yesimbot.agent.use).toHaveBeenCalledOnce();
      expect(fixture.plugins).toHaveLength(1);
      expect(fixture.ctx.yesimbot.resource.use).toHaveBeenCalledOnce();
      expect(fixture.readers.map((reader) => reader.scheme)).toEqual(["workspace"]);
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("initializes a channel-scoped workspace agent through resource.get", async () => {
    const fixture = await createWorkspace();
    try {
      await fixture.plugin.start();
      const agentPlugin = await fixture.plugins[0]!.setup({ type: "direct", platform: "onebot", channelId: "private:alice", userId: "alice" }, {
        selfId: "bot",
      } as never);

      expect(agentPlugin).toBeTruthy();
      expect(fixture.ctx.yesimbot.resource.get).toHaveBeenCalledWith({
        type: "direct",
        platform: "onebot",
        channelId: "private:alice",
        userId: "alice",
        selfId: "bot",
      });
      const tools = typeof agentPlugin?.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : [];
      expect(tools.map((tool) => tool.name)).toEqual(["bash", "readFile", "writeFile", "editFile"]);
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("exposes HTML rendering to scheduled turns and never offers the Anon command tool", async () => {
    const fixture = await createWorkspace({ htmlRendererUrl: "http://renderer.internal/render", bash: { mounts: [] } });
    try {
      await fixture.plugin.start();
      const plugin = await fixture.plugin.setup({ type: "direct", platform: "onebot", channelId: "private:alice", userId: "alice", selfId: "bot" });
      if (!plugin || typeof plugin.tools !== "function") throw new Error("Workspace tools missing");
      const tools = (await plugin.tools({} as never)) ?? [];
      const filtered = (await plugin.filterTools?.(tools, { messages: [] } as never)) ?? tools;
      expect(filtered.map((tool) => tool.name)).toContain("render_html");
      expect(filtered.map((tool) => tool.name)).not.toContain("hostExec");
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("renders a conversation workspace file by path and refuses anything outside that workspace", async () => {
    const fixture = await createWorkspace({ htmlRendererUrl: "http://renderer.internal/render", bash: { enableNetwork: false, mounts: [] } });
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXYsAAAAASUVORK5CYII=", "base64"));
    const put = vi.fn(async () => "artifact://render_html/report.png");
    (fixture.ctx.yesimbot.resource.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: fixture.baseDir,
      assets: {},
      artifacts: { forTool: () => ({ put }) },
      maxBytes: 5 * 1024 * 1024,
      detectImageMediaType: () => "image/png",
    });
    const request = vi.fn(async () => new Response(png, { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", request);
    try {
      await fixture.plugin.start();
      const plugin = await fixture.plugin.setup({ type: "direct", platform: "onebot", channelId: "private:alice", userId: "alice", selfId: "bot" });
      if (!plugin || typeof plugin.tools !== "function") throw new Error("Workspace tools missing");
      const render = ((await plugin.tools({} as never)) ?? []).find((tool) => tool.name === "render_html")!;
      const workspaces = join(fixture.baseDir, "data/yesimbot/workspaces");
      const [namespace] = await readdir(workspaces);
      const root = join(workspaces, namespace!);
      const html = '<!doctype html><meta charset="utf-8"><h1>日报</h1>';
      await mkdir(join(root, "reports"));
      await writeFile(join(root, "reports/daily.html"), html);
      await writeFile(join(root, "big.html"), "x".repeat(200_001));
      await writeFile(join(fixture.baseDir, "outside.html"), "<h1>secret</h1>");
      await symlink(join(fixture.baseDir, "outside.html"), join(root, "link.html"));
      const run = (path: string) => render.execute({ path }, { turnId: "turn", toolCallId: "call", messages: [] } as never);

      for (const path of ["reports/daily.html", "/home/workspace/reports/daily.html", "workspace:///reports/daily.html"])
        expect(await run(path)).toMatchObject({ ok: true, uri: "artifact://render_html/report.png" });
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls.every((call) => (call as unknown[])[1] && JSON.parse(((call as unknown[])[1] as { body: string }).body).html === html)).toBe(
        true,
      );
      request.mockClear();
      for (const path of ["../outside.html", join(fixture.baseDir, "outside.html"), "link.html"])
        expect(await run(path)).toMatchObject({ ok: false, error: "invalid_path" });
      expect(await run("missing.html")).toEqual({ ok: false, error: "file_not_found" });
      expect(await run("reports")).toEqual({ ok: false, error: "file_not_found" });
      expect(await run("big.html")).toEqual({ ok: false, error: "html_file_too_large" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("only provides the sandbox virtual filesystem backend", async () => {
    const fixture = await createWorkspace();
    try {
      await fixture.plugin.start();
      const agentPlugin = await fixture.plugins[0]!.setup({ type: "direct", platform: "onebot", channelId: "private:alice", userId: "alice" }, {
        selfId: "bot",
      } as never);
      const tools = typeof agentPlugin?.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : [];

      expect(tools).toHaveLength(4);
      expect(tools.map((t) => t.name).sort()).toEqual(["bash", "editFile", "readFile", "writeFile"]);
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("isolates the same conversation under different bot accounts", async () => {
    const fixture = await createWorkspace();
    try {
      await fixture.plugin.start();
      for (const selfId of ["bot-one", "bot-two"]) {
        const plugin = await fixture.plugin.setup({ type: "direct", platform: "onebot", channelId: "private:alice", userId: "alice", selfId });
        typeof plugin!.tools === "function" ? await (plugin!.tools as Function)({}) : plugin!.tools;
      }
      expect(await readdir(join(fixture.baseDir, "data/yesimbot/workspaces"))).toHaveLength(2);
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("automatically offers a chosen computer in private chats and offers it in groups too (the call is admin-gated centrally, not by the plugin)", async () => {
    const fixture = await createWorkspace({
      computer: { deviceId: "22222222-2222-4222-8222-222222222222" },
      toolPolicy: { ...openPolicy, direct: { enabled: false, tools: [] }, group: { enabled: true, tools: ["*", "computer_exec"] } },
    });
    try {
      await fixture.plugin.start();
      const scope = { type: "direct" as const, platform: "onebot", channelId: "private:user", userId: "user", selfId: "bot" };
      const plugin = await fixture.plugin.setup(scope),
        tools = typeof plugin!.tools === "function" ? await (plugin!.tools as Function)({}) : plugin!.tools;
      const tool = tools.find((tool: { name: string }) => tool.name === "computer_exec");
      const execution = {
        messages: [{ role: "custom", type: "yesimbot.message", data: { user: { id: "user" } } }],
        runtime: { id: "r" },
        turnId: "turn",
        toolCallId: "call",
      };
      await tool.execute({ command: "pwd" }, execution);
      expect(fixture.ctx.yesimbot.devices.invoke).toHaveBeenCalledWith(
        "22222222-2222-4222-8222-222222222222",
        expect.objectContaining({ scope, capability: "computer.shell" }),
        undefined,
      );
      const group = await fixture.plugin.setup({ type: "guild", platform: "onebot", channelId: "room", guildId: "room", selfId: "bot" });
      const groupTools = typeof group!.tools === "function" ? await (group!.tools as Function)({}) : group!.tools;
      const offered = await group!.filterTools!(groupTools, { messages: execution.messages } as never);
      expect((offered as { name: string }[]).map((tool) => tool.name)).toContain("computer_exec");
      expect(groupTools.find((tool: { name: string }) => tool.name === "computer_exec")).toBeDefined();
      expect(fixture.ctx.yesimbot.devices.invoke).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("provides selected computer tools in private chats and no local bash", async () => {
    const fixture = await createWorkspace({ computer: { deviceId: "22222222-2222-4222-8222-222222222222" } });
    try {
      await fixture.plugin.start();
      const plugin = await fixture.plugin.setup({ type: "direct", platform: "onebot", channelId: "private:user", userId: "user", selfId: "bot" });
      const names = ((typeof plugin!.tools === "function" ? await (plugin!.tools as Function)({}) : plugin!.tools) as { name: string }[]).map(
        (tool) => tool.name,
      );
      expect(names).not.toContain("bash");
      expect(names).toContain("computer_exec");
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  // User, 2026-11-19: 「按任务类型给工具」: content and service tasks do not use the computer.
  it("gives computer tools and screen guidance only to the main conversation and computer tasks", async () => {
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const fixture = await createWorkspace({ storage: { kind: "device", deviceId }, computer: { deviceId } });
    try {
      await fixture.plugin.start();
      const scope = { type: "direct" as const, platform: "onebot", channelId: "private:user", userId: "user", selfId: "bot" };
      const seen: Record<string, { computer: boolean; files: boolean; screen: boolean }> = {};
      for (const role of [undefined, "computer", "content", "service"] as const) {
        const plugin = await fixture.plugin.setup(
          scope,
          undefined,
          role ? { imageProjection: new EphemeralImageProjectionStore(), executionRole: role } : undefined,
        );
        const names = ((typeof plugin!.tools === "function" ? await (plugin!.tools as Function)({}) : plugin!.tools) as { name: string }[]).map(
          (tool) => tool.name,
        );
        const prompt = String(await plugin!.appendSystemPrompt?.({} as never));
        seen[String(role)] = {
          computer: names.includes("computer_exec"),
          files: names.includes("readFile") && prompt.includes("会话目录里的文件用相对路径"),
          screen: prompt.includes("屏幕"),
        };
      }
      const withComputer = { computer: true, files: true, screen: true };
      const withoutComputer = { computer: false, files: true, screen: false };
      expect(seen).toEqual({ undefined: withComputer, computer: withComputer, content: withoutComputer, service: withoutComputer });
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it.each(["native", "unavailable", undefined] as const)("passes the execution model's %s image policy to computer tools", async (mode) => {
    const fixture = await createWorkspace({ computer: { deviceId: "22222222-2222-4222-8222-222222222222" } });
    const imageProjection = new EphemeralImageProjectionStore();
    try {
      await fixture.plugin.start();
      fixture.ctx.yesimbot.devices.invoke.mockResolvedValue({
        status: "succeeded",
        output: { text: "desktop", data: "AQID", mediaType: "image/png" },
      } as never);
      const plugin = await fixture.plugin.setup({ type: "direct", platform: "onebot", channelId: "private:user", userId: "user", selfId: "bot" }, undefined, {
        imageProjection,
        ...(mode === undefined ? {} : { nativeImageInput: { mode } }),
      });
      const tools = (typeof plugin!.tools === "function" ? await (plugin!.tools as Function)({}) : plugin!.tools) as AgentTool[];
      const tool = tools.find((tool) => tool.name === "computer_ui")!;
      const input = { tool: "screenshot" };
      const output = await tool.execute(input, { runtime: { id: "runtime" }, toolCallId: "screen", turnId: "turn", messages: [] } as never);
      const projected = await tool.toModelOutput!({ toolCallId: "screen", input, output });
      expect(output).toMatchObject({ imageMode: mode === "native" ? "native" : "unavailable" });
      expect(projected.type).toBe("content");
      if (projected.type !== "content") throw new Error("expected computer projection");
      expect(projected.value.some((part) => part.type === "image-data")).toBe(mode === "native");
    } finally {
      imageProjection.clearAll();
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("keeps an unsaved old computer-mode config working as it did", async () => {
    const fixture = await createWorkspace({ mode: "computer", computer: { deviceId: "22222222-2222-4222-8222-222222222222", shell: true } } as never);
    try {
      await fixture.plugin.start();
      const plugin = await fixture.plugin.setup({ type: "direct", platform: "onebot", channelId: "private:user", userId: "user", selfId: "bot" });
      const names = ((typeof plugin!.tools === "function" ? await (plugin!.tools as Function)({}) : plugin!.tools) as { name: string }[]).map(
        (tool) => tool.name,
      );
      expect(names).toContain("computer_exec");
      expect(names).not.toContain("bash");
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("does not expose workspace tools on an undeclared platform even with legacy grants", async () => {
    const fixture = await createWorkspace({ computer: { deviceId: "22222222-2222-4222-8222-222222222222" } });
    try {
      await fixture.plugin.start();
      const plugin = await fixture.plugin.setup({ type: "direct", platform: "test", channelId: "user", userId: "user", selfId: "bot" });
      expect(plugin?.tools).toEqual([]);
      expect(fixture.ctx.yesimbot.devices.invoke).not.toHaveBeenCalled();
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });
});

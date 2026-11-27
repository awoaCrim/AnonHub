import type { AgentPlugin, AgentTool } from "@yesimbot/agent-runtime";
import { configureLogging, type LogRecord } from "@yesimbot/foundation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { identity, policy } from "../../../tests/tool-policy.js";

const mocks = vi.hoisted(() => ({
  connectMcpServer: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../src/transports", () => ({ connectMcpServer: mocks.connectMcpServer }));

import { createService } from "./helpers.js";

const records: LogRecord[] = [];

beforeEach(() => {
  records.length = 0;
  configureLogging({ sink: (record) => records.push(record) });
});

type ToolListChangedHandler = () => unknown;
const privateScope = { type: "direct", platform: "onebot", channelId: "private:owner", userId: "owner", selfId: "bot" } as const;

function createContext() {
  const plugins: AgentPlugin[] = [];
  const disposers: Array<ReturnType<typeof vi.fn<() => void>>> = [];
  const artifactWriter = { put: vi.fn(async () => "artifact://test-tool/019d3b7e-1bd0-7e4f-9c5d-5bf3fd41f1d4") };
  const ctx = {
    yesimbot: {
      identity,
      config: {},
      agent: {
        use: vi.fn((plugin: AgentPlugin) => {
          plugins.push(plugin);
          const dispose = vi.fn<() => void>();
          disposers.push(dispose);
          return dispose;
        }),
      },
      resource: { get: vi.fn(async () => ({ path: "/tmp", assets: {}, artifacts: { forTool: vi.fn(() => artifactWriter) } })) },
    },
  };

  return { ctx, disposers, plugins, artifactWriter };
}

function createClient(toolBatches: string[][]) {
  let batchIndex = 0;
  let toolListChanged: ToolListChangedHandler | undefined;
  const client = {
    callTool: vi.fn<() => Promise<unknown>>(),
    close: vi.fn<() => Promise<void>>(),
    listTools: vi.fn<() => Promise<{ tools: Array<{ name: string; description: string; inputSchema: { type: string } }> }>>(async () => {
      const names = toolBatches[Math.min(batchIndex, toolBatches.length - 1)] ?? [];
      batchIndex += 1;
      return { tools: names.map((name) => ({ name, description: `${name} description`, inputSchema: { type: "object" } })) };
    }),
    setNotificationHandler: vi.fn<(schema: unknown, handler: ToolListChangedHandler) => void>((_schema, handler) => {
      toolListChanged = handler;
    }),
  };

  return {
    client,
    async emitToolListChanged() {
      if (!toolListChanged) {
        throw new Error("tool list changed handler not registered");
      }
      await toolListChanged();
    },
  };
}

async function resolveTools(plugin: AgentPlugin): Promise<AgentTool[]> {
  const tools = typeof plugin.tools === "function" ? await plugin.tools({} as never) : plugin.tools;
  return tools ?? [];
}

async function resolveToolNames(plugin: AgentPlugin): Promise<string[]> {
  return (await resolveTools(plugin)).map((tool) => tool.name);
}

function outputText(output: unknown): string {
  if (!Array.isArray(output)) throw new Error(`expected MCP content array, received ${typeof output}`);
  const block = output[0] as { type?: unknown; text?: unknown };
  if (block?.type !== "text" || typeof block.text !== "string") throw new Error("expected a single MCP text block");
  return block.text;
}
describe("mcp-client tool registry", () => {
  it("refreshes stable tools when a server reports tool list changes", async () => {
    const { client, emitToolListChanged } = createClient([["beta", "alpha"], ["gamma"]]);
    const { ctx, disposers, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = createService(ctx as never, {
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });

    await plugin.start();

    const channelScope = privateScope;
    const runtimePlugin = await plugins[0]!.setup(channelScope, {} as never);
    expect(client.setNotificationHandler).toHaveBeenCalledOnce();
    expect(await resolveToolNames(runtimePlugin!)).toEqual(["docs-alpha", "docs-beta"]);

    await emitToolListChanged();

    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(ctx.yesimbot.agent.use).toHaveBeenCalledTimes(2);
    expect(await resolveToolNames(await plugins[1]!.setup(channelScope, {} as never))).toEqual(["docs-gamma"]);
  });
  it("invalidates pending confirmations when a catalog refresh publishes replacement tools", async () => {
    const { client, emitToolListChanged } = createClient([["createOrder"], ["createOrder"]]);
    client.callTool.mockResolvedValue({ content: [{ text: "upstream", type: "text" }] });
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = createService(ctx as never, {
      mcpServers: { luckin: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();

    const channelScope = privateScope;
    const firstTools = await resolveTools(await plugins[0]!.setup(channelScope, {} as never));
    const firstTool = firstTools.find((tool) => tool.name === "luckin-createOrder");
    if (!firstTool) throw new Error("initial side-effect tool missing");

    const blocked = await firstTool.execute({}, { messages: [] } as never);
    const code = /确认短码: ([A-Z0-9]{6})/.exec(outputText(blocked))?.[1];
    if (!code) throw new Error("initial confirmation code missing");

    await emitToolListChanged();

    const refreshedTools = await resolveTools(await plugins[1]!.setup(channelScope, {} as never));
    const refreshedTool = refreshedTools.find((tool) => tool.name === "luckin-createOrder");
    if (!refreshedTool) throw new Error("refreshed side-effect tool missing");

    const replay = await refreshedTool.execute({}, { messages: [{ content: `确认 ${code}`, role: "user" }] } as never);
    expect(outputText(replay)).toContain("confirmation_required");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("uses declared platforms (sensitive tools included in groups) despite permissive or disabled legacy settings", async () => {
    const { client } = createClient([["search"]]);
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = createService(ctx as never, {
      toolPolicy: { ...policy([{ kind: "any", platform: "*", conversationId: "*" }]), direct: { enabled: false, tools: [] } },
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();

    const direct = await plugins[0]!.setup(privateScope, {} as never);
    expect(await resolveToolNames(direct!)).toEqual(["docs-search"]);
    expect((await resolveTools(direct!))[0]!.capability).toEqual({ platforms: ["onebot", "wechat-bridge", "web"], sensitive: true, executionKind: "service" });

    const group = await plugins[0]!.setup({ type: "guild", platform: "onebot", channelId: "room", guildId: "room" } as never, {} as never);
    // Sensitive tools are offered in groups now; only their call is admin-gated by Core.
    expect(await resolveToolNames(group!)).toEqual(["docs-search"]);
    const unknown = await plugins[0]!.setup({ ...privateScope, platform: "test" }, {} as never);
    expect(await resolveToolNames(unknown!)).toEqual([]);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("keeps private server confirmation after removing legacy sender reminders", async () => {
    const { client } = createClient([["createOrder"]]);
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn() } });
    const plugin = createService(ctx as never, {
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();
    const runtime = await plugins[0]!.setup(privateScope, { selfId: "bot" } as never);
    if (!runtime) throw new Error("MCP runtime missing");
    const tools = await resolveTools(runtime);
    const context = (actor: string) =>
      ({ turnId: "turn", stepNumber: 0, messages: [{ id: "input-id", role: "custom", type: "yesimbot.message", data: { user: { id: actor } } }] }) as never;
    expect(await runtime.filterTools?.(tools, context("operator"))).toEqual(tools);
    expect(await runtime.filterTools?.(tools, context("other"))).toEqual(tools);
    const reminded = await runtime.beforeToolCall?.({ toolName: "docs-createOrder", toolCallId: "call", args: { private: "SECRET" } }, context("other"));
    expect(reminded).toEqual({ type: "allow" });
    expect(JSON.stringify(reminded)).not.toContain("SECRET");
    // Legacy actor lists no longer gate tools; the independent one-use confirmation remains.
    const blocked = await tools[0]!.execute({}, context("other"));
    expect(outputText(blocked)).toContain("confirmation_required");
    expect(client.callTool).not.toHaveBeenCalled();
    await plugin.stop();
  });

  it("updates server-level confirmation for newly published catalog snapshots", async () => {
    const { client, emitToolListChanged } = createClient([["createOrder"], ["createOrder"]]);
    client.callTool.mockResolvedValue({ content: [{ text: "upstream", type: "text" }] });
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });
    const config = {
      mcpServers: { orders: { type: "http" as const, url: "https://example.test/mcp", requireConfirmation: false } },
    };
    const plugin = createService(ctx as never, config);
    await plugin.start();
    const scope = privateScope;
    const first = (await resolveTools(await plugins[0]!.setup(scope, {} as never)))[0]!;
    expect(outputText(await first.execute({}, { messages: [] } as never))).toBe("upstream");
    config.mcpServers.orders.requireConfirmation = true;
    await emitToolListChanged();
    const refreshed = (await resolveTools(await plugins[1]!.setup(scope, {} as never)))[0]!;
    expect(outputText(await refreshed.execute({}, { messages: [] } as never))).toContain("confirmation_required");
    expect(client.callTool).toHaveBeenCalledOnce();
  });

  it("disambiguates exposed names after sanitization", async () => {
    const { client } = createClient([["search/tool", "search.tool"]]);
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = createService(ctx as never, {
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();

    const channelScope = privateScope;
    const runtimePlugin = await plugins[0]!.setup(channelScope, {} as never);
    expect(await resolveToolNames(runtimePlugin!)).toEqual(["docs-search_tool", "docs-search_tool_2"]);
  });

  it("keeps declared private tools independent of old sender lists", async () => {
    const { client } = createClient([["search"]]);
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = createService(ctx as never, {
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();

    const channelScope = privateScope;
    const runtimePlugin = await plugins[0]!.setup(channelScope, {} as never);
    const tools = await resolveTools(runtimePlugin!);
    const message = (userId: string) => ({ role: "custom", type: "yesimbot.message", data: { user: { id: userId } } });

    expect((await runtimePlugin!.filterTools?.(tools, { messages: [message("101")] } as never))?.map((tool) => tool.name)).toEqual(["docs-search"]);
    const call = { toolCallId: "call", toolName: "docs-search", args: {} };
    expect(await runtimePlugin!.beforeToolCall?.(call, { turnId: "a", messages: [message("100")] } as never)).toEqual({ type: "allow" });
    expect(await runtimePlugin!.beforeToolCall?.(call, { turnId: "b", messages: [message("101")] } as never)).toEqual({ type: "allow" });
    expect(await runtimePlugin!.beforeToolCall?.(call, { turnId: "b", messages: [message("101")] } as never)).toEqual({ type: "allow" });
  });
});

describe("mcp-client failed tool calls", () => {
  async function readTool(call: () => Promise<unknown>) {
    const { client } = createClient([["lookup"]]);
    client.callTool.mockImplementation(call);
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });
    const plugin = createService(ctx as never, {
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp", requireConfirmation: false } },
    });
    await plugin.start();
    const tool = (await resolveTools(await plugins[0]!.setup(privateScope, {} as never)))[0]!;
    return { tool, client };
  }

  it("turns an `isError` answer into a tool failure, not a success, and shows the server's text redacted", async () => {
    const { tool, client } = await readTool(async () => ({
      isError: true,
      content: [{ type: "text", text: "order 42 failed: key sk-abcdefghijklmnop1234 declined" }],
    }));
    const output = await tool.execute({ q: "x" }, {} as never);
    expect(output).toEqual({
      ok: false,
      error: { code: "mcp_tool_failed", message: "这个 MCP 工具执行失败了，结果不确定。不要自动重试有副作用的工具。", retryable: false },
      effect: "unknown",
      serverMessage: expect.stringContaining("order 42 failed"),
    });
    expect(JSON.stringify(output)).not.toContain("sk-abcdefghijklmnop1234");
    expect(records.find((record) => record.event === "tool.reported_error")).toMatchObject({
      level: "warn",
      tool: "docs-lookup",
      upstream: expect.stringContaining("order 42"),
    });
    expect(client.callTool).toHaveBeenCalledOnce();
    // The failure reaches the model as data; it is not read as content blocks.
    const modelOutput = await tool.toModelOutput!({ output, toolCallId: "call" } as never);
    expect(modelOutput).toMatchObject({ type: "json", value: { ok: false, error: { code: "mcp_tool_failed" } } });
  });

  it("keeps a plain answer, and a missing or false `isError`, as content", async () => {
    for (const answer of [{ content: [{ type: "text", text: "fine" }] }, { isError: false, content: [{ type: "text", text: "fine" }] }]) {
      const { tool } = await readTool(async () => answer);
      expect(await tool.execute({}, {} as never)).toEqual([{ type: "text", text: "fine" }]);
    }
  });

  it("returns a call that never completed as a failure with an unknown effect, and keeps the cause in the log", async () => {
    const { tool } = await readTool(async () => {
      throw new Error("socket hang up at https://internal.example/mcp?token=abc123");
    });
    const output = await tool.execute({}, {} as never);
    expect(output).toMatchObject({ ok: false, error: { code: "mcp_call_failed" }, effect: "unknown" });
    expect(JSON.stringify(output)).not.toContain("socket hang up");
    const logged = records.find((record) => record.event === "tool.call_failed");
    expect(logged).toMatchObject({ level: "warn", code: "mcp_call_failed" });
    expect(JSON.stringify(logged)).toContain("socket hang up");
    expect(JSON.stringify(logged)).not.toContain("abc123");
  });
});

import { createPluginHost, EphemeralImageProjectionStore, type AgentPlugin, type AgentTool, type PluginHostRuntime } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

import type { ChatAccount } from "../src/accounts.js";
import { Agents } from "../src/agents/index.js";
import type { ChannelContext } from "../src/channels/index.js";

const scope: ChannelContext = { type: "guild", platform: "onebot", guildId: "room", channelId: "room" };
const bot = {} as ChatAccount;
const runtime: PluginHostRuntime = { id: "test", channel: { emit: vi.fn() }, state: {} } as unknown as PluginHostRuntime;
const setupRuntime = () => ({ imageProjection: new EphemeralImageProjectionStore() });
const tool = (name: string, platforms = ["web", "onebot"], sensitive = false): AgentTool => ({
  name,
  capability: { platforms, sensitive, executionKind: "read" },
  description: name,
  inputSchema: {} as never,
  execute: async () => "ok",
});

describe("shared plugin capability permissions", () => {
  it("sets up every plugin without a platform plugin allowlist, offers sensitive tools in groups and filters other platforms and undeclared tools", async () => {
    const agents = new Agents();
    agents.use({ id: "yesimbot-example", setup: () => ({ name: "xhk" }) });
    agents.use({
      id: "portable",
      setup: () => ({ name: "portable", tools: [tool("portable_read"), tool("web_only", ["web"]), tool("private_read", ["onebot"], true)] }),
    });
    agents.use({ setup: () => ({ name: "undeclared", tools: [{ ...tool("unknown"), capability: undefined }] }) });
    const plugins = await agents.setup(scope, bot, setupRuntime());
    expect(plugins.map((plugin) => plugin.name)).toEqual(["xhk", "portable", "undeclared"]);
    const host = createPluginHost({ plugins, runtime });
    await host.init();
    expect(host.stableTools.map((entry) => entry.name)).toEqual(["portable_read", "private_read"]);
    await host.stop();
  });

  it.each([false, true])("retains plugin guards, prompts and cleanup for declared tools (dynamic=%s)", async (dynamic) => {
    const agents = new Agents();
    const stop = vi.fn();
    const tools = [tool("public_search")];
    const guard = vi.fn(() => ({ type: "block", reason: "upstream-confirmation-required" }) as const);
    agents.use({
      id: "search",
      setup: () => ({ name: "search", tools: dynamic ? async () => tools : tools, beforeToolCall: guard, appendSystemPrompt: () => "search prompt", stop }),
    });
    const host = createPluginHost({ plugins: await agents.setup(scope, bot, setupRuntime()), runtime });
    await host.init();
    expect(host.stableTools.map((entry) => entry.name)).toEqual(["public_search"]);
    expect(host.stablePromptBlocks).toContainEqual({ role: "system", content: "search prompt" });
    expect(await host.helpers.beforeToolCall({ type: "allow" }, { toolName: "public_search" } as never, {} as never)).toEqual({
      type: "block",
      reason: "upstream-confirmation-required",
    });
    expect(guard).toHaveBeenCalledOnce();
    await host.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("preserves the original receiver across extension lifecycle methods", async () => {
    const agents = new Agents();
    const extension: AgentPlugin & { ready: boolean } = {
      name: "stateful",
      ready: false,
      init() {
        this.ready = true;
      },
      tools() {
        expect(this).toBe(extension);
        return this.ready ? [tool("stateful_search")] : [];
      },
      beforeToolCall() {
        expect(this).toBe(extension);
        return this.ready ? { type: "allow" } : { type: "block", reason: "not ready" };
      },
      stop() {
        expect(this).toBe(extension);
        this.ready = false;
      },
    };
    agents.use({ id: "stateful", setup: () => extension });
    const host = createPluginHost({ plugins: await agents.setup(scope, bot, setupRuntime()), runtime });
    await host.init();
    expect(host.stableTools.map((entry) => entry.name)).toEqual(["stateful_search"]);
    expect(await host.helpers.beforeToolCall({ type: "allow" }, { toolName: "stateful_search" } as never, {} as never)).toEqual({ type: "allow" });
    await host.stop();
    expect(extension.ready).toBe(false);
  });

  it("checks declared tools added by legacy in-place extension hooks (sensitive ones are offered in groups, admin-gated at call time)", async () => {
    const agents = new Agents();
    agents.use({
      id: "legacy",
      setup: () => ({
        name: "legacy",
        extendTools: (tools) => {
          tools.push(tool("portable"), tool("private", ["onebot"], true));
        },
      }),
    });
    const host = createPluginHost({ plugins: await agents.setup(scope, bot, setupRuntime()), runtime });
    await host.init({ baseTools: [tool("base")] });
    expect(host.stableTools.map((entry) => entry.name)).toEqual(["base", "portable", "private"]);
    await host.stop();
  });

  it("stops initialized plugins on setup failure", async () => {
    const agents = new Agents();
    const stop = vi.fn();
    agents.use({ id: "first", setup: () => ({ name: "first", stop }) });
    agents.use({
      id: "second",
      setup: () => {
        throw new Error("setup failed");
      },
    });
    await expect(agents.setup(scope, bot, setupRuntime())).rejects.toThrow("setup failed");
    expect(stop).toHaveBeenCalledOnce();
  });
});

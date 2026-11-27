/* eslint-disable vitest/require-mock-type-parameters */
import {
  createAgent,
  createAssistantMessage,
  createUserMessage,
  createToolMessage,
  EphemeralImageProjectionStore,
  jsonSchema,
  type AgentPlugin,
} from "@yesimbot/agent-runtime";
import { configureLogging, systemClock, type LogRecord } from "@yesimbot/foundation";
import { contentHash } from "@yesimbot/foundation";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import type { ChannelContext, ChannelPluginSetupContext, ReplyStickerProvider } from "koishi-plugin-yesimbot";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { identity, policy } from "../../../tests/tool-policy.js";
import type { StickerDeliveryService } from "../src/delivery.js";
import { extension } from "../src/extension.js";
import type { StickerManager } from "../src/manager.js";
import { SqliteStickerTable } from "../src/table.js";
import type { StickerConfig, StickerProjection, StickerRow } from "../src/types.js";
import { disposeStickerStorage, useStickerStorage } from "./helpers.js";

const config: StickerConfig = {
  scope: "global",
  tagMode: false,
};

/** Retired switches remain load-compatible, but capability declarations own authorization. */
type LegacySwitches = { enableSteal?: boolean; enableManage?: boolean };

const scope: ChannelContext = { type: "guild", selfId: "bot", platform: "onebot", channelId: "room", guildId: "room" };
const directScope: ChannelContext = { type: "direct", selfId: "bot", platform: "onebot", channelId: "private:alice", userId: "alice" };

describe("sticker-manager extension", () => {
  let ready: Array<() => Promise<void> | void> = [];
  let dispose: Array<() => Promise<void> | void> = [];
  let registeredPlugin: StickerManager | undefined;

  afterEach(async () => {
    await disposeStickerStorage();
    for (const callback of dispose) await callback();
    vi.restoreAllMocks();
    ready = [];
    dispose = [];
    registeredPlugin = undefined;
  });

  async function createHarness(overrides: Partial<StickerConfig> & LegacySwitches = {}) {
    await useStickerStorage();
    const table = {
      insert: vi.spyOn(SqliteStickerTable.prototype, "insert"),
      update: vi.spyOn(SqliteStickerTable.prototype, "update"),
      remove: vi.spyOn(SqliteStickerTable.prototype, "remove"),
    };
    const seed = async (...rows: StickerRow[]) => {
      const target = new SqliteStickerTable();
      for (const row of rows) await target.insert(row);
      table.insert.mockClear();
    };
    const agentDispose = { current: undefined as (() => void) | undefined };
    const logs: LogRecord[] = [];
    configureLogging({ sink: (record) => logs.push(record) });
    const ctx = {
      baseDir: process.cwd(),
      on: vi.fn((event: string, callback: () => Promise<void> | void) => {
        if (event === "ready") ready.push(callback);
        if (event === "dispose") dispose.push(callback);
      }),
      yesimbot: {
        identity,
        agent: {
          use: vi.fn((plugin: StickerManager) => {
            registeredPlugin = plugin;
            agentDispose.current = vi.fn();
            return agentDispose.current;
          }),
        },
        resource: {
          get: vi.fn(async () => ({
            path: process.cwd(),
            assets: { get: vi.fn(), put: vi.fn(), clear: vi.fn() },
            artifacts: { forTool: vi.fn(() => ({ put: vi.fn() })) },
          })),
        },
        model: { getDefaultChatModelId: vi.fn(), resolveChatModel: vi.fn() },
      },
    };

    const extensionContext = { config: extension.parse({ ...config, ...overrides }), baseDir: ctx.baseDir, clock: systemClock(), core: ctx.yesimbot };
    ready.push(async () => {
      const undo = await extension.start(extensionContext as never);
      if (undo) dispose.push(undo as () => Promise<void>);
    });
    return {
      ctx,
      table,
      seed,
      agentDispose,
      logs,
      async start(bot: unknown = { selfId: "bot" }, channelScope: ChannelContext = scope, runtime?: ChannelPluginSetupContext): Promise<AgentPlugin | null> {
        await ready[0]?.();
        if (!registeredPlugin) throw new Error("sticker plugin was not registered");
        return registeredPlugin.setup(channelScope, bot as never, runtime);
      },
      async stop(): Promise<void> {
        await dispose[0]?.();
      },
    };
  }

  async function toolNames(agentPlugin: AgentPlugin | null): Promise<string[]> {
    const tools = typeof agentPlugin?.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : [];
    return tools.map((tool) => tool.name);
  }

  async function pluginPrompt(agentPlugin: AgentPlugin | null): Promise<string> {
    return String(await agentPlugin?.appendSystemPrompt?.({} as never));
  }

  async function expectToolNames(agentPlugin: AgentPlugin | null, expected: string[]): Promise<void> {
    const names = await toolNames(agentPlugin);
    expect(names).toHaveLength(expected.length);
    expect(names).toEqual(expect.arrayContaining(expected));
  }

  it("registers the AgentPlugin factory on ready, and no chat commands", async () => {
    const harness = await createHarness();
    expect(harness.ctx).not.toHaveProperty("command");
    const agentPlugin = await harness.start();

    expect(harness.ctx.yesimbot.agent.use).toHaveBeenCalledOnce();
    expect(agentPlugin?.name).toBe("sticker-manager");

    await harness.stop();
    expect(harness.agentDispose.current).toHaveBeenCalledOnce();
  });

  it("ignores the retired collection switch and exposes sticker collection and management in groups", async () => {
    const harness = await createHarness({ enableSteal: false, tagMode: true });
    const agentPlugin = await harness.start();

    await expectToolNames(agentPlugin, ["sticker_preview", "sticker_steal", "sticker_search", "sticker_manage"]);
    const prompt = await pluginPrompt(agentPlugin);
    expect(prompt).toContain("sticker_steal");
    expect(prompt).not.toContain("收藏当前消息");
    expect(prompt).toContain("send_message");
    expect(prompt).toContain("标签");
  });

  it("offers sticker management in groups whatever a legacy all-tools grant says (the call is admin-gated by Core)", async () => {
    const all = await (await createHarness()).start();
    expect(await toolNames(all)).toContain("sticker_manage");
    expect(await toolNames(all)).toContain("sticker_steal");
    expect(await pluginPrompt(all)).toContain("sticker_manage");
  });

  it("offers sticker management in groups even with a legacy named grant", async () => {
    const named = await (await createHarness({})).start();
    expect(await toolNames(named)).toContain("sticker_manage");
    expect(await pluginPrompt(named)).toContain("sticker_manage");
  });

  it("does not expose sticker tools or delivery on an undeclared platform", async () => {
    const harness = await createHarness();
    const unsupported = { ...scope, platform: "test" };
    const registerSticker = vi.fn((_provider: ReplyStickerProvider) => vi.fn());
    const plugin = await harness.start({ selfId: "bot" }, unsupported, {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 1, ownership: "authored", registerSticker },
    });
    expect(await toolNames(plugin)).toEqual([]);
    expect(await plugin?.appendSystemPrompt?.({} as never)).toBeUndefined();
    const provider = registerSticker.mock.calls[0]![0];
    expect(await provider.catalog()).toEqual([]);
    expect(await provider.view("turn", [])).toBeUndefined();
    expect(await provider.preflight({ stickerId: "s", turnId: "turn", messages: [] })).toEqual({ error: "sticker_capability_retired" });
  });

  it.each([false, true])("offers private management independently of the retired enableManage=%s switch", async (enableManage) => {
    const plugin = await (await createHarness({ enableManage, enableSteal: false })).start({ selfId: "bot" }, directScope);
    expect(await toolNames(plugin)).toContain("sticker_manage");
    expect(await pluginPrompt(plugin)).toContain("sticker_manage");
  });

  it("registers one disposable delivery capability and has no standalone send tool", async () => {
    const harness = await createHarness({ enableSteal: false, tagMode: true });
    const unregister = vi.fn();
    const registerSticker = vi.fn((_provider: ReplyStickerProvider) => unregister);
    const runtime = {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 1 as const, ownership: "authored" as const, registerSticker },
    };
    const plugin = await harness.start({ selfId: "bot" }, scope, runtime);
    expect(registerSticker).toHaveBeenCalledOnce();
    await expectToolNames(plugin, ["sticker_preview", "sticker_steal", "sticker_search", "sticker_manage"]);
    const prompt = await pluginPrompt(plugin);
    expect(prompt).not.toContain("sticker_send");
    expect(prompt).not.toContain("continue 设为 true");
    expect(prompt).toContain("send_message");
    expect(prompt).toContain("sticker parts");
    const tools = typeof plugin?.tools === "function" ? await plugin.tools({} as never) : [];
    expect(tools?.find((tool) => tool.name === "sticker_preview")?.description).not.toContain("sticker_send");
    const provider = registerSticker.mock.calls[0]![0];
    const revision = provider.revision;
    expect(provider.status("turn")).toBe("eligible");
    await plugin?.stop?.();
    await plugin?.stop?.();
    expect(unregister).toHaveBeenCalledOnce();
    expect(provider.revision).toBeGreaterThan(revision);
    expect(provider.status("turn")).toBe("unavailable");
    await expect(provider.preflight({ stickerId: "s", turnId: "turn", messages: [] })).resolves.toEqual({ error: "sticker_capability_retired" });
  });

  it("binds each lease preflight to provider disposal and Core's later permission", async () => {
    const harness = await createHarness();
    await harness.start();
    if (!registeredPlugin) throw new Error("missing plugin");
    const registerSticker = vi.fn((_provider: ReplyStickerProvider) => vi.fn());
    const runtime: ChannelPluginSetupContext = {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 1, ownership: "authored", registerSticker },
    };
    const preflight = vi.fn(async (_input: Parameters<StickerDeliveryService["preflight"]>[0]) => ({ error: "test_preflight" }));
    const delivery = { preflight } as unknown as StickerDeliveryService;
    const unregister = registeredPlugin.registerDelivery(scope, {} as never, runtime, delivery);
    const provider = registerSticker.mock.calls[0]![0];
    let coreAllowed = true;
    await provider.preflight({ stickerId: "s", turnId: "turn", messages: [], stillAllowed: () => coreAllowed });
    const bound = preflight.mock.calls[0]![0].stillAllowed!;
    expect(bound()).toBe(true);
    coreAllowed = false;
    expect(bound()).toBe(false);
    coreAllowed = true;
    await harness.stop();
    expect(bound()).toBe(false); // Existing lease carries this callback past later byte awaits.
    unregister?.();
  });

  it("guards reject a bare sticker element in message text before output", async () => {
    const harness = await createHarness();
    const plugin = await harness.start({ selfId: "bot" }, scope, {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 1, ownership: "authored", registerSticker: () => () => {} },
    });
    const blocked = [{ toolName: "send_message", args: { parts: [{ kind: "text", text: '<sticker id="old"/>' }] } }];
    for (const call of blocked) expect(await plugin?.beforeToolCall?.(call as never, {} as never)).toMatchObject({ type: "block" });
    expect(
      await plugin?.beforeToolCall?.({ toolName: "send_message", args: { parts: [{ kind: "sticker", sticker_id: "viewed-id" }] } } as never, {} as never),
    ).toBeUndefined();
  });

  it("does not infer modern delivery from an unsupported setup seam", async () => {
    const harness = await createHarness();
    const registerSticker = vi.fn();
    const plugin = await harness.start({ selfId: "bot" }, scope, {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 2, ownership: "authored", registerSticker },
    } as unknown as ChannelPluginSetupContext);
    expect(registerSticker).not.toHaveBeenCalled();
    expect(await toolNames(plugin)).not.toContain("sticker_send");
  });

  it("keeps optional choice in the capability note", async () => {
    const agentPlugin = await (await createHarness({ enableSteal: false })).start();
    const prompt = await pluginPrompt(agentPlugin);
    expect(prompt).toContain("自主选用");
    expect(prompt).toContain("sticker_search");
    expect(prompt).toContain("send_message");
    expect(prompt).not.toMatch(/开心、得意|先表情后文字|两段文字之间|同一轮最多|continue|artifact:/);
    expect(prompt.length).toBeLessThan(300);
  });

  it.each(
    [scope, directScope].flatMap((channelScope) =>
      [false, true].flatMap((enableSteal) =>
        [false, true].flatMap((enableManage) => [false, true].map((tagMode) => ({ channelScope, enableSteal, enableManage, tagMode }))),
      ),
    ),
  )("keeps a compact capability note and ignores retired switches for %j", async ({ channelScope, enableSteal, enableManage, tagMode }) => {
    const harness = await createHarness({ enableSteal, enableManage, tagMode });
    const plugin = await harness.start({ selfId: "bot" }, channelScope, {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 1, ownership: "authored", registerSticker: () => () => {} },
    });
    const prompt = await pluginPrompt(plugin);
    const names = await toolNames(plugin);
    expect(prompt).toContain("自主选用");
    expect(prompt).toContain("sticker_search");
    expect(prompt).toContain("send_message");
    expect(prompt).toContain("sticker_steal");
    expect(prompt).toContain("sticker_manage");
    expect(prompt.includes("标签")).toBe(tagMode);
    expect(names).not.toContain("sticker_send");
    expect(names).toContain("sticker_steal");
    expect(names).toContain("sticker_manage");
    expect(prompt.length).toBeLessThan(300);
    expect(prompt.split("\n").length).toBeLessThanOrEqual(5);
    expect(prompt).not.toMatch(/表情包库概览|回合开始快照|开心、得意|两段文字之间|每轮发送/);
  });

  function preparation(turnId: string, stepNumber = 0) {
    return { turnId, stepNumber } as never;
  }

  it("leaves fresh, continued and rebuilt requests unchanged without querying a catalog", async () => {
    const harness = await createHarness({ enableSteal: false });
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const list = vi.spyOn(registeredPlugin.store, "listCategories").mockRejectedValue(new Error("database_unavailable"));
    const messages: ModelMessage[] = [
      { role: "user", content: "[表情包库概览：这是用户实际说的话]" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "signed-call", toolName: "inspect", input: {}, providerOptions: { google: { thoughtSignature: "signature" } } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "signed-call", toolName: "inspect", output: { type: "json", value: { ok: true } } }] },
    ];
    const snapshot = structuredClone(messages);
    for (const context of [preparation("turn-1"), preparation("turn-1", 1), preparation("turn-1"), preparation("turn-2")]) {
      const prepared = await plugin.prepareStep?.(messages, context);
      expect(prepared).toBe(messages);
      expect(prepared).toEqual(snapshot);
      for (const [index, message] of messages.entries()) expect(prepared?.[index]).toBe(message);
    }
    expect(list).not.toHaveBeenCalled();
    expect(harness.logs.filter((record) => record.level === "warn")).toEqual([]);
    expect(harness.table.insert).not.toHaveBeenCalled();
    expect(harness.table.update).not.toHaveBeenCalled();
  });

  it.each(["global", "channel"] as const)("queries the current %s library only on demand and observes mutations", async (libraryScope) => {
    const harness = await createHarness({ scope: libraryScope, enableManage: true });
    const plugin = await harness.start({ selfId: "bot" }, directScope);
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const scopeKey = libraryScope === "global" ? "global" : JSON.stringify(["conversation-v2", "onebot", "bot", "direct", "private:alice"]);
    const id = "a".repeat(64);
    const row = (key: string, contentId: string, category: string): StickerRow => ({
      id: key + ":" + contentId,
      contentId,
      scopeKey: key,
      category,
      tags: [],
      mime: "image/png",
      size: 1,
      source: { kind: "import" },
      usageCount: 0,
      lastUsedAt: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    await harness.seed(row(scopeKey, id, "old"), row("group:test:other", "b".repeat(64), "foreign"));
    const list = vi.spyOn(registeredPlugin.store, "listCategories");
    await plugin.prepareStep?.([], preparation("turn-1"));
    expect(list).not.toHaveBeenCalled();
    const tools = typeof plugin.tools === "function" ? await plugin.tools({} as never) : [];
    const execute = async (name: string, input: unknown) => {
      const tool = tools?.find((candidate) => candidate.name === name);
      if (!tool) throw new Error("missing " + name);
      return tool.execute(input, { turnId: "turn-1", messages: [] } as never);
    };
    expect(await execute("sticker_search", {})).toMatchObject({ ok: true, categories: [{ category: "old", count: 1 }] });
    expect(list).toHaveBeenCalledWith(scopeKey);
    expect(await execute("sticker_manage", { action: "rename_category", source_category: "old", category: "new" })).toMatchObject({ ok: true, affected: 1 });
    expect(await execute("sticker_search", {})).toMatchObject({ ok: true, categories: [{ category: "new", count: 1 }] });
    expect(await execute("sticker_search", { category: "new" })).toMatchObject({ ok: true, stickers: [{ id, category: "new" }] });
    expect(await execute("sticker_search", { category: "foreign" })).toMatchObject({ ok: true, stickers: [] });
  });

  it.each(["finish", "replacement", "stop"] as const)("retains awaited mutation guards after %s without catalog preparation", async (boundary) => {
    const harness = await createHarness({ enableManage: true });
    const plugin = await harness.start({ selfId: "bot" }, directScope);
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    await plugin.prepareStep?.([], preparation("turn-1"));
    let complete!: () => void;
    const pause = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let stillAllowed: (() => boolean) | undefined;
    const remove = vi.spyOn(registeredPlugin.store, "deleteSticker").mockImplementationOnce(async (_key, _id, guard) => {
      stillAllowed = guard?.stillAllowed;
      await pause;
      throw new Error("retired operation");
    });
    const tools = typeof plugin.tools === "function" ? await plugin.tools({} as never) : [];
    const manage = tools?.find((tool) => tool.name === "sticker_manage");
    if (!manage) throw new Error("missing management tool");
    const input = { action: "delete", sticker_id: "a".repeat(64) };
    const pending = manage.execute(input, { turnId: "turn-1", messages: [] } as never);
    try {
      expect(remove).toHaveBeenCalledOnce();
      expect(stillAllowed?.()).toBe(true);
      if (boundary === "finish") {
        await plugin.onTurnFinish?.({ turnId: "turn-1", status: "done", messages: [] }, { turnId: "turn-1" } as never);
        await plugin.prepareStep?.([], preparation("turn-1"));
      } else if (boundary === "replacement") {
        await plugin.prepareStep?.([], preparation("turn-2"));
      } else {
        await harness.stop();
        await plugin.prepareStep?.([], preparation("turn-2"));
      }
      expect(stillAllowed?.()).toBe(false);
      expect(await manage.execute(input, { turnId: "turn-1", messages: [] } as never)).toMatchObject({ error: { code: "sticker_capability_retired" } });
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      complete();
      expect(await pending).toMatchObject({ error: { code: "sticker_capability_retired" } });
    }
    expect(harness.table.remove).not.toHaveBeenCalled();
  });

  it("keeps automatic catalogs out of real model requests and storage across tool steps and turns", async () => {
    const harness = await createHarness();
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const list = vi.spyOn(registeredPlugin.store, "listCategories").mockResolvedValue([{ category: "CATALOG_SENTINEL", count: 1 }]);
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        const index = step++;
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: "call-" + index, toolName: index % 2 === 0 ? "inspect" : "finish", input: "{}" },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            },
          ]),
        };
      },
    });
    const schema = jsonSchema<Record<string, never>>({ type: "object", additionalProperties: false });
    const agent = createAgent({
      model,
      plugins: [plugin],
      requireTerminalTool: true,
      tools: [
        { name: "inspect", inputSchema: schema, execute: async () => ({ ok: true }) },
        { name: "finish", terminal: true, inputSchema: schema, execute: async () => ({ ok: true }) },
      ],
    });
    try {
      for (const text of ["hello", "next scene"]) {
        agent.send(createUserMessage(text));
        await agent.wait();
      }
      expect(model.doStreamCalls).toHaveLength(4);
      for (const call of model.doStreamCalls) {
        expect(JSON.stringify(call.prompt)).not.toMatch(/CATALOG_SENTINEL|表情包库概览/);
      }
      expect(list).not.toHaveBeenCalled();
      expect(JSON.stringify(await agent.storage.read())).not.toMatch(/CATALOG_SENTINEL|表情包库概览/);
      expect(harness.table.insert).not.toHaveBeenCalled();
    } finally {
      await agent.stop();
    }
  });

  it("keeps sticker_steal in tools and prompt while stealing is enabled", async () => {
    const harness = await createHarness({ enableSteal: true });
    const agentPlugin = await harness.start();

    await expectToolNames(agentPlugin, ["sticker_preview", "sticker_steal", "sticker_search", "sticker_manage"]);
    const prompt = await pluginPrompt(agentPlugin);
    expect(prompt).toContain("sticker_steal");
    expect(prompt).toContain("聊天图片");
  });

  it("clears the per-turn sticker claim when the Agent turn finishes", async () => {
    const harness = await createHarness();
    const sendMessage = vi.fn(async () => ["message-1"]);
    const projection = new EphemeralImageProjectionStore();
    let provider: ReplyStickerProvider | undefined;
    const agentPlugin = await harness.start({ selfId: "bot", sendMessage }, scope, {
      imageProjection: projection,
      replyDelivery: {
        version: 1,
        ownership: "authored",
        registerSticker: (registered: ReplyStickerProvider) => {
          provider = registered;
          return () => {};
        },
      },
      imagePreview: { mode: "vision", preview: () => ({ mode: "unavailable", error: "image_input_unavailable" }), describe: async () => "红色画面" },
    });
    if (!registeredPlugin || !agentPlugin) throw new Error("sticker plugin was not initialized");

    const png = new PNG({ width: 1, height: 1 });
    png.data.set([255, 0, 0, 255]);
    const bytes = new Uint8Array(PNG.sync.write(png));
    const sticker: StickerProjection = {
      id: contentHash(bytes),
      category: "meme",
      tags: [],
      mime: "image/png",
      size: 1,
      source: { kind: "import" },
      usageCount: 0,
      lastUsedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    vi.spyOn(registeredPlugin.store, "random").mockResolvedValue(sticker);
    vi.spyOn(registeredPlugin.store, "get").mockResolvedValue(sticker);
    await harness.seed({ ...sticker, id: `global:${sticker.id}`, contentId: sticker.id, scopeKey: "global", updatedAt: sticker.createdAt });
    vi.spyOn(registeredPlugin.store, "readBytes").mockResolvedValue(bytes);
    vi.spyOn(registeredPlugin.store, "markUsed").mockResolvedValue(sticker);

    const tool = async () => (typeof agentPlugin.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : []);
    const preview = (await tool()).find((candidate) => candidate.name === "sticker_preview");
    if (!preview || !provider) throw new Error("no preview or delivery provider");
    const view = async (turnId: string) => {
      await agentPlugin.prepareStep?.([], preparation(turnId));
      const output = await preview.execute({}, { turnId, toolCallId: "view", messages: [] } as never);
      const projected = await preview.toModelOutput!({ toolCallId: "view", input: {}, output });
      return {
        turnId,
        messages: [
          createAssistantMessage([{ type: "tool-call", toolName: "sticker_preview", toolCallId: "view", input: {} }]),
          createToolMessage([{ type: "tool-result", toolName: "sticker_preview", toolCallId: "view", output: projected }]),
        ],
      };
    };
    const send = async (context: { turnId: string; messages: never[] | unknown[] }) => {
      const prepared = await provider!.preflight({ stickerId: sticker.id, turnId: context.turnId, messages: context.messages as never });
      return "lease" in prepared ? await prepared.lease.send() : prepared;
    };
    const context = await view("turn-1");
    const first = await send(context);
    const blocked = await send(context);

    await agentPlugin.onTurnFinish?.({ turnId: "turn-1", status: "done", messages: [] }, { turnId: "turn-1" } as never);

    expect(await send(context)).toEqual({ error: "sticker_capability_retired" });
    const afterFinish = await send(await view("turn-2"));
    projection.clearAll();

    expect(first).toMatchObject({ status: "confirmed" });
    expect(blocked).toEqual({ error: "sticker_send_limit_reached" });
    expect(afterFinish).toMatchObject({ status: "confirmed" });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

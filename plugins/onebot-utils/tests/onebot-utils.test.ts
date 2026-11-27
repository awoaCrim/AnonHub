import type { AgentPlugin, AgentTool } from "@yesimbot/agent-runtime";
import { ONEBOT_ACTIONS, oneBotActionName, type OneBotAction } from "@yesimbot/contracts/platforms";
import { configForm } from "@yesimbot/foundation";
import { asSchema } from "ai";
import type { ChannelPlugin } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

import { identity, policy } from "../../../tests/tool-policy.js";
import { GROUP_TOOLS, REACTION_FACES, createOneBotTools, extension, moduleConfig } from "../src/index";

/** The extension driven the way a host does: parsed when constructed, then started and stopped. */
class OnebotUtilsPlugin {
  private readonly config: unknown;
  private undo: (() => unknown) | undefined;

  public constructor(
    private readonly ctx: { yesimbot: unknown },
    raw: unknown,
  ) {
    this.config = extension.parse(raw);
  }

  public async start(): Promise<void> {
    this.undo = ((await extension.start({ config: this.config, core: this.ctx.yesimbot } as never)) ?? undefined) as (() => unknown) | undefined;
  }

  public async stop(): Promise<void> {
    await this.undo?.();
  }
}

/** A QQ account declaring every OneBot action, each one sent to `request` (what it answers is the action's data). */
function qqVia(
  request: (action: OneBotAction, input: Record<string, unknown>) => unknown = () => undefined,
  actions: readonly OneBotAction[] = ONEBOT_ACTIONS,
) {
  return {
    platform: "onebot",
    selfId: "bot",
    actions: Object.fromEntries(actions.map((action) => [oneBotActionName(action), async (input: Record<string, unknown>) => request(action, input)])),
  };
}

/** A QQ account whose `handlers` answer the actions a test looks at; the others give no data. */
function qq(handlers: Partial<Record<OneBotAction, (input: Record<string, unknown>) => unknown>> = {}) {
  return qqVia((action, input) => handlers[action]?.(input));
}

function createLogger() {
  return { error: vi.fn<() => void>(), info: vi.fn<() => void>(), success: vi.fn<() => void>(), warn: vi.fn<() => void>() };
}

function createMemoryAssets() {
  let next = 0;
  return {
    put: vi.fn<(bytes: Uint8Array) => Promise<string>>(async () => `asset-${++next}`),
    get: vi.fn<(id: string) => Promise<Uint8Array>>(async () => new Uint8Array()),
    clear: vi.fn<() => Promise<void>>(async () => undefined),
  };
}

function createContext() {
  const scopedLogger = createLogger();
  const rootLogger = Object.assign(
    vi.fn<() => ReturnType<typeof createLogger>>(() => scopedLogger),
    createLogger(),
  );
  const plugins: ChannelPlugin[] = [];
  const dispose = vi.fn<() => void>();
  const assets = createMemoryAssets();
  // QQ's media servers answer every forward image download.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } })),
  );
  const ctx = {
    logger: rootLogger,
    on: vi.fn<(event: string, handler: () => unknown) => void>(),
    yesimbot: {
      identity,
      config: {},
      agent: {
        use: vi.fn((plugin: ChannelPlugin) => {
          plugins.push(plugin);
          return dispose;
        }),
      },
      resource: { get: vi.fn(async () => ({ path: "/tmp", assets, artifacts: {} })) },
    },
  };

  return { ctx, dispose, plugins };
}

function createChannelContext(overrides: Record<string, unknown> = {}) {
  return { type: "guild", platform: "onebot", channelId: "group", guildId: "group", ...overrides };
}

async function getTools(plugin: AgentPlugin): Promise<AgentTool[]> {
  if (!plugin.tools) return [];
  return typeof plugin.tools === "function" ? ((await plugin.tools({} as never)) ?? []) : plugin.tools;
}

/** The config lists group-only tools under `group` only, so `direct` never names them. */
function groupPolicy(...args: Parameters<typeof policy>) {
  const result = policy(...args);
  result.direct.tools = result.direct.tools.filter((name) => !GROUP_TOOLS.includes(name));
  return result;
}

const DEFAULT_ENABLED_TOOLS = ["onebot_get_forward_message", "onebot_create_reaction", "onebot_set_essence"];

async function createRuntime(
  bot: unknown,
  config: Record<string, unknown> = {},
): Promise<{ getForwardTool: () => AgentTool; getTools: () => Promise<AgentTool[]> }> {
  const { ctx, plugins } = createContext();
  const toolPolicy = policy(
    [{ kind: "any", platform: "onebot", conversationId: "group" }],
    (config.enabledTools as string[] | undefined) ?? DEFAULT_ENABLED_TOOLS,
  );
  // The config only lists group-only tools under `group`.
  toolPolicy.direct.tools = toolPolicy.direct.tools.filter((name) => !GROUP_TOOLS.includes(name));
  const plugin = new OnebotUtilsPlugin(ctx as never, { ...config, toolPolicy } as never);
  await plugin.start();
  const runtimePlugin = await plugins[0]!.setup(createChannelContext() as never, bot as never);
  if (!runtimePlugin) throw new Error("OneBot runtime plugin was not created");
  const tools = await getTools(runtimePlugin);

  return { getForwardTool: () => tools.find((tool) => tool.name === "onebot_get_forward_message")!, getTools: async () => tools };
}

async function nativeTools(bot: unknown, config: Record<string, unknown> = {}): Promise<AgentTool[]> {
  const { ctx } = createContext();
  const resources = await ctx.yesimbot.resource.get();
  // Exercise native argument mapping below publication. Group sensitivity is tested at setup.
  return createOneBotTools(bot as never, config as never, createChannelContext({ channelId: "456", guildId: "456" }) as never, resources as never);
}

const sender = (userId: string) => ({ role: "custom", type: "yesimbot.message", data: { user: { id: userId } } });
/** A QQ server where 900 is an admin, 901 the owner and everyone else an ordinary member. */
const groupRequest = () =>
  vi.fn(async (action: string, params: Record<string, unknown>) =>
    action === "get_group_member_info" ? { role: params.user_id === 900 ? "admin" : params.user_id === 901 ? "owner" : "member" } : { status: "ok" },
  );

const message = (segments: unknown[], overrides: Record<string, unknown> = {}) => ({
  sender: { user_id: 1, nickname: "Alice", card: "" },
  time: 1_753_888_000,
  message: segments,
  raw_message: "[CQ:ignored]",
  ...overrides,
});

describe("onebot-utils plugin", () => {
  it("registers exactly one named plugin and disposes it on stop", async () => {
    const { ctx, dispose, plugins } = createContext();
    const plugin = new OnebotUtilsPlugin(ctx as never, {});

    await plugin.start();
    await plugin.stop();

    expect(ctx.yesimbot.agent.use).toHaveBeenCalledOnce();
    expect(plugins).toHaveLength(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("registers and disposes the direct forward sender as channel output", async () => {
    const { ctx, plugins } = createContext();
    const plugin = new OnebotUtilsPlugin(ctx as never, {});
    await plugin.start();
    const unregister = vi.fn();
    const registerTools = vi.fn((_names: readonly string[]) => unregister);
    const runtimePlugin = await plugins[0]!.setup(
      createChannelContext() as never,
      qq() as never,
      {
        channelOutput: { version: 1, registerTools },
      } as never,
    );

    expect(registerTools).toHaveBeenCalledWith(["onebot_send_forward_message"]);
    await runtimePlugin?.stop?.();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("declares the enabled-tool configuration fields", () => {
    const fields = (configForm(moduleConfig.schema) as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(fields)).toEqual(["moderationGroups", "encourageReactions", "quoteReplyAfterMessages", "parseImages"]);
  });

  it("encourages reactions when configured without relying on legacy tool selection", async () => {
    const enabled = await createRuntime(qq(), { encourageReactions: true });
    expect((await enabled.getTools()).find((t) => t.name === "onebot_create_reaction")?.description).toContain("鼓励按消息语境");
    const disabled = await createRuntime(qq(), { encourageReactions: false });
    expect((await disabled.getTools()).find((t) => t.name === "onebot_create_reaction")?.description).not.toContain("鼓励按消息语境");
    const legacyDisabled = await createRuntime(qq(), { encourageReactions: true, enabledTools: [] });
    expect((await legacyDisabled.getTools()).some((t) => t.name === "onebot_create_reaction")).toBe(true);
  });

  it("adds configurable quote guidance only to QQ groups", async () => {
    for (const [type, threshold, expected] of [
      ["guild", undefined, "5 条"],
      ["guild", 3, "3 条"],
      ["guild", 0, undefined],
      ["direct", 3, undefined],
    ] as const) {
      const { ctx, plugins } = createContext();
      const plugin = new OnebotUtilsPlugin(ctx as never, { quoteReplyAfterMessages: threshold } as never);
      await plugin.start();
      const runtime = await plugins[0]!.setup(createChannelContext({ type }) as never, qq() as never);
      const guidance = await runtime?.appendSystemPrompt?.({} as never);
      if (expected) expect(guidance).toContain(expected);
      else expect(guidance).toBeUndefined();
    }
  });

  // User, 2026-11-19: 「按任务类型给工具」: a background task never talks in the chat.
  it("keeps quoting and reactions out of background tasks, and group management guidance for service tasks", async () => {
    const seen: Record<string, { quote: boolean; reaction: boolean; moderation: boolean }> = {};
    for (const role of [undefined, "main", "computer", "content", "service"] as const) {
      const { ctx, plugins } = createContext();
      const plugin = new OnebotUtilsPlugin(
        ctx as never,
        {
          encourageReactions: true,
          quoteReplyAfterMessages: 5,
          moderationGroups: ["group"],
          toolPolicy: groupPolicy([{ kind: "any", platform: "onebot", conversationId: "group" }], [...DEFAULT_ENABLED_TOOLS, "onebot_group_admin"]),
        } as never,
      );
      await plugin.start();
      const runtime = await plugins[0]!.setup(createChannelContext() as never, qq() as never, role ? ({ executionRole: role } as never) : undefined);
      const guidance = (await runtime?.appendSystemPrompt?.({} as never)) ?? "";
      seen[String(role)] = { quote: guidance.includes("QQ 群聊引用"), reaction: guidance.includes("QQ 表情回应"), moderation: guidance.includes("群管理") };
    }
    const chat = { quote: true, reaction: true, moderation: true };
    expect(seen).toEqual({
      undefined: chat,
      main: chat,
      computer: { quote: false, reaction: false, moderation: false },
      content: { quote: false, reaction: false, moderation: false },
      service: { quote: false, reaction: false, moderation: true },
    });
  });

  it("returns null for an account that declares no OneBot action", async () => {
    const { ctx, plugins } = createContext();
    const plugin = new OnebotUtilsPlugin(ctx as never, {});
    await plugin.start();

    await expect(plugins[0]!.setup({ type: "guild", platform: "discord", channelId: "channel", guildId: "channel" } as never, {} as never)).resolves.toBeNull();
  });

  it("publishes platform declarations independently of legacy conversation switches", async () => {
    const { ctx, plugins } = createContext();
    const plugin = new OnebotUtilsPlugin(
      ctx as never,
      {
        toolPolicy: {
          ...policy([{ kind: "any", platform: "onebot", conversationId: "group" }], ["onebot_set_qq_profile"]),
          direct: { enabled: false, tools: ["onebot_set_qq_profile"] },
        },
      } as never,
    );
    await plugin.start();

    const direct = await plugins[0]!.setup(createChannelContext({ type: "direct", channelId: "private:100", userId: "100" }) as never, qq() as never);
    const privateNames = (await getTools(direct!)).map((tool) => tool.name);
    expect(privateNames).toContain("onebot_set_qq_profile");
    expect(privateNames).not.toContain("onebot_set_essence");

    const group = await plugins[0]!.setup(createChannelContext({ channelId: "other", guildId: "other" }) as never, qq() as never);
    const groupNames = (await getTools(group!)).map((tool) => tool.name);
    expect(groupNames).toContain("onebot_set_essence");
    // Sensitive profile tools are offered in groups now; only their call is admin-gated by Core.
    expect(groupNames).toContain("onebot_set_qq_profile");
  });

  it("offers sensitive group tools to every sender; the plugin no longer blocks the call (Core gates it by admin)", async () => {
    const { ctx, plugins } = createContext();
    const plugin = new OnebotUtilsPlugin(
      ctx as never,
      {
        toolPolicy: groupPolicy([{ kind: "any", platform: "onebot", conversationId: "*", userId: "100" }], ["onebot_set_qq_profile"]),
      } as never,
    );
    await plugin.start();

    const runtimePlugin = await plugins[0]!.setup(createChannelContext() as never, qq() as never);
    if (!runtimePlugin) throw new Error("OneBot runtime plugin was not created");
    const tools = await getTools(runtimePlugin);
    const message = (userId: string) => ({ role: "custom", type: "yesimbot.message", data: { user: { id: userId } } });

    expect((await runtimePlugin.filterTools?.(tools, { messages: [message("101")] } as never))?.map((tool) => tool.name)).toEqual([
      "onebot_set_essence",
      "onebot_get_forward_message",
      "onebot_send_forward_message",
      "onebot_create_reaction",
      "onebot_ocr_image",
      "onebot_set_qq_profile",
    ]);
    const call = { toolCallId: "call", toolName: "onebot_set_qq_profile", args: {} };
    for (const actor of ["100", "101"])
      expect(await runtimePlugin.beforeToolCall?.(call, { turnId: "a", messages: [message(actor)] } as never)).toEqual({ type: "allow" });
    expect(await runtimePlugin.beforeToolCall?.({ ...call, toolName: "onebot_create_reaction" }, { messages: [message("101")] } as never)).toEqual({
      type: "allow",
    });
  });

  it("exposes OneBot group tools, sensitive profile tools included, despite an old all-tools grant", async () => {
    const { ctx, plugins } = createContext();
    const plugin = new OnebotUtilsPlugin(
      ctx as never,
      {
        toolPolicy: groupPolicy(
          [{ kind: "any", platform: "onebot", conversationId: "group" }],
          [
            "onebot_get_forward_message",
            "onebot_send_forward_message",
            "onebot_create_reaction",
            "onebot_set_essence",
            "onebot_group_admin",
            "onebot_ocr_image",
            "onebot_set_qq_profile",
          ],
        ),
      } as never,
    );
    await plugin.start();

    const runtimePlugin = await plugins[0]!.setup(createChannelContext() as never, qq() as never);
    if (!runtimePlugin) throw new Error("OneBot runtime plugin was not created");
    const tools = await getTools(runtimePlugin);
    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(6);
    expect(names).toEqual(
      expect.arrayContaining([
        "onebot_get_forward_message",
        "onebot_send_forward_message",
        "onebot_create_reaction",
        "onebot_set_essence",
        "onebot_ocr_image",
        "onebot_set_qq_profile",
      ]),
    );
    // Group management stays off in a group the owner has not enabled; an old all-tools grant does not turn it on.
    expect(names).not.toContain("onebot_group_admin");
    for (const name of ["onebot_set_qq_profile"]) {
      expect(names).toContain(name);
      expect(await runtimePlugin.beforeToolCall?.({ toolCallId: "call", toolName: name, args: {} }, {} as never)).toEqual({ type: "allow" });
    }
  });
});

describe("onebot-utils behavior", () => {
  it("offers only the tools whose OneBot actions the account declares (spec 09 rule 6)", async () => {
    const forwardOnly = await createRuntime(qqVia(undefined, ["get_forward_msg"]));
    expect((await forwardOnly.getTools()).map((tool) => tool.name)).toEqual(["onebot_get_forward_message"]);
    const essenceAndReactions = await createRuntime(qqVia(undefined, ["set_essence_msg", "set_msg_emoji_like"]));
    expect((await essenceAndReactions.getTools()).map((tool) => tool.name)).toEqual(["onebot_set_essence", "onebot_create_reaction"]);
    await expect(createRuntime({ platform: "onebot", selfId: "bot" })).rejects.toThrow("OneBot runtime plugin was not created");
  });

  it("returns compact default forward pages and documents continuation", async () => {
    const getForwardMsg = vi.fn(async () => ({
      messages: [
        message([
          { type: "text", data: { text: "hello" } },
          { type: "image", data: { summary: "cover", file: "cover.jpg", file_size: "1000" } },
        ]),
      ],
    }));
    const runtime = await createRuntime(qq({ get_forward_msg: getForwardMsg }));
    const tool = runtime.getForwardTool();

    await expect(tool.execute?.({ forwardId: "forward" }, {} as never)).resolves.toEqual({ messages: [["Alice (1)", expect.any(String), ["hello[图片]"]]] });
    expect(getForwardMsg).toHaveBeenCalledWith({ message_id: "forward" });
    expect(tool.description).toContain("nextOffset");
    expect(tool.description).toContain("tips");
    expect(tool.description).toContain("forwardId");
    expect(tool.description).not.toContain("messageId");
  });

  it("reports a forward QQ cannot read as a registered failure", async () => {
    const runtime = await createRuntime(
      qq({
        get_forward_msg: () => {
          throw new Error("retcode 1200");
        },
      }),
    );

    await expect(runtime.getForwardTool().execute?.({ forwardId: "forward" }, {} as never)).rejects.toThrow("onebot_request_failed");
  });

  it("changes only image parts when image parsing is enabled", async () => {
    const getForwardMsg = vi.fn(async () => ({
      messages: [
        message([
          { type: "text", data: { text: "before" } },
          { type: "image", data: { summary: "cover", file: "cover.jpg", file_size: "1000" } },
          { type: "text", data: { text: "after" } },
        ]),
      ],
    }));
    const runtime = await createRuntime(qq({ get_forward_msg: getForwardMsg }), { parseImages: true });

    await expect(runtime.getForwardTool().execute?.({ forwardId: "forward" }, {} as never)).resolves.toEqual({
      messages: [["Alice (1)", expect.any(String), ["before[图片]after"]]],
    });
  });

  it("persists more than four forward images across bounded batches", async () => {
    const getForwardMsg = vi.fn(async () => ({
      messages: [
        message(
          Array.from({ length: 5 }, (_, index) => ({
            type: "image",
            data: { summary: `img-${index}`, file: `${index}.png`, url: `https://cdn.test/${index}.png` },
          })),
        ),
      ],
    }));
    const runtime = await createRuntime(qq({ get_forward_msg: getForwardMsg }), { parseImages: true });
    const imagesJoined = Array.from({ length: 5 }, (_, index) => `[图片：asset://asset-${index + 1}]`).join("");

    await expect(runtime.getForwardTool().execute?.({ forwardId: "forward" }, {} as never)).resolves.toEqual({
      messages: [["Alice (1)", expect.any(String), [imagesJoined]]],
    });
  });

  it("sends a merged forward with its original node elements", async () => {
    const getForwardMsg = vi.fn(async () => ({
      messages: [
        message(
          [
            { type: "text", data: { text: "hello" } },
            { type: "image", data: { summary: "cover", file: "cover.jpg", url: "https://cdn.test/cover.jpg", file_size: "1000" } },
          ],
          { time: 123 },
        ),
      ],
    }));
    const sendGroupForwardMsg = vi.fn(async () => ({ message_id: 42 }));
    const runtime = await createRuntime(qq({ get_forward_msg: getForwardMsg, send_group_forward_msg: sendGroupForwardMsg }), {
      enabledTools: ["onebot_send_forward_message"],
    });
    const tool = (await runtime.getTools()).find((item) => item.name === "onebot_send_forward_message")!;

    await expect(tool.execute?.({ forwardId: "forward" }, {} as never)).resolves.toEqual({ ok: true, messageId: "42" });
    expect(sendGroupForwardMsg).toHaveBeenCalledWith({
      group_id: "group",
      messages: [
        {
          type: "node",
          data: {
            name: "Alice",
            uin: "1",
            time: "123",
            content: [
              { type: "text", data: { text: "hello" } },
              { type: "image", data: { file: "https://cdn.test/cover.jpg" } },
            ],
          },
        },
      ],
    });
  });

  it("returns a structured failure when a forward cannot be sent", async () => {
    const sendGroupForwardMsg = vi.fn(async () => ({ message_id: 42 }));
    const runtime = await createRuntime(qq({ get_forward_msg: async () => undefined, send_group_forward_msg: sendGroupForwardMsg }), {
      enabledTools: ["onebot_send_forward_message"],
    });
    const tool = (await runtime.getTools()).find((item) => item.name === "onebot_send_forward_message")!;

    await expect(tool.execute?.({ forwardId: "missing" }, {} as never)).resolves.toEqual({
      ok: false,
      error: { code: "onebot_forward_not_found", message: "没有找到这条合并转发消息。", retryable: false },
      effect: "none",
    });
    expect(sendGroupForwardMsg).not.toHaveBeenCalled();
  });

  it("returns nested forward IDs without inlining child messages", async () => {
    const runtime = await createRuntime(
      qq({
        get_forward_msg: async () => ({
          messages: [message([{ type: "forward", data: { id: "child", content: [message([{ type: "text", data: { text: "hidden" } }])] } }])],
        }),
      }),
    );

    await expect(runtime.getForwardTool().execute?.({ forwardId: "forward" }, {} as never)).resolves.toEqual({
      messages: [["Alice (1)", expect.any(String), [{ forward: "child" }]]],
    });
  });

  it("reuses one runtime-scoped forward reader across pages", async () => {
    const getForwardMsg = vi.fn(async () => ({
      messages: [message([{ type: "text", data: { text: "a".repeat(3500) } }]), message([{ type: "text", data: { text: "b".repeat(3500) } }])],
    }));
    const runtime = await createRuntime(qq({ get_forward_msg: getForwardMsg }));
    const tool = runtime.getForwardTool();

    await tool.execute?.({ forwardId: "forward" }, {} as never);
    await tool.execute?.({ forwardId: "forward", offset: 1 }, {} as never);

    expect(getForwardMsg).toHaveBeenCalledOnce();
  });

  it("creates reactions through the account's OneBot action", async () => {
    const react = vi.fn(async () => null);
    const runtime = await createRuntime(qq({ set_msg_emoji_like: react }));
    const tool = (await runtime.getTools()).find((item) => item.name === "onebot_create_reaction")!;

    await expect(tool.execute?.({ messageId: "message-id", emojiId: " 76 " }, {} as never)).resolves.toEqual({ success: true });
    expect(react).toHaveBeenCalledWith({ message_id: "message-id", emoji_id: "76" });
  });

  // What QQ refuses is no success: adapter-onebot's `_request` gave the refusal back as an answer, and these tools said done.
  it("reports what QQ refuses as a failure, never as done", async () => {
    const refuse = () => {
      throw new Error("retcode 1404");
    };
    const tools = await createRuntime(qq({ set_msg_emoji_like: refuse, set_qq_profile: refuse, set_qq_avatar: refuse }));
    const byName = async (name: string) => (await tools.getTools()).find((item) => item.name === name)!;

    await expect((await byName("onebot_create_reaction")).execute?.({ messageId: "9", emojiId: "76" }, {} as never)).rejects.toThrow("onebot_request_failed");
    await expect((await byName("onebot_set_qq_profile")).execute?.({ action: "profile", nickname: "Athena" }, {} as never)).rejects.toThrow(
      "onebot_request_failed",
    );
    await expect((await byName("onebot_set_qq_profile")).execute?.({ action: "avatar", file: "a.png" }, {} as never)).rejects.toThrow("onebot_request_failed");
    const ban = (
      await nativeTools(
        qqVia((action) => (action === "get_group_member_info" ? { role: "admin" } : refuse())),
        { moderationGroups: ["456"] },
      )
    ).find((tool) => tool.name === "onebot_group_admin")!;
    await expect(ban.execute?.({ action: "ban", userId: "123", duration: 60 }, { messages: [sender("900")] } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "onebot_request_failed" },
    });
  });

  it("returns QQ's recognition result for OCR", async () => {
    const ocr = vi.fn(async () => ({ texts: [{ text: "你好" }], language: "zh" }));
    const tool = (await (await createRuntime(qq({ ocr_image: ocr }))).getTools()).find((item) => item.name === "onebot_ocr_image")!;

    await expect(tool.execute?.({ image: "https://example.test/a.png" }, {} as never)).resolves.toEqual({ texts: [{ text: "你好" }], language: "zh" });
    expect(ocr).toHaveBeenCalledWith({ image: "https://example.test/a.png" });
  });

  it("names the QQ faces it may react with, so the model can pick one instead of guessing an ID", async () => {
    for (const encourageReactions of [true, false]) {
      const runtime = await createRuntime(qq(), { encourageReactions });
      const tool = (await runtime.getTools()).find((item) => item.name === "onebot_create_reaction")!;
      const schema = (await asSchema(tool.inputSchema).jsonSchema) as { properties: { emojiId: { enum: string[]; description: string } } };

      expect(schema.properties.emojiId.enum).toEqual(REACTION_FACES.map(({ id }) => id));
      expect(schema.properties.emojiId.description).toContain("76 赞");
      expect(tool.description).toContain("76 赞");
      expect(tool.description).toContain("271 吃瓜");
      expect(tool.description).not.toContain("拿不准");
    }
    const ids = REACTION_FACES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    // NapCat sends IDs of up to three digits as QQ faces; longer ones would be read as Unicode emoji.
    expect(ids.every((id) => /^\d{1,3}$/.test(id))).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect(ids.length).toBeLessThanOrEqual(16);
  });

  it("rejects a face outside the list before it reaches QQ", async () => {
    const react = vi.fn(async () => null);
    const runtime = await createRuntime(qq({ set_msg_emoji_like: react }));
    const tool = (await runtime.getTools()).find((item) => item.name === "onebot_create_reaction")!;

    for (const emojiId of ["128077", "122", "", "abc"]) {
      await expect(tool.execute?.({ messageId: "message-id", emojiId }, {} as never)).rejects.toThrow("onebot_reaction_face_unsupported");
    }
    expect(react).not.toHaveBeenCalled();
  });

  it("invites reactions in the system prompt only when reactions are encouraged", async () => {
    for (const [encourageReactions, type, threshold] of [
      [true, "direct", 5],
      [true, "guild", 0],
      [true, "guild", 5],
      [false, "direct", 5],
      [false, "guild", 5],
    ] as const) {
      const { ctx, plugins } = createContext();
      const plugin = new OnebotUtilsPlugin(ctx as never, { encourageReactions, quoteReplyAfterMessages: threshold } as never);
      await plugin.start();
      const runtime = await plugins[0]!.setup(createChannelContext({ type }) as never, qq() as never);
      const guidance = await runtime?.appendSystemPrompt?.({} as never);
      if (encourageReactions) expect(guidance).toContain("QQ 表情回应");
      else expect(guidance ?? "").not.toContain("表情回应");
      if (type === "guild" && threshold > 0) expect(guidance).toContain("QQ 群聊引用");
    }
  });

  it("sets essence through the account's OneBot action", async () => {
    const setEssence = vi.fn(async () => null);
    const runtime = await createRuntime(qq({ set_essence_msg: setEssence }));
    const tool = (await runtime.getTools()).find((item) => item.name === "onebot_set_essence")!;

    await expect(tool.execute?.({ messageId: "message-id" }, {} as never)).resolves.toEqual({ success: true });
    expect(setEssence).toHaveBeenCalledWith({ message_id: "message-id" });
  });

  it("keeps group management off in a group the owner has not enabled", async () => {
    const runtime = await createRuntime(qq(), { enabledTools: ["onebot_group_admin"] });
    const names = (await runtime.getTools()).map((tool) => tool.name);

    expect(names).not.toContain("onebot_group_admin");
  });

  it("bans and unbans through the account's OneBot actions", async () => {
    const request = groupRequest();
    const tools = await nativeTools(qqVia(request), { moderationGroups: ["456"] });
    const admin = tools.find((tool) => tool.name === "onebot_group_admin")!;
    const byAdmin = { messages: [sender("900")] } as never;

    await expect(admin.execute?.({ action: "ban", userId: "123", duration: 60 }, byAdmin)).resolves.toEqual({ success: true });
    await expect(admin.execute?.({ action: "unban", userId: "123" }, byAdmin)).resolves.toEqual({ success: true });

    expect(request).toHaveBeenCalledWith("get_group_member_info", { group_id: 456, user_id: 900, no_cache: true });
    expect(request).toHaveBeenNthCalledWith(2, "set_group_ban", { group_id: 456, user_id: 123, duration: 60 });
    expect(request).toHaveBeenNthCalledWith(4, "set_group_ban", { group_id: 456, user_id: 123, duration: 0 });
  });

  it("reports a QQ refusal as a registered failure and keeps QQ's text out of the result", async () => {
    const request = groupRequest();
    const tool = (await nativeTools(qqVia(request), { moderationGroups: ["456"] })).find((item) => item.name === "onebot_group_admin")!;
    request.mockImplementation(async (action: string) => {
      if (action === "get_group_member_info") return { role: "admin" };
      throw new Error("sk-upstream-secret not admin");
    });

    const result = await tool.execute?.({ action: "ban", userId: "123", duration: 60 }, { messages: [sender("900")] } as never);
    expect(result).toEqual({
      ok: false,
      error: { code: "onebot_request_failed", message: expect.stringContaining("自己不是本群管理员"), retryable: false },
      effect: "unknown",
    });
    expect(JSON.stringify(result)).not.toContain("sk-upstream");
    await expect(tool.execute?.({ action: "ban", userId: "abc", duration: 60 }, { messages: [sender("900")] } as never)).resolves.toMatchObject({
      error: { code: "onebot_user_id_invalid" },
      effect: "none",
    });
  });

  it("kicks members through the account's OneBot action", async () => {
    const request = groupRequest();
    const tool = (await nativeTools(qqVia(request), { moderationGroups: ["456"] })).find((item) => item.name === "onebot_group_admin")!;

    await expect(tool.execute?.({ action: "kick", userId: "123", rejectAddRequest: true }, { messages: [sender("901")] } as never)).resolves.toEqual({
      success: true,
    });
    expect(request).toHaveBeenCalledWith("set_group_kick", { group_id: 456, user_id: 123, reject_add_request: true });
  });

  // User, 2026-11-18: 「按群开启，只听管理员」.
  it("runs group management only in enabled groups and only for the group's owner or admins", async () => {
    const request = groupRequest();
    expect((await nativeTools(qqVia(request), { moderationGroups: ["999"] })).map((tool) => tool.name)).not.toContain("onebot_group_admin");
    const ban = (await nativeTools(qqVia(request), { moderationGroups: [" 456 "] })).find((tool) => tool.name === "onebot_group_admin")!;
    const run = (...senders: string[]) => ban.execute?.({ action: "ban", userId: "123", duration: 60 }, { messages: senders.map(sender) } as never);

    await expect(run("555")).resolves.toMatchObject({ ok: false, error: { code: "onebot_moderation_not_admin" }, userId: "555" });
    // An admin's message batched with an ordinary member's does not count as the admin's request alone.
    await expect(run("900", "555")).resolves.toMatchObject({ error: { code: "onebot_moderation_not_admin" }, userId: "555" });
    // A schedule or heartbeat turn has no sender to check.
    await expect(run()).resolves.toMatchObject({ error: { code: "onebot_moderation_no_sender", message: expect.stringContaining("没有可核实的发送者") } });
    expect(request).not.toHaveBeenCalledWith("set_group_ban", expect.anything());
    request.mockRejectedValueOnce(new Error("timeout"));
    await expect(run("900")).resolves.toMatchObject({ error: { code: "onebot_moderation_check_failed" }, userId: "900" });
    expect(request).not.toHaveBeenCalledWith("set_group_ban", expect.anything());
    await expect(run("900", "901")).resolves.toEqual({ success: true });
  });
});

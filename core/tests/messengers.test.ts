import type { Part } from "@yesimbot/contracts/parts";
import { describe, expect, it, vi } from "vitest";

import type { ChatAccount } from "../src/accounts.js";
import type { ChannelAllowRule } from "../src/config.js";
import type { EventRecord } from "../src/messages/index.js";
import { Messenger, matchesAllowedChannel, type Inbound } from "../src/messengers/index.js";
import { testAccount } from "./helpers/index.js";

const wildcard: readonly ChannelAllowRule[] = [{ platform: "*", channelId: "*" }];

const event: EventRecord<"delivery.failed"> = {
  eventType: "delivery.failed",
  platform: "test",
  selfId: "bot-1",
  timestamp: 1,
  channel: { id: "room-1", type: 0 },
  text: "delivery failed",
  delivery: { turnId: "turn-1", messageId: "message-1", segmentIndex: 0, segmentTotal: 1, error: { name: "Error", message: "offline" } },
};

/** The kernel messenger over `accounts`, wired as a host wires it. */
function messengerOf(
  accounts: readonly ChatAccount[],
  allowedChannels: readonly ChannelAllowRule[],
  channels: unknown,
  runtimes: unknown,
  assignee: (platform: string, channelId: string) => string | undefined = () => "bot-1",
) {
  return new Messenger({
    allowedChannels: () => allowedChannels,
    channels: channels as never,
    runtimes: runtimes as never,
    account: (platform, selfId) => accounts.find((account) => account.platform === platform && account.selfId === selfId),
    assignee: async (context) => assignee(context.platform, context.channelId),
  });
}

function inbound(context: Inbound["context"], selfId: string, translate: Inbound["translate"], routeId = "route-1"): Inbound {
  return { context, selfId, routeId, translate };
}

describe("Messenger", () => {
  it("implicitly admits only the account holder's web conversations, even with a wildcard reply rule", async () => {
    const context = { type: "direct", platform: "web", channelId: "owner", userId: "owner", selfId: "bot" } as const;
    expect(matchesAllowedChannel(context, [])).toBe(true);
    expect(matchesAllowedChannel(context, undefined)).toBe(true);
    // Later web conversations are owner.<8 hex>, with the same user and channel ID.
    expect(matchesAllowedChannel({ ...context, userId: "owner.0a1b2c3d", channelId: "owner.0a1b2c3d" }, [])).toBe(true);
    for (const invalid of [
      { ...context, userId: "other" },
      { ...context, selfId: "other" },
      { ...context, channelId: "other" },
      { ...context, type: "guild", guildId: "owner" },
      { ...context, userId: "owner.0a1b2c3d" },
      { ...context, userId: "owner.0A1B2C3D", channelId: "owner.0A1B2C3D" },
      { ...context, userId: "owner.x", channelId: "owner.x" },
    ])
      expect(matchesAllowedChannel(invalid as never, wildcard)).toBe(false);
    expect(matchesAllowedChannel({ ...context, platform: "onebot" }, [])).toBe(false);
    const resolve = vi.fn();
    const messenger = messengerOf([testAccount("web", "bot")], wildcard, { start: vi.fn(), resolve }, {});
    const translate = vi.fn(async () => null);
    for (const denied of [
      { ...context, userId: "other" },
      { type: "guild", platform: "web", channelId: "owner", guildId: "owner", selfId: "bot" },
    ] as const)
      await messenger.accept(inbound(denied, "bot", translate));
    expect(resolve).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
  });

  it("routes an input once: admission, assignee, the conversation's resources, then the runtime", async () => {
    const handle = vi.fn(async () => ({ kind: "run" as const, eventId: "event-1", done: Promise.resolve() }));
    const resources = { persistParts: async (parts: unknown) => parts };
    const channels = { start: vi.fn(async () => {}), resolve: vi.fn(async () => ({ resources })) };
    const account = testAccount();
    const get = vi.fn(async () => ({ handle }));
    const messenger = messengerOf([account], wildcard, channels, { get });
    const record = { platform: "test", selfId: "bot-1", channel: { id: "peer", type: 1 }, messageId: "m1", parts: [{ type: "text", text: "hi" }] };
    const translate = vi.fn(async () => record as never);
    await messenger.accept(inbound({ type: "direct", platform: "test", channelId: "peer", selfId: "bot-1", userId: "peer" }, "bot-1", translate));
    expect(translate).toHaveBeenCalledExactlyOnceWith(resources);
    expect(handle).toHaveBeenCalledExactlyOnceWith(record);
    expect(get.mock.calls[0]![1]).toBe(account);
  });

  it("lets an active post reach only the fixed web direct conversation, never a web notification channel", async () => {
    const runtime = { post: vi.fn(async () => ({ kind: "wait" as const, eventId: "event-1" })) };
    const channels = { resolve: vi.fn(async (context: unknown) => ({ context })) };
    const messenger = messengerOf([testAccount("web", "bot")], [], channels, { get: vi.fn(async () => runtime) });
    const web = { ...event, platform: "web", selfId: "bot" };
    for (const channel of [
      { id: "notifications:bot", type: 0 },
      { id: "other", type: 1 },
    ])
      await expect(messenger.post({ ...web, channel })).rejects.toThrow("web_chat_target_denied");
    await expect(messenger.post({ ...web, channel: { id: "owner", type: 1 }, user: { id: "other" } } as never)).rejects.toThrow("web_chat_target_denied");
    expect(channels.resolve).not.toHaveBeenCalled();
    await messenger.post({ ...web, channel: { id: "owner", type: 1 } });
    expect(channels.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ type: "direct", platform: "web", channelId: "owner", userId: "owner", selfId: "bot" }),
    );
    expect(runtime.post).toHaveBeenCalledOnce();
  });

  it("routes an active post through its matching account and awaits the producing Runtime turn", async () => {
    const exact = testAccount("test", "bot-1");
    const decoy = testAccount("test", "bot-2");
    let settled = false;
    const runtime = {
      context: { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" },
      post: vi.fn(async () => ({
        kind: "run" as const,
        eventId: "event-1",
        done: Promise.resolve().then(() => {
          settled = true;
        }),
      })),
    };
    const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
    const runtimes = { get: vi.fn(async () => runtime) };

    const messenger = messengerOf([decoy, exact], [], channels, runtimes);

    await messenger.post(event);

    expect(runtimes.get.mock.calls[0]![1]).toBe(exact);
    expect(runtime.post).toHaveBeenCalledWith(event, { trigger: true, ifBusy: "defer" });
    expect(settled).toBe(true);
    // Delivery belongs to send_message inside the turn, so the messenger never touches the account.
    expect(exact.sendMessage).not.toHaveBeenCalled();
    expect(decoy.sendMessage).not.toHaveBeenCalled();
  });

  it("forwards the silent delivery intent to the Runtime that enforces it", async () => {
    const account = testAccount("test", "bot-1");
    const runtime = {
      context: { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" },
      post: vi.fn(async () => ({ kind: "run" as const, eventId: "event-1", done: Promise.resolve() })),
    };
    const channels = { resolve: vi.fn(async () => ({ context: runtime.context })) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const messenger = messengerOf([account], [], channels, runtimes);

    await messenger.post(event, { trigger: true, ifBusy: "defer", delivery: "silent" });

    expect(runtime.post).toHaveBeenCalledWith(event, { trigger: true, ifBusy: "defer", delivery: "silent" });
    expect(account.sendMessage).not.toHaveBeenCalled();
  });

  it("reports how a posted turn ended after it finished, and nothing for a stopped messenger", async () => {
    let finished = false;
    const results = [
      {
        kind: "run" as const,
        eventId: "event-1",
        done: Promise.resolve().then(() => void (finished = true)),
        outcome: Promise.resolve({ status: "done" as const, delivered: false }),
      },
      { kind: "run" as const, eventId: "event-2", done: Promise.resolve() },
      { kind: "wait" as const, eventId: "event-3" },
    ];
    const runtime = { post: vi.fn(async () => results.shift()) };
    const channels = { resolve: vi.fn(async () => ({})) };
    const messenger = messengerOf([testAccount()], [], channels, { get: vi.fn(async () => runtime), stop: vi.fn(async () => {}) });

    expect(await messenger.postAndReport(event)).toEqual({ kind: "run", outcome: { status: "done", delivered: false } });
    expect(finished).toBe(true);
    // A runtime that does not report outcomes, and an event stored without a turn.
    expect(await messenger.postAndReport(event)).toEqual({ kind: "run" });
    expect(await messenger.postAndReport(event)).toEqual({ kind: "wait" });
    await messenger.stop();
    expect(await messenger.postAndReport(event)).toEqual({ kind: "closed" });
    await expect(messenger.post(event)).resolves.toBeUndefined();
  });

  it("stores the account holder's private word as a marked message and starts a turn on it in that conversation", async () => {
    const runtime = {
      post: vi.fn(async () => ({
        kind: "run" as const,
        eventId: "w",
        done: Promise.resolve(),
        outcome: Promise.resolve({ status: "done" as const, delivered: true }),
      })),
    };
    const channels = { resolve: vi.fn(async () => ({})) };
    const messenger = messengerOf([testAccount()], [], channels, { get: vi.fn(async () => runtime), stop: vi.fn(async () => {}) });
    const group = { type: "channel" as const, platform: "test", channelId: "room-1", guildId: "room-1", selfId: "bot-1" };

    const result = await messenger.whisper(group, "  少说点游戏的事  ", { at: 5 });

    expect(result).toEqual({ kind: "run", messageId: expect.stringMatching(/^whisper-/), outcome: { status: "done", delivered: true } });
    expect(channels.resolve).toHaveBeenCalledWith(group);
    const [record, options] = runtime.post.mock.calls[0] as unknown as [Record<string, unknown>, unknown];
    expect(options).toEqual({ trigger: true, ifBusy: "defer", historyMode: "conversation" });
    expect(record).toMatchObject({
      platform: "test",
      selfId: "bot-1",
      channel: { id: "room-1", type: 0 },
      user: { id: "owner", name: "主人" },
      timestamp: 5,
      whisper: true,
      messageId: (result as { messageId: string }).messageId,
    });
    expect(record.parts).toEqual([{ type: "text", text: "少说点游戏的事" }]);

    // Never into a web conversation, never empty, never without the conversation's own bot.
    await expect(messenger.whisper({ type: "direct", platform: "web", channelId: "owner", selfId: "bot", userId: "owner" }, "hi")).rejects.toThrow(
      "whisper_target_denied",
    );
    await expect(messenger.whisper(group, "   ")).rejects.toThrow("whisper_empty");
    await expect(messenger.whisper({ ...group, selfId: "bot-9" }, "hi")).rejects.toMatchObject({ code: "messenger_account_unavailable" });
    await messenger.stop();
    expect(await messenger.whisper(group, "hi")).toEqual({ kind: "closed" });
  });

  it("hands the conversation's resources to the translation, which persists media before the runtime sees the record", async () => {
    const account = testAccount();
    const persistParts = vi.fn(async (parts: readonly Part[]) =>
      parts.map((part): Part => (part.type === "image" ? { type: "image", asset: "0123456789abcdef0123456789abcdef" } : part)),
    );
    const channel = { context: { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" }, resources: { persistParts } };
    const runtime = { handle: vi.fn(async () => ({ kind: "wait" as const, eventId: "event-1" })) };
    const channels = { start: vi.fn(async () => undefined), resolve: vi.fn(async () => channel) };
    const runtimes = { get: vi.fn(async () => runtime) };
    const assignee = vi.fn(() => "bot-1");
    const messenger = messengerOf([account], [{ platform: "test", channelId: "room-1" }], channels, runtimes, assignee);

    await messenger.accept(
      inbound({ type: "guild", platform: "test", channelId: "room-1", guildId: "room-1", selfId: "bot-1" }, "bot-1", async (resources) => ({
        platform: "test",
        selfId: "bot-1",
        channel: { id: "room-1", type: 0 },
        user: { id: "user-1" },
        timestamp: 1,
        messageId: "message-1",
        parts: await (resources as unknown as { persistParts(parts: readonly Part[]): Promise<Part[]> }).persistParts([
          { type: "image", src: "https://example.test/image.png" },
        ]),
      })),
    );

    expect(persistParts).toHaveBeenCalledOnce();
    expect(runtime.handle).toHaveBeenCalledWith(expect.objectContaining({ parts: [{ type: "image", asset: "0123456789abcdef0123456789abcdef" }] }));
    expect(runtimes.get.mock.calls[0]![0]).toBe(channel);
    expect(runtimes.get.mock.calls[0]![1]).toBe(account);
  });

  it("drops input for a shared conversation assigned to another account, or without an assignee, before any translation", async () => {
    const channels = { start: vi.fn(async () => undefined), resolve: vi.fn() };
    const translate = vi.fn(async () => null);
    const group = { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1", selfId: "bot-1" } as const;
    for (const assignee of ["bot-2", undefined]) {
      const messenger = messengerOf([testAccount()], [{ platform: "test", channelId: "room-1" }], channels, {}, () => assignee);
      await messenger.accept(inbound(group, "bot-1", translate));
    }
    expect(translate).not.toHaveBeenCalled();
    expect(channels.resolve).not.toHaveBeenCalled();
    // A durable inbox asks for the failure, so it keeps the input.
    const strict = messengerOf([testAccount()], [{ platform: "test", channelId: "room-1" }], channels, {}, () => "bot-2");
    await expect(strict.accept(inbound(group, "bot-1", translate), true)).rejects.toMatchObject({ code: "messenger_assignee_denied" });
  });

  it("rejects an active post without a matching account before Runtime creation", async () => {
    const channels = { resolve: vi.fn() };
    const runtimes = { get: vi.fn() };
    const messenger = messengerOf([testAccount("test", "other")], [], channels, runtimes);

    await expect(messenger.post(event)).rejects.toMatchObject({ code: "messenger_account_unavailable", detail: "test:bot-1" });

    expect(channels.resolve).not.toHaveBeenCalled();
    expect(runtimes.get).not.toHaveBeenCalled();
  });
});

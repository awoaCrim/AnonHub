import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppError, configureLogging, manualClock, systemClock, type LogRecord } from "@yesimbot/foundation";
import { AgentWechatError, type AgentWechatMessage } from "@yesimbot/wechat-transport";
import { CHANNEL_TYPE, type Part } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

import { createAutoReplyWill } from "../src/auto-reply.js";
import type { Config } from "../src/config.js";
import { WechatConnection, type BridgeHost, type InboundMessage } from "../src/connection.js";
import { messageParts, messageQuote, readMessageFile, readMessageImage } from "../src/inbound.js";
import { sendParts, type SendApi } from "../src/outbound.js";

const clock = systemClock();
const text = (value: string): Part => ({ type: "text", text: value });

const config: Config = {
  allowedRooms: ["123@chatroom"],
  allowedPeers: ["wxid_peer"],
  autoReply: { direct: true, group: false },
  endpoint: "http://127.0.0.1:6174",
  tokenFile: "token",
  account: "bot",
};

function message(overrides: Partial<AgentWechatMessage> = {}): AgentWechatMessage {
  return {
    id: "msg_1",
    threadId: "wxid_peer",
    serverId: "1234567890123456789",
    senderId: "wxid_peer",
    type: 1,
    direction: "incoming",
    body: "hello",
    createdAt: new Date().toISOString(),
    mentions: { state: "known", userIds: [], self: false, all: false },
    ...overrides,
  };
}

const none = { image: async () => undefined, file: async () => ({ failure: "timeout" as const }) };

describe("incoming messages", () => {
  it("keeps a mention of the bot and the reply's words, and hands the quoted message over as the quote", async () => {
    const reply = message({
      threadId: "123@chatroom",
      type: 49,
      appMessageType: 57,
      body: "同意",
      mentions: { state: "known", userIds: ["wxid_self"], self: true, all: false },
      quote: { serverId: "42", type: 1, senderId: "wxid_b", senderName: "B", embeddedText: "开会吗" },
    });
    expect(await messageParts(reply, "wxid_self", none)).toEqual([{ type: "mention", userId: "wxid_self" }, text("同意")]);
    expect(messageQuote(reply)).toEqual({ id: "42", user: { id: "wxid_b", name: "B" }, parts: [text("开会吗")] });
    // Quoted media and links are summarized; a plain message is no quote.
    expect(messageQuote(message({ ...reply, quote: { serverId: "43", type: 3, embeddedImage: true } }))?.parts).toEqual([text("[图片]")]);
    expect(messageQuote(message({ ...reply, quote: { serverId: "44", type: 47 } }))?.parts).toEqual([text("[表情]")]);
    expect(
      messageQuote(message({ ...reply, quote: { serverId: "45", type: 49, embeddedLink: { title: "文章", url: "https://example.com/a" } } }))?.parts,
    ).toEqual([text("文章\nhttps://example.com/a")]);
    expect(messageQuote(message({ ...reply, quote: { serverId: "46", type: 1, state: "recalled" } }))?.parts).toEqual([text("[已撤回的消息]")]);
    expect(messageQuote(message())).toBeUndefined();
  });

  it("reads pictures, stickers and files, and names other media", async () => {
    const image = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: "image/jpeg" };
    const [picture] = (await messageParts(message({ type: 3, body: null }), "wxid_self", { ...none, image: async () => image }))!;
    expect(picture!.type).toBe("image");
    expect((picture as { src: string }).src).toMatch(/^data:image\/jpeg;base64,/);
    expect(await messageParts(message({ type: 47, body: null }), "wxid_self", none)).toEqual([text("[表情（未能读取）]")]);
    expect(await messageParts(message({ type: 34, body: null }), "wxid_self", none)).toEqual([text("[语音消息]\n[语音尚未转写]")]);
    // Core decides what a file is to the model (text read in, picture looked at, other types named) from its name.
    const file = { bytes: new TextEncoder().encode("纪要"), mediaType: "text/plain", filename: "会议.txt" };
    const [read] = (await messageParts(message({ type: 49, appMessageType: 6, body: "会议.txt" }), "wxid_self", { ...none, file: async () => file }))!;
    expect(read).toEqual({ type: "file", src: `data:text/plain;base64,${Buffer.from("纪要").toString("base64")}`, title: "会议.txt" });
    const [unread] = (await messageParts(message({ type: 49, appMessageType: 6, body: "报告.pdf" }), "wxid_self", {
      ...none,
      file: async () => ({ failure: "too_large" as const }),
    }))!;
    expect(unread).toEqual({ type: "file", title: "报告.pdf", failure: "too_large" });
    expect(await messageParts(message({ type: 49, appMessageType: 5, body: "文章", link: { url: "https://example.com/a" } }), "wxid_self", none)).toEqual([
      text("文章\nhttps://example.com/a"),
    ]);
  });

  it("waits for the daemon to download a sticker, asking once, and reads it", async () => {
    let state = "pending";
    const api = {
      mediaAssets: vi.fn(async () => [{ id: "asset_1", kind: "sticker", variant: "original", state, contentType: null, byteLength: null, jobId: null }]),
      transferMedia: vi.fn(async () => {
        state = "available";
        return { id: "job_1" };
      }),
      mediaContent: vi.fn(async () => ({ bytes: new Uint8Array([0x47, 0x49, 0x46]), contentType: "image/gif" })),
      job: vi.fn(),
    };
    expect(await readMessageImage(api as never, "acct", message({ type: 47, body: null }), { clock })).toEqual({
      bytes: new Uint8Array([0x47, 0x49, 0x46]),
      mediaType: "image/gif",
    });
    expect(api.transferMedia).toHaveBeenCalledOnce();
  });

  it("keeps waiting while the daemon's download is alive, and stops when it failed or after a minute", async () => {
    vi.useFakeTimers();
    try {
      let state = "pending";
      const api = {
        mediaAssets: vi.fn(async () => [{ id: "asset_1", kind: "sticker", variant: "original", state, contentType: null, byteLength: null, jobId: "job_1" }]),
        transferMedia: vi.fn(),
        job: vi.fn(async () => ({ id: "job_1", state: "running" })),
        mediaContent: vi.fn(async () => ({ bytes: new Uint8Array([0x47]), contentType: "image/gif" })),
      };
      const sticker = message({ type: 47, body: null });
      // The 2 MB sticker of 2026-11-23: 27 s in "running" with no bytes reported.
      const slow = readMessageImage(api as never, "acct", sticker, { clock });
      await vi.advanceTimersByTimeAsync(27_000);
      state = "available";
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await slow).toEqual({ bytes: new Uint8Array([0x47]), mediaType: "image/gif" });
      expect(api.transferMedia).not.toHaveBeenCalled();

      state = "pending";
      const endless = readMessageImage(api as never, "acct", sticker, { clock });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await endless).toBeUndefined();

      api.job.mockResolvedValue({ id: "job_1", state: "failed" });
      const started = Date.now();
      expect(await readMessageImage(api as never, "acct", sticker, { clock })).toBeUndefined();
      expect(Date.now()).toBe(started);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a file up to Core's limit and does not fetch a larger one", async () => {
    const asset = {
      id: "asset_f",
      kind: "file",
      variant: "original",
      state: "available",
      contentType: "text/plain",
      byteLength: 6,
      filename: "会议.txt",
      jobId: null,
    };
    const api = {
      mediaAssets: vi.fn(async () => [asset]),
      transferMedia: vi.fn(),
      mediaContent: vi.fn(async () => ({ bytes: new TextEncoder().encode("纪要"), contentType: "text/plain; charset=utf-8" })),
      job: vi.fn(),
    };
    const file = message({ type: 49, appMessageType: 6, body: "会议.txt" });
    expect(await readMessageFile(api as never, "acct", file, { clock })).toEqual({
      bytes: new TextEncoder().encode("纪要"),
      mediaType: "text/plain",
      filename: "会议.txt",
    });
    api.mediaAssets.mockResolvedValue([{ ...asset, byteLength: 50 * 1024 * 1024, filename: "录像.zip" }] as never);
    api.mediaContent.mockClear();
    expect(await readMessageFile(api as never, "acct", file, { clock })).toEqual({ failure: "too_large", filename: "录像.zip" });
    expect(api.mediaContent).not.toHaveBeenCalled();
  });

  it("drops recalled messages, system notices and empty text", async () => {
    expect(await messageParts(message({ recall: {} }), "wxid_self", none)).toBeUndefined();
    expect(await messageParts(message({ type: 10000 }), "wxid_self", none)).toBeUndefined();
    expect(await messageParts(message({ body: "  " }), "wxid_self", none)).toBeUndefined();
  });
});

function sendApi(overrides: Partial<Record<keyof SendApi, unknown>> = {}) {
  const api = {
    sendText: vi.fn(async () => ({ id: "send_1", state: "queued", serverId: null, errorCode: null })),
    sendIntent: vi.fn(async () => ({ id: "send_1", state: "accepted", serverId: "9001", errorCode: null, localMessageId: "msg_out" })),
    sendMedia: vi.fn(async () => ({ id: "job_1", kind: "send", state: "queued", reason: null, assetId: null, serverMessageId: null })),
    job: vi.fn(async () => ({ id: "job_1", kind: "send", state: "accepted", reason: null, assetId: null, serverMessageId: "9002" })),
    upload: vi.fn(async () => ({ id: "src_1", byteLength: 3 })),
    sendByKey: vi.fn(async () => ({ id: "send_1", state: "accepted", serverId: "9003", errorCode: null })),
    threadMessages: vi.fn(async () => [message({ id: "msg_quoted", serverId: "77" })]),
    ...overrides,
  };
  return api as typeof api & SendApi;
}

describe("sending", () => {
  it("sends group text with real mentions and a quote, and waits for WeChat to accept it", async () => {
    const api = sendApi();
    const quotes = new Map<string, string>();
    const ids = await sendParts({ api, account: "bot", threadId: "123@chatroom", quotes, clock }, [
      { type: "quote", messageId: "77", parts: [] },
      { type: "mention", userId: "wxid_b" },
      text("好的"),
    ]);
    expect(ids).toEqual(["9001"]);
    expect(api.sendText).toHaveBeenCalledWith(
      "bot",
      { kind: "text", threadId: "123@chatroom", text: "好的", quote: { messageId: "msg_quoted", serverId: "77" }, mentions: { userIds: ["wxid_b"] } },
      expect.stringMatching(/^yesimbot:/),
      undefined,
    );
    // The bot's own message can be quoted later.
    expect(quotes.get("9001")).toBe("msg_out");
  });

  it("writes a mention as text in direct chats and sends pictures after the text", async () => {
    const api = sendApi();
    const ids = await sendParts({ api, account: "bot", threadId: "wxid_peer", quotes: new Map(), clock }, [
      { type: "mention", userId: "wxid_peer", name: "小明" },
      text("看图"),
      { type: "image", src: "data:image/png;base64,AQID" },
    ]);
    expect(ids).toEqual(["9001", "9002"]);
    expect(api.sendText.mock.calls[0]![1]).toEqual({ kind: "text", threadId: "wxid_peer", text: "@小明 看图" });
    expect(api.upload).toHaveBeenCalledWith("bot", Buffer.from([1, 2, 3]), "image.png", "image/png", undefined);
    expect(api.sendMedia.mock.calls[0]![1]).toEqual({ kind: "image", threadId: "wxid_peer", sourceId: "src_1" });
  });

  it("sends an animated sticker as a plain picture under its title", async () => {
    const api = sendApi();
    await sendParts({ api, account: "bot", threadId: "wxid_peer", quotes: new Map(), clock }, [
      { type: "image", src: "data:image/gif;base64,AQID", title: "sticker.gif", sticker: true },
    ]);
    expect(api.upload).toHaveBeenCalledWith("bot", Buffer.from([1, 2, 3]), "sticker.gif", "image/gif", undefined);
    expect(api.sendMedia.mock.calls[0]![1]).toMatchObject({ kind: "image", threadId: "wxid_peer" });
  });

  it("never resends: an unknown outcome stays unknown and a refusal is a failure", async () => {
    const target = { account: "bot", threadId: "wxid_peer", quotes: new Map<string, string>(), clock };
    await expect(
      sendParts({ ...target, api: sendApi({ sendIntent: vi.fn(async () => ({ id: "send_1", state: "needs_review", serverId: null, errorCode: null })) }) }, [
        text("hi"),
      ]),
    ).rejects.toMatchObject({ code: "wechat_send_unknown", effect: "unknown" });
    const refused = sendApi({
      sendText: vi.fn(async () => {
        throw new AgentWechatError(409, "auth_required");
      }),
    });
    await expect(sendParts({ ...target, api: refused }, [text("hi")])).rejects.toMatchObject({
      code: "wechat_send_failed",
      detail: "auth_required",
      effect: "none",
    });
    expect(refused.sendByKey).not.toHaveBeenCalled();
  });

  it("looks the key up instead of submitting again when the request may have arrived", async () => {
    const api = sendApi({
      sendText: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(await sendParts({ api, account: "bot", threadId: "wxid_peer", quotes: new Map(), clock }, [text("hi")])).toEqual(["9003"]);
    expect(api.sendText).toHaveBeenCalledTimes(1);
    expect(api.sendByKey.mock.calls[0]![1]).toBe((api.sendText.mock.calls[0] as unknown[])[2]);
  });

  it("keeps the cause when the lookup by key fails too, and logs it", async () => {
    const records: LogRecord[] = [];
    configureLogging({ level: "debug", sink: (record) => records.push(record) });
    const lookup = new TypeError("lookup down");
    const api = sendApi({
      sendText: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
      sendByKey: vi.fn(async () => {
        throw lookup;
      }),
    });
    const failure = await sendParts({ api, account: "bot", threadId: "wxid_peer", quotes: new Map(), clock }, [text("hi")]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "wechat_send_unknown", cause: lookup });
    expect(records.find((record) => record.event === "send.outcome_unknown")).toMatchObject({ level: "warn", message: "lookup down" });
  });

  it("gives up on a send that WeChat never answers, by the clock", async () => {
    const manual = manualClock(0);
    const api = sendApi({
      sendText: vi.fn(async () => ({ id: "send_1", state: "queued", serverId: null, errorCode: null })),
      sendIntent: vi.fn(async () => {
        manual.advance(40_000);
        return { id: "send_1", state: "queued", serverId: null, errorCode: null };
      }),
    });
    await expect(sendParts({ api, account: "bot", threadId: "wxid_peer", quotes: new Map(), clock: manual }, [text("hi")])).rejects.toMatchObject({
      code: "wechat_send_unknown",
    });
    expect(api.sendIntent).toHaveBeenCalledTimes(2);
  });

  it("sends line breaks, paragraphs, wrappers and audio parts", async () => {
    const api = sendApi();
    const sent: Part[] = [
      { type: "platform", tag: "p", attrs: {}, parts: [text("甲")] },
      { type: "platform", tag: "br", attrs: {}, parts: [] },
      { type: "platform", tag: "b", attrs: {}, parts: [text("乙")] },
      { type: "image", src: "data:image/png;base64,AQID" },
    ];
    const ids = await sendParts({ api, account: "bot", threadId: "wxid_peer", quotes: new Map(), clock }, sent);
    expect(ids).toEqual(["9001", "9002"]);
    expect(api.sendText.mock.calls[0]![1]).toMatchObject({ text: "甲\n\n乙" });
    await expect(
      sendParts({ api, account: "bot", threadId: "wxid_peer", quotes: new Map(), clock }, [{ type: "platform", tag: "face", attrs: {}, parts: [] }]),
    ).rejects.toMatchObject({
      code: "wechat_unsupported_element",
      detail: "face",
    });
    await expect(sendParts({ api, account: "bot", threadId: "wxid_peer", quotes: new Map(), clock }, [{ type: "image" }])).rejects.toMatchObject({
      code: "wechat_media_source_missing",
    });
  });
});

describe("auto reply", () => {
  it("triggers only in allowed chats of the logged-in account and per chat type", async () => {
    const will = createAutoReplyWill(config, () => "wxid_self");
    const engine = will.setup({ platform: "wechat-bridge", selfId: "wxid_self", type: "direct", channelId: "wxid_peer" } as never);
    const input = (parts: Part[]) => ({
      type: "yesimbot.message",
      data: { platform: "wechat-bridge", selfId: "wxid_self", channel: { id: "wxid_peer", type: CHANNEL_TYPE.direct }, parts },
    });
    expect(
      await engine.decide(
        input([
          { type: "text", text: "好" },
          { type: "quote", messageId: "q", parts: [] },
        ]) as never,
        {} as never,
      ),
    ).toBe("trigger");
    expect(await engine.decide(input([{ type: "file", asset: "a".repeat(32) }]) as never, {} as never)).toBe("wait");
    expect(createAutoReplyWill(config, () => undefined).match({ platform: "wechat-bridge", selfId: "", type: "direct", channelId: "wxid_peer" } as never)).toBe(
      false,
    );
    const group = will.setup({ platform: "wechat-bridge", selfId: "wxid_self", type: "guild", channelId: "123@chatroom" } as never);
    expect(await group.decide(input([{ type: "text", text: "好" }]) as never, {} as never)).toBe("wait");
  });
});

async function connection(events: { cursor: string; kind: string; data: Record<string, unknown> }[], messages: Record<string, AgentWechatMessage>) {
  const baseDir = await mkdtemp(join(tmpdir(), "wechat-bridge-"));
  const received: InboundMessage[] = [];
  const state = { selfId: undefined as string | undefined, online: false };
  const host: BridgeHost = {
    selfId: () => state.selfId,
    online: () => state.online,
    presence: vi.fn(({ selfId, online }) => {
      if (selfId) state.selfId = selfId;
      state.online = online;
    }),
    receive: vi.fn(async (message: InboundMessage) => void received.push(message)),
  };
  let served = false;
  const api = {
    findAccount: vi.fn(async () => ({ id: "account-1", alias: "bot", ownUsername: "wxid_self", authenticated: true, connection: "online" })),
    status: vi.fn(async () => ({ serverId: "server-1" })),
    newestCursor: vi.fn(async () => "5"),
    events: vi.fn(async function* (_account: string, _query: unknown, signal?: AbortSignal) {
      if (served) {
        await new Promise((resolve) => signal?.addEventListener("abort", resolve));
        return;
      }
      served = true;
      yield* events;
    }),
    message: vi.fn(async (_account: string, id: string) => messages[id]!),
    groupMember: vi.fn(async () => ({ username: "wxid_b", roomDisplayName: "群名片" })),
    contact: vi.fn(async () => ({ username: "wxid_peer", displayName: "小明" })),
    thread: vi.fn(async () => ({ id: "123@chatroom", displayName: "工作群" })),
    mediaAssets: vi.fn(async () => []),
  };
  const target = new WechatConnection({ api: api as never, config, host, clock, stateDirectory: join(baseDir, "data/wechat-bridge") });
  return { target, api, host, received, baseDir };
}

describe("event stream", () => {
  it("admits fresh incoming messages from allowed chats and saves its position after Core took them", async () => {
    const committed = (cursor: string, messageId: string, origin = "live", direction = "incoming") => ({
      cursor,
      kind: "message.committed",
      data: { messageId, origin, direction },
    });
    const { target, api, host, received, baseDir } = await connection(
      [
        committed("6", "m_peer"),
        committed("7", "m_catchup", "catchup"),
        committed("8", "m_own", "local_send", "outgoing"),
        committed("9", "m_stranger"),
        committed("10", "m_group"),
        committed("11", "m_old"),
      ],
      {
        m_peer: message({ id: "m_peer", serverId: "100" }),
        m_stranger: message({ id: "m_stranger", threadId: "wxid_stranger", senderId: "wxid_stranger", serverId: "101" }),
        m_group: message({
          id: "m_group",
          threadId: "123@chatroom",
          senderId: "wxid_b",
          serverId: "102",
          type: 49,
          appMessageType: 57,
          body: "大家好",
          quote: { serverId: "100", type: 1, senderId: "wxid_peer", embeddedText: "hello" },
        }),
        m_old: message({ id: "m_old", serverId: "103", createdAt: new Date(Date.now() - 3_600_000).toISOString() }),
      },
    );
    target.start();
    await vi.waitFor(async () => {
      const [file] = await readdir(join(baseDir, "data/wechat-bridge"));
      expect(JSON.parse(await readFile(join(baseDir, "data/wechat-bridge", file!), "utf8")).cursor).toBe("11");
    });
    await target.stop();
    expect(host.presence).toHaveBeenCalledWith({ selfId: "wxid_self", online: true });
    // A first start begins at the newest event.
    expect(api.newestCursor).toHaveBeenCalledTimes(1);
    expect(api.events.mock.calls[0]![1]).toEqual({ after: "5" });
    expect(api.message.mock.calls.map((call) => call[1])).toEqual(["m_peer", "m_stranger", "m_group", "m_old"]);
    expect(received).toMatchObject([
      { id: "100", user: { id: "wxid_peer", name: "小明" }, channel: { id: "wxid_peer", direct: true }, parts: [text("hello")] },
      {
        id: "102",
        user: { id: "wxid_b", name: "群名片" },
        group: { id: "123@chatroom", name: "工作群" },
        channel: { id: "123@chatroom", direct: false },
        // A quote reply reaches Core as the message's quote.
        quote: { id: "100", user: { id: "wxid_peer" }, parts: [text("hello")] },
      },
    ]);
    expect(received[0]).not.toHaveProperty("quote");
    // Quotes of seen messages resolve without a lookup.
    expect(target.quotes.get("102")).toBe("m_group");
  });

  it("measures a message's age by the clock it was given", async () => {
    const events = [{ cursor: "6", kind: "message.committed", data: { messageId: "m_1", origin: "live", direction: "incoming" } }];
    const messages = { m_1: message({ id: "m_1", serverId: "300", createdAt: new Date(1_000_000).toISOString() }) };
    for (const [now, expected] of [
      [1_000_000 + 9 * 60_000, 1],
      [1_000_000 + 11 * 60_000, 0],
    ] as const) {
      const { host, api, baseDir } = await connection(events, messages);
      const target = new WechatConnection({ api: api as never, config, host, clock: manualClock(now), stateDirectory: join(baseDir, "data/wechat-bridge") });
      target.start();
      await vi.waitFor(() => expect(api.message).toHaveBeenCalled());
      await vi.waitFor(async () => expect((await readdir(join(baseDir, "data/wechat-bridge"))).length).toBe(1));
      await target.stop();
      expect(host.receive).toHaveBeenCalledTimes(expected);
    }
  });

  it("refuses to send outside the allowed chats or while logged out", async () => {
    const { target } = await connection([], {});
    await expect(target.send("wxid_stranger", [text("hi")])).rejects.toMatchObject({ code: "wechat_target_not_allowed" });
    await expect(target.send("wxid_peer", [text("hi")])).rejects.toMatchObject({ code: "wechat_not_logged_in" });
  });

  it("lists members only of an allowed group, and only while logged in", async () => {
    const { target } = await connection([], {});
    await expect(target.groupMembers("999@chatroom")).rejects.toMatchObject({ code: "wechat_target_not_allowed" });
    // An allowed direct contact is not a group.
    await expect(target.groupMembers("wxid_peer")).rejects.toMatchObject({ code: "wechat_target_not_allowed" });
    await expect(target.groupMembers("123@chatroom")).rejects.toMatchObject({ code: "wechat_not_logged_in" });
  });
});

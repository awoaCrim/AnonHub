import type { Part } from "koishi-plugin-yesimbot/kernel";
import { describe, expect, it } from "vitest";

// Expectations taken from the Koishi path on 2026-11-25 (spec 09: records and NapCat calls match what Koishi did,
// except that a file goes as a file segment of send_*_msg). The Koishi side is gone; the values below are fixed.
import type { Config } from "../src/config.js";
import type { InboundMessage } from "../src/connection.js";
import { WechatAccount } from "../src/connector.js";
import { inboundFromMessage } from "../src/records.js";

const SELF_ID = "wxid_self";
const text = (value: string): Part => ({ type: "text", text: value });

const config: Config = {
  allowedRooms: ["123@chatroom"],
  allowedPeers: ["wxid_peer"],
  autoReply: { direct: true, group: true },
  endpoint: "http://127.0.0.1:6174",
  tokenFile: "token",
  account: "bot",
};

/** Channel resources that keep the parts as given: media persistence is the kernel's `persistParts`. */
function resources() {
  return { persistParts: async (parts: readonly Part[]) => [...parts] } as never;
}

async function connectorInput(message: InboundMessage) {
  const inbound = inboundFromMessage(message, SELF_ID);
  if (!inbound) return undefined;
  return {
    context: inbound.context,
    selfId: inbound.selfId,
    routeId: inbound.routeId,
    record: JSON.parse(JSON.stringify(await inbound.translate(resources()))) as unknown,
  };
}

const parts: Part[] = [
  { type: "mention", userId: SELF_ID },
  text("看看这个"),
  text(""),
  { type: "image", src: "data:image/jpeg;base64,/9j/", summary: "[图片]" },
  { type: "file", src: "data:text/plain;base64,57qq6KaB", title: "会议.txt" },
  { type: "file", title: "报告.pdf", failure: "download_failed" },
  text("[语音消息]\n[语音尚未转写]"),
];

const group = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  id: "1234567890123456789",
  timestamp: 1_700_000_000_000,
  user: { id: "wxid_b", name: "群名片" },
  group: { id: "123@chatroom", name: "工作群" },
  channel: { id: "123@chatroom", direct: false, name: "工作群" },
  parts,
  quote: { id: "42", user: { id: "wxid_peer", name: "小明" }, parts: [text("开会吗"), { type: "image", src: "data:image/png;base64,iVBO" }] },
  ...overrides,
});

describe("WeChat input: what Core is handed", () => {
  it("a group message with a mention, pictures, files and a quote", async () => {
    expect(await connectorInput(group())).toEqual({
      context: { type: "guild", platform: "wechat-bridge", channelId: "123@chatroom", guildId: "123@chatroom", selfId: SELF_ID },
      selfId: SELF_ID,
      routeId: "1234567890123456789",
      record: {
        platform: "wechat-bridge",
        selfId: SELF_ID,
        timestamp: 1_700_000_000_000,
        channel: { id: "123@chatroom", type: 0, name: "工作群" },
        user: { id: "wxid_b", name: "群名片" },
        messageId: "1234567890123456789",
        parts,
        quote: { messageId: "42", parts: [text("开会吗"), { type: "image", src: "data:image/png;base64,iVBO" }], author: { id: "wxid_peer" } },
      },
    });
  });

  it("without names: no channel or user name, and a quote without its author", async () => {
    expect(
      await connectorInput(
        group({
          user: { id: "wxid_b" },
          group: { id: "123@chatroom" },
          channel: { id: "123@chatroom", direct: false },
          quote: { id: "42", parts: [text("x")] },
        }),
      ),
    ).toEqual({
      context: { type: "guild", platform: "wechat-bridge", channelId: "123@chatroom", guildId: "123@chatroom", selfId: SELF_ID },
      selfId: SELF_ID,
      routeId: "1234567890123456789",
      record: {
        platform: "wechat-bridge",
        selfId: SELF_ID,
        timestamp: 1_700_000_000_000,
        channel: { id: "123@chatroom", type: 0 },
        user: { id: "wxid_b" },
        messageId: "1234567890123456789",
        parts,
        quote: { messageId: "42", parts: [text("x")] },
      },
    });
  });

  it("a direct message names the conversation by the contact's name, else the wxid", async () => {
    const direct = { group: undefined, channel: { id: "wxid_peer", direct: true }, quote: undefined };
    expect(await connectorInput(group({ ...direct, user: { id: "wxid_peer", name: "小明" } }))).toEqual({
      context: { type: "direct", platform: "wechat-bridge", channelId: "wxid_peer", selfId: SELF_ID, userId: "wxid_peer", userName: "小明" },
      selfId: SELF_ID,
      routeId: "1234567890123456789",
      record: {
        platform: "wechat-bridge",
        selfId: SELF_ID,
        timestamp: 1_700_000_000_000,
        channel: { id: "wxid_peer", type: 1 },
        user: { id: "wxid_peer", name: "小明" },
        messageId: "1234567890123456789",
        parts,
      },
    });
    expect(await connectorInput(group({ ...direct, user: { id: "wxid_peer" } }))).toEqual({
      context: { type: "direct", platform: "wechat-bridge", channelId: "wxid_peer", selfId: SELF_ID, userId: "wxid_peer", userName: "wxid_peer" },
      selfId: SELF_ID,
      routeId: "1234567890123456789",
      record: {
        platform: "wechat-bridge",
        selfId: SELF_ID,
        timestamp: 1_700_000_000_000,
        channel: { id: "wxid_peer", type: 1 },
        user: { id: "wxid_peer" },
        messageId: "1234567890123456789",
        parts,
      },
    });
  });
});

describe("WeChat output: the parts the connection is handed", () => {
  it("every kind of part Core sends arrives unchanged", async () => {
    const outgoing: Part[] = [
      { type: "quote", messageId: "42", parts: [] },
      { type: "mention", userId: "wxid_peer", name: "小明" },
      { type: "mention", scope: "all" },
      text("你好"),
      text(""),
      { type: "image", src: "data:image/png;base64,iVBO", title: "图.png", subtype: 0, summary: "[图片]" },
      { type: "file", src: "data:application/pdf;base64,JVBE", title: "报告.pdf" },
      { type: "video", src: "https://example.com/v.mp4" },
      { type: "platform", tag: "p", attrs: {}, parts: [text("段落")] },
      { type: "platform", tag: "face", attrs: { id: "14", sub_type: 1, name: null }, parts: [text("[微笑]")] },
    ];
    const sent: Part[][] = [];
    await new WechatAccount(config, async (_channel, parts) => (sent.push(parts), ["1"])).sendMessage("wxid_peer", outgoing);
    // The face's null `name` attribute is dropped, as the Koishi path's round trip through Satori elements dropped it.
    expect(sent).toEqual([
      [
        { type: "quote", messageId: "42", parts: [] },
        { type: "mention", userId: "wxid_peer", name: "小明" },
        { type: "mention", scope: "all" },
        text("你好"),
        text(""),
        { type: "image", src: "data:image/png;base64,iVBO", title: "图.png", subtype: 0, summary: "[图片]" },
        { type: "file", src: "data:application/pdf;base64,JVBE", title: "报告.pdf" },
        { type: "video", src: "https://example.com/v.mp4" },
        { type: "platform", tag: "p", attrs: {}, parts: [text("段落")] },
        { type: "platform", tag: "face", attrs: { id: "14", sub_type: 1 }, parts: [text("[微笑]")] },
      ],
    ]);
  });
});

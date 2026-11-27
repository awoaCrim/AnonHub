import { expect, it } from "vitest";

import { conversationName } from "../web/src/lib/conversation-names";
import { previewNote, senderName } from "../web/src/lib/talk";
import type { ConversationChannelSummary } from "../web/src/state/history-types";

const channel = (patch: Partial<ConversationChannelSummary>): ConversationChannelSummary => ({
  key: "k",
  type: "guild",
  platform: "onebot",
  channelId: "1",
  createdAt: "",
  activeSession: null,
  sessions: [],
  totalSizeBytes: 0,
  lastActivityAt: 1,
  ...patch,
});

// User, 2026-11-17: 「会话管理页面优化一下」.
it("shows the latest message under a conversation's name, and who said it in a group", () => {
  expect(previewNote(channel({}))).toBe("群聊");
  expect(previewNote(channel({ type: "direct" }))).toBe("私聊");
  expect(previewNote(channel({ preview: { text: "早上好", sender: "阿杰 (20001)", fromBot: false, at: 1 } }))).toBe("阿杰：早上好");
  expect(previewNote(channel({ type: "direct", preview: { text: "在吗", sender: "小雨", fromBot: false, at: 1 } }))).toBe("在吗");
  expect(previewNote(channel({ type: "direct", preview: { text: "记一下", sender: "你", fromBot: false, at: 1 } }))).toBe("你：记一下");
  expect(previewNote(channel({ preview: { text: "好的", fromBot: true, at: 1 } }))).toBe("我：好的");
});

it("names people without their number, and a direct chat by the other side when no contact list knows them", () => {
  expect(senderName("老周 (20003)")).toBe("老周");
  expect(senderName("Lin")).toBe("Lin");
  expect(senderName(undefined)).toBe("对方");
  const wechat = channel({ type: "direct", platform: "wechat-bridge", channelId: "wxid_a", userId: "wxid_a", peerName: "王老师" });
  expect(conversationName(wechat)).toBe("王老师");
  expect(conversationName({ ...wechat, peerName: undefined })).toBe("wxid_a");
  // A group is never named after whoever spoke last.
  expect(conversationName(channel({ guildId: "100200300", peerName: "阿杰" }))).toBe("100200300");
});

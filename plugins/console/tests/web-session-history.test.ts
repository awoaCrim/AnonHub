import { expect, it } from "vitest";

import type { ConversationChannelSummary } from "../src/conversation-history";
import { parseWebHistoryTarget, talkGroups, webHistoryGroups, webHistoryTarget, webSessionView } from "../web/src/lib/talk";

const old = "20261107T174937Z.jsonl";
const current = "20261112T114230Z.jsonl";
const channel: ConversationChannelSummary = {
  key: "direct-web-owner%2e%e5bb7476-bot",
  platform: "web",
  type: "direct",
  channelId: "owner",
  selfId: "bot",
  createdAt: "2026-11-07",
  activeSession: current,
  totalSizeBytes: 30,
  lastActivityAt: 2,
  sessions: [
    { filename: old, isActive: false, size: 10, createdAt: "2026-11-07", lastActivityAt: 1 },
    { filename: current, isActive: true, size: 20, createdAt: "2026-11-12", lastActivityAt: 2 },
  ],
};
it("lists actual web sessions separately and preserves escaped channel names", () => {
  const groups = webHistoryGroups([channel], () => "网页对话");
  expect(groups.map((group) => [group.id, group.items.length])).toEqual([
    ["web", 1],
    ["web-archive", 1],
  ]);
  expect(parseWebHistoryTarget(groups[1].items[0].value)).toEqual({ channel: channel.key, session: old });
  expect(webHistoryTarget(channel.key, current)).not.toBe(webHistoryTarget(channel.key, old));
  expect(parseWebHistoryTarget("web-history:%bad")).toBeUndefined();
});
it("moves an archived session out of the current list without showing its empty replacement", () => {
  const next = "20261112T120000Z.jsonl";
  const updated = {
    ...channel,
    activeSession: next,
    sessions: [
      ...channel.sessions.map((s) => ({ ...s, isActive: false })),
      { filename: next, isActive: true, size: 0, createdAt: "2026-11-12", lastActivityAt: 3 },
    ],
  };
  const groups = webHistoryGroups([updated], () => "网页对话");
  expect(groups.map((group) => [group.id, group.items.length])).toEqual([["web-archive", 2]]);
  expect(channel.sessions).toHaveLength(2);
});
// User, 2026-11-20: every row read 「网页对话 · 你好」, the conversation's first message, so none could be told apart.
it("names each web session by its own latest message, keeps the 网 avatar, and falls back to the conversation's title", () => {
  const named = {
    ...channel,
    sessions: [{ ...channel.sessions[0]!, preview: { text: "法国机掉线了", sender: "主人", fromBot: false, at: 1 } }, channel.sessions[1]!],
  };
  const [current, archived] = webHistoryGroups([named], () => "网页对话 · 你好");
  expect(archived!.items[0]).toMatchObject({ label: "法国机掉线了", avatar: "网" });
  expect(archived!.items[0]!.note).toMatch(/^已归档 · /);
  // No preview yet: the conversation's title, without the 网页对话 prefix the group header already says.
  expect(current!.items[0]).toMatchObject({ label: "你好", avatar: "网" });
  expect(current!.items[0]!.note).toMatch(/^当前会话 · /);
  // The first conversation has no title of its own.
  expect(webHistoryGroups([channel], () => "网页对话")[0]!.items[0]!.label).toBe("网页对话");
  // Search finds a session by its message, and every session of a conversation by the conversation's name.
  expect(webHistoryGroups([named], () => "网页对话 · 你好", "法国").flatMap((group) => group.items.map((item) => item.label))).toEqual(["法国机掉线了"]);
  expect(webHistoryGroups([named], () => "网页对话 · 你好", "网页对话").flatMap((group) => group.items)).toHaveLength(2);
  // Other rows keep their own first letter.
  const chats = talkGroups({ web: [], channels: [{ ...channel, key: "qq", platform: "onebot", type: "guild" }], name: () => "神秘学研究所" });
  expect(chats.flatMap((group) => group.items).every((item) => item.avatar === undefined)).toBe(true);
});
it("shows only the selected web session and does not offer archive on an old one", () => {
  expect(webSessionView(channel).sessions.map((s) => s.filename)).toEqual([current]);
  const history = webSessionView(channel, old);
  expect(history.sessions.map((s) => s.filename)).toEqual([old]);
  expect(history.activeSession).toBeNull();
  expect(webSessionView(channel, "missing.jsonl").sessions).toEqual([]);
  expect(webHistoryGroups([channel], () => "网页对话", "missing")).toEqual([]);
});

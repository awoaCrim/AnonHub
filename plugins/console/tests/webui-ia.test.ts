import { expect, it } from "vitest";

import { historyReturnTo } from "../web/src/lib/history-navigation";
import { recentConversations } from "../web/src/pages/overview-model";
import type { ConversationChannelSummary, ConversationIndex } from "../web/src/state/history-types";

it("accepts current and previous history lists as detail return targets", () => {
  const qq = { aliases: ["/conversations"] };
  expect(historyReturnTo("/history?q=1", "/history", qq)).toBe("/history?q=1");
  // Old links redirect to the current list, so they remain a safe return target.
  expect(historyReturnTo("/conversations?page=2", "/history", qq)).toBe("/conversations?page=2");
  for (const unsafe of ["/xiaoheihe?q=1", "//evil.example/history", "/history/abc", "/history?x=1#bad", "/historyx", ["/history"]])
    expect(historyReturnTo(unsafe, "/history", qq)).toBe("/history");

  const xiaoheihe = { aliases: ["/xiaoheihe"], query: { platform: "xiaoheihe" } };
  expect(historyReturnTo(undefined, "/history", xiaoheihe)).toBe("/history?platform=xiaoheihe");
  expect(historyReturnTo("/conversations", "/history", xiaoheihe)).toBe("/history?platform=xiaoheihe");
  expect(historyReturnTo("/xiaoheihe?source=3", "/history", xiaoheihe)).toBe("/xiaoheihe?source=3");
});

it("lists the most recent conversations linked to their newest session", () => {
  const channel = (key: string, lastActivityAt: number | null, sessions: string[], extra: Partial<ConversationChannelSummary> = {}) =>
    ({
      key,
      type: "guild",
      platform: "onebot",
      channelId: key,
      guildId: `g-${key}`,
      createdAt: "",
      activeSession: null,
      sessions: sessions.map((filename) => ({ filename, isActive: false, size: 1, createdAt: "", lastActivityAt: 0 })),
      totalSizeBytes: 0,
      lastActivityAt,
      ...extra,
    }) as ConversationChannelSummary;
  const index = {
    channels: [
      channel("a", 10, ["20261001T000000Z.jsonl", "20261003T000000Z.jsonl"]),
      channel("b", 30, ["20261002T000000Z.jsonl"], { type: "direct", userId: "42" }),
      channel("c", null, ["x.jsonl"]),
      channel("d", 20, []),
      channel("e/1", 5, ["s.jsonl"]),
    ],
  } as ConversationIndex;
  expect(recentConversations(index)).toEqual([
    { key: "b", label: "42", platform: "QQ", type: "direct", lastActivityAt: 30, to: "/history/b/20261002T000000Z.jsonl" },
    { key: "a", label: "g-a", platform: "QQ", type: "guild", lastActivityAt: 10, to: "/history/a/20261003T000000Z.jsonl" },
    { key: "e/1", label: "g-e/1", platform: "QQ", type: "guild", lastActivityAt: 5, to: "/history/e%2F1/s.jsonl" },
  ]);
  expect(recentConversations(index, 1)).toHaveLength(1);
  expect(recentConversations(undefined)).toEqual([]);
});

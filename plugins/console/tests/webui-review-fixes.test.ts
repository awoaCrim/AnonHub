import { expect, it } from "vitest";

import { isCapability } from "../web/src/lib/capabilities";
import { conversationName } from "../web/src/lib/conversation-names";
import { platformSummary } from "../web/src/pages/platforms-model";
import type { ConversationChannelSummary } from "../web/src/state/history-types";

it("counts chat platforms and excludes dedicated pages from capabilities", () => {
  expect(platformSummary([{ id: "wechat-bridge", label: "微信", state: "online" }] as never)).toEqual({ tone: "ok", label: "微信 在线" });
  expect(isCapability("yesimbot-memorizer")).toBe(true);
  // Xiaoheihe is an ordinary extension now, listed with the other capabilities.
  expect(isCapability("yesimbot-xiaoheihe")).toBe(true);
  for (const name of ["yesimbot", "yesimbot-roleplay", "yesimbot-model-provider", "adapter-onebot"]) expect(isCapability(name)).toBe(false);
});
it("resolves names only within the matching bot and chat type without rewriting source IDs", () => {
  const source = { platform: "onebot", selfId: "bot", type: "direct", channelId: "private:42", userId: "42" } as ConversationChannelSummary;
  const contacts = {
    bots: [
      { platform: "onebot", selfId: "other", name: "", partial: false, contacts: [{ channelId: "private:42", direct: true, name: "Wrong bot" }] },
      {
        platform: "onebot",
        selfId: "bot",
        name: "",
        partial: false,
        contacts: [
          { channelId: "42", direct: false, name: "Group" },
          { channelId: "private:42", direct: true, name: "Crimson" },
        ],
      },
    ],
  };
  expect(conversationName(source, contacts)).toBe("Crimson");
  expect(conversationName({ ...source, channelId: "42" }, contacts)).toBe("Crimson");
  expect(conversationName({ ...source, selfId: undefined }, contacts)).toBe("42");
  expect(conversationName(source)).toBe("42");
  expect(source.channelId).toBe("private:42");
});
import { readableTimeline, withoutDeliveredSends } from "../web/src/lib/conversation-replies";
import { dailySeries } from "../web/src/pages/usage-model";
it.each([true, false, undefined])("projects full-page sends without hiding traces or inventing delivery: %s", (ok) => {
  const entries = [
    {
      id: "call",
      kind: "tool-call" as const,
      toolName: "send_message",
      toolCallId: "send",
      timestamp: 1,
      args: {
        parts: [
          { kind: "text", text: "第一段" },
          { kind: "text", text: "第二段" },
        ],
      },
    },
    { id: "result", kind: "tool-result" as const, toolCallId: "send", timestamp: 2, result: { type: "json", value: { ok, count: 2 } } },
    { id: "assistant", kind: "assistant" as const, timestamp: 3, text: "第一段\n第二段" },
  ];
  const timeline = readableTimeline(entries);
  expect(timeline.map((entry) => entry.kind)).toEqual(["assistant", "tool-call", "tool-result"]);
  // The conversation panel reads a delivered send as just its bubble (user, 2026-11-17); a failed or unknown one keeps its rows.
  expect(withoutDeliveredSends(timeline).map((entry) => entry.kind)).toEqual(ok === true ? ["assistant"] : ["assistant", "tool-call", "tool-result"]);
  expect(timeline[0]).toMatchObject({ text: "第一段\n第二段", delivery: ok === true ? "已发送" : ok === false ? "发送失败" : "发送结果未知" });
  expect(new Set(timeline.map((entry) => entry.id)).size).toBe(timeline.length);
});
it("labels daily usage with the server's date numbers instead of the browser's current day", () => {
  expect(dailySeries({ recent: [{ date: Date.UTC(2026, 10, 4) / 86400000, cacheReadTokens: 1, noCacheTokens: 2, outputTokens: 3 }] } as never).labels).toEqual([
    "11/4",
  ]);
});

import { partsFromElements } from "@yesimbot/contracts/parts";
import { describe, expect, it } from "vitest";

import { compactSourceTimestamp, formatCompactTimestamp, renderCompressionRecords } from "../src/conversations/compact.js";

const conversation = [
  {
    type: "message",
    id: "e1",
    timestamp: 1,
    data: {
      role: "custom",
      type: "yesimbot.message",
      timestamp: 1,
      data: {
        user: { id: "user-1", name: "time killer" },
        parts: partsFromElements([{ type: "text", attrs: { content: "明天陪我去逛街嘛" } }]),
      },
    },
  },
  {
    type: "message",
    id: "e2",
    timestamp: 2,
    data: {
      role: "assistant",
      timestamp: 2,
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "send_message",
          input: {
            messages: ["好啊！说好了一早就来！", "逛街买衣服都可以"],
            inner_thought: "上一句已经答应了，先别答应第二遍。",
          },
        },
      ],
    },
  },
  {
    type: "message",
    id: "e3",
    timestamp: 3,
    data: {
      role: "tool",
      timestamp: 3,
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "send_message", output: { type: "json", value: { ok: true, messageIds: ["m1"] } } }],
    },
  },
  {
    type: "message",
    id: "e4",
    timestamp: 4,
    data: { role: "assistant", timestamp: 4, content: [{ type: "tool-call", toolCallId: "c2", toolName: "finish", input: { reason: "没什么想说的" } }] },
  },
] as never;

function rendered(entries: readonly never[]): string[] {
  return entries.flatMap((entry) =>
    renderCompressionRecords(entry).map((record) => `[${formatCompactTimestamp(record.timestamp)}] ${record.role}: ${record.text}`),
  );
}

describe("history source records", () => {
  it("keeps the character's own outgoing messages so commitments survive summarizing", () => {
    const records = (conversation as readonly never[]).flatMap((entry) => renderCompressionRecords(entry));
    expect(records.find((record) => record.role === "user")).toMatchObject({ speaker: "time killer", text: "明天陪我去逛街嘛" });
    expect(records.filter((record) => record.role === "assistant").map((record) => record.text)).toContain("好啊！说好了一早就来！\n逛街买衣服都可以");
  });

  it("excludes inner thoughts, silent turns and tool receipts", () => {
    const text = rendered(conversation as never).join("\n");
    expect(text).not.toContain("先别答应第二遍");
    expect(text).not.toContain("没什么想说的");
    expect(text).not.toContain("messageIds");
  });

  it("anchors every record with its Asia/Shanghai source date and minute", () => {
    expect(rendered(conversation as never)[0]).toBe(`[${formatCompactTimestamp(1)}] user: 明天陪我去逛街嘛`);
  });

  it("prefers the message source timestamp over its later JSONL append time", () => {
    const sourceTime = Date.parse("2026-09-24T16:30:00Z");
    const appendedAt = Date.parse("2026-09-24T17:35:00Z");
    const entry = timedEntry("delayed", sourceTime, "导入的旧消息", appendedAt);
    expect(compactSourceTimestamp(entry)).toBe(sourceTime);
    expect(rendered([entry])).toEqual([`[${formatCompactTimestamp(sourceTime)}] user: 导入的旧消息`]);
  });
});

describe("source timestamp format", () => {
  it("renders the Shanghai wall clock regardless of the host timezone", () => {
    // 2026-09-24T16:30:00Z is 2026-09-25 00:30 in Shanghai: the day boundary must move forward.
    expect(formatCompactTimestamp(Date.parse("2026-09-24T16:30:00Z"))).toBe("2026-09-25 周五 00:30（UTC+8）");
  });

  it("keeps late-evening and next-morning messages on their own dates", () => {
    const late = Date.parse("2026-09-24T15:50:00Z"); // 23:50 Shanghai
    const early = Date.parse("2026-09-24T17:10:00Z"); // 01:10 Shanghai next day
    expect(rendered([timedEntry("late", late, "晚安"), timedEntry("early", early, "早安")])).toEqual([
      "[2026-09-24 周四 23:50（UTC+8）] user: 晚安",
      "[2026-09-25 周五 01:10（UTC+8）] user: 早安",
    ]);
  });

  it("uses h23 so midnight is 00:00 instead of 24:00", () => {
    expect(formatCompactTimestamp(Date.parse("2026-09-24T16:00:00Z"))).toBe("2026-09-25 周五 00:00（UTC+8）");
  });
});

function timedEntry(id: string, timestamp: number, text: string, appendedAt = timestamp) {
  return {
    type: "message",
    id,
    timestamp: appendedAt,
    data: {
      role: "custom",
      type: "yesimbot.message",
      timestamp,
      data: { user: { id: "user-1", name: "user" }, parts: partsFromElements([{ type: "text", attrs: { content: text } }]) },
    },
  } as never;
}

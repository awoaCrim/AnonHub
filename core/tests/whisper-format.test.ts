import { partsFromElements } from "@yesimbot/contracts/parts";
import { describe, expect, it } from "vitest";

import { createMessage, formatCurrentInput, formatInput, isWhisper, WHISPER_SENDER, type MessageRecord } from "../src/messages/index.js";
import { h } from "./helpers/index.js";

const record = (extra: Partial<MessageRecord> = {}): MessageRecord => ({
  platform: "onebot",
  selfId: "bot",
  channel: { id: "room", type: 0 },
  user: { id: "owner", name: "主人" },
  timestamp: Date.UTC(2026, 10, 7, 12),
  messageId: "whisper-1",
  parts: partsFromElements([h.text("少说点游戏的事")]),
  ...extra,
});

describe("private word rendering", () => {
  it("tells the model the account holder said it privately, in history and as the current input", () => {
    const whisper = createMessage(record({ whisper: true }));
    expect(isWhisper(whisper)).toBe(true);
    const history = formatInput(whisper).content as string;
    expect(history).toContain(`sender=${JSON.stringify(WHISPER_SENDER)}`);
    expect(history).toContain("少说点游戏的事");
    expect(formatCurrentInput(whisper).content as string).toContain(WHISPER_SENDER);
  });

  it("leaves an ordinary message with the same user untouched", () => {
    const ordinary = createMessage(record());
    expect(isWhisper(ordinary)).toBe(false);
    expect(formatInput(ordinary).content as string).toContain(`sender=${JSON.stringify("主人 (owner)")}`);
  });
});

import { AppError, configureLogging, type LogRecord } from "@yesimbot/foundation";
import { describe, expect, it } from "vitest";

import { conversationLogger } from "../src/runtimes/log.js";

describe("conversation logger", () => {
  it("writes the conversation and turn as log context and an error as its fields", () => {
    const records: LogRecord[] = [];
    configureLogging({ sink: (record) => records.push(record) });
    const log = conversationLogger("yesimbot.channel-runtime", "onebot:room");
    log.warn("runtime.turn.consume_failed", { turnId: "turn-1", cause: new AppError("internal_error", { detail: "token sk-abcdefghijklmnopqrstuvwx" }) });
    log.warn("runtime.step_limit", { channel: "ignored", steps: 40 });
    expect(records[0]).toMatchObject({
      scope: "yesimbot.channel-runtime",
      event: "runtime.turn.consume_failed",
      channel: "onebot:room",
      turnId: "turn-1",
      code: "internal_error",
    });
    expect(records[0]).not.toHaveProperty("cause");
    expect(records[0]).not.toHaveProperty("field_turnId");
    expect(JSON.stringify(records[0])).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(records[1]).toMatchObject({ channel: "onebot:room", steps: 40 });
    expect(records[1]).not.toHaveProperty("turnId");
  });
});

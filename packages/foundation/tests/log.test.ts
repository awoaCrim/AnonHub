import { afterEach, describe, expect, it } from "vitest";

import { AppError, configureLogging, logger, withLogContext, type LogRecord } from "../src/index.js";

const records: LogRecord[] = [];
configureLogging({ level: "info", sink: (record) => records.push(record) });

afterEach(() => {
  records.length = 0;
  configureLogging({ level: "info" });
});

describe("logger", () => {
  it("writes the scope, a dotted event, fields and the async context", async () => {
    await withLogContext({ channel: "shared-onebot-1", turnId: "t1" }, async () => {
      await Promise.resolve();
      await withLogContext({ requestId: "r1" }, async () => logger("core.channel").info("turn.started", { messages: 2 }));
    });
    logger("core.channel").info("turn.idle");
    expect(records[0]).toMatchObject({
      level: "info",
      scope: "core.channel",
      event: "turn.started",
      channel: "shared-onebot-1",
      turnId: "t1",
      requestId: "r1",
      messages: 2,
    });
    expect(records[0]!.time).toMatch(/Z$/);
    expect(records[1]).not.toHaveProperty("channel");
  });

  it("redacts strings, turns errors into error fields and keeps reserved names", () => {
    const error = new AppError("network_failed", { cause: new Error("GET https://x.example/a?token=abc failed") });
    logger("mcp").warn("server.failed", { url: "https://x.example/mcp?token=abc", key: "sk-abcdefghijkl", error, channel: "spoofed" });
    const text = JSON.stringify(records[0]);
    expect(text).not.toContain("token=abc");
    expect(text).not.toContain("sk-abcdefghijkl");
    expect(records[0]).toMatchObject({ error: { name: "AppError", message: "network_failed" }, field_channel: "spoofed" });
  });

  it("skips debug by default and logs malformed event names instead of throwing", () => {
    logger("x").debug("detail.shown");
    expect(records).toHaveLength(0);
    configureLogging({ level: "debug" });
    logger("x").debug("detail.shown");
    logger("x").warn("没有点的中文句子");
    expect(records.map((record) => record.event)).toEqual(["detail.shown", "log.malformed_event"]);
    expect(records[1]).toMatchObject({ malformedEvent: "没有点的中文句子" });
    expect(() => logger("Bad Scope")).toThrow();
  });
});

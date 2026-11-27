import { createEntry, type AgentEntry } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { describe, expect, it, vi } from "vitest";

import type { ContextBlockDescriptor } from "../src/conversations/context-blocks.js";
import { createMessage, type MessageRecord } from "../src/messages/index.js";
import { createModelInputPlugin, findQuotedHistory, type QuotedMessageLocator } from "../src/runtimes/model-input.js";
import { h } from "./helpers/index.js";

const record = (messageId: string, timestamp: number, text: string, quote?: MessageRecord["quote"]): MessageRecord => ({
  platform: "onebot",
  selfId: "10000",
  timestamp,
  channel: { id: "216", type: 0 },
  user: { id: "30000", name: "Alice" },
  messageId,
  parts: partsFromElements([h.text(text)]),
  ...(quote ? { quote } : {}),
});

// 2026-11-16 20:30 and 2026-11-17 01:14 Beijing time.
const OLD = Date.UTC(2026, 10, 16, 12, 30);
const NOW = Date.UTC(2026, 10, 16, 17, 14);

function scene() {
  const original = createMessage(record("m-2030", OLD, "转发的图"));
  const quoting = createMessage(
    record("m-0114", NOW, "啥是一扣四", { messageId: "m-2030", parts: partsFromElements([h.text("转发的图")]), author: { id: "40000" } }),
  );
  const entries: AgentEntry[] = [
    createEntry("message", createMessage(record("m-2000", OLD - 60_000, "前一条")), { id: "entry-2000" }),
    createEntry("message", original, { id: "entry-2030" }),
    createEntry("message", createMessage({ ...record("m-2030", OLD, "别的群同号消息"), channel: { id: "other", type: 0 } }), {
      id: "entry-other",
    }),
  ];
  const locator =
    (kind: ContextBlockDescriptor["kind"]): QuotedMessageLocator =>
    async (match) => {
      const entry = entries.find(match);
      return entry && { block: { id: kind === "raw" ? "raw_1" : "block-1", kind, sourceState: "raw" }, entry };
    };
  return { original, quoting, locator };
}

describe("quoted messages found in this conversation's history", () => {
  it("gives the original time and the summarized block that holds the quoted message", async () => {
    const { original, quoting, locator } = scene();
    expect(await findQuotedHistory(quoting, { history: [] }, locator("context-region"))).toEqual({ timestamp: OLD, blockId: "block-1" });
    expect(await findQuotedHistory(quoting, { history: [] }, locator("compact"))).toEqual({ timestamp: OLD, blockId: "block-1" });
    // Still raw in the window: the time alone.
    expect(await findQuotedHistory(quoting, { history: [] }, locator("raw"))).toEqual({ timestamp: OLD });
    // Without history blocks, or when locating fails, the live history still gives the time.
    expect(await findQuotedHistory(quoting, { history: [original] })).toEqual({ timestamp: OLD });
    expect(
      await findQuotedHistory(quoting, { history: [original] }, async () => {
        throw new Error("io");
      }),
    ).toEqual({ timestamp: OLD });
    // Not in this conversation, or another channel's message with the same id: nothing is claimed.
    expect(await findQuotedHistory(quoting, { history: [] }, async () => undefined)).toBeUndefined();
    const elsewhere = createMessage({ ...record("m-2030", OLD, "x"), channel: { id: "other", type: 0 } });
    expect(await findQuotedHistory(quoting, { history: [elsewhere] })).toBeUndefined();
  });

  it("annotates only the current input's quote; the same message in history keeps its exact text", async () => {
    const { original, quoting, locator } = scene();
    const lookup = vi.fn((message: typeof quoting, context: Parameters<typeof findQuotedHistory>[1]) =>
      findQuotedHistory(message, context, locator("context-region")),
    );
    const plugin = createModelInputPlugin("default", false, undefined, lookup);
    const context = { history: [original, quoting], current: [quoting] } as never;
    const [current] = (await plugin.toModelMessages!(quoting, context)) as { content: string }[];
    expect(current!.content).toContain('[QUOTED_MESSAGE id="m-2030" sender="40000" time="2026-11-16 周一 20:30（UTC+8）" history_block="block-1"]');
    await plugin.toModelMessages!(quoting, context);
    expect(lookup).toHaveBeenCalledTimes(1); // Once per current input across steps.
    const later = { history: [original, quoting], current: [] } as never;
    const [past] = (await plugin.toModelMessages!(quoting, later)) as { content: string }[];
    expect(past!.content).toContain('[QUOTED_MESSAGE id="m-2030" sender="40000"]');
    expect(past!.content).not.toContain("history_block");
  });
});

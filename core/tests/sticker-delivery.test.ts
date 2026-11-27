import { createAgent, createUserMessage, type Agent } from "@yesimbot/agent-runtime";
import type { Part } from "@yesimbot/contracts/parts";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { BotStickerSender } from "../../plugins/sticker-manager/src/sender.js";
import { createDeps, scope, stickerId, pngBytes } from "../../plugins/sticker-manager/tests/preview-fixtures.js";
import type { ChatAccount } from "../src/accounts.js";
import { createReplyTools } from "../src/agents/reply-tools.js";
import { createFinishTool } from "../src/agents/tools.js";
import { beginReplyJournal } from "../src/conversations/reply-journal.js";
import { partView } from "../src/messages/parts.js";

type Call = { toolName: string; input: Record<string, unknown> };
const preview: Call = { toolName: "sticker_preview", input: { sticker_id: stickerId } };
const sticker = (continued = false): Call => ({ toolName: "sticker_send", input: { sticker_id: stickerId, continue: continued } });
const text = (_continued = false, texts = ["hello"]): Call => ({
  toolName: "send_message",
  input: { parts: texts.map((text) => ({ kind: "text", text })), mode: "raw" },
});

function scriptedModel(steps: readonly (Call | Call[])[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      const step = steps[index];
      if (!step) throw new Error("unexpected model step");
      const stepId = index++;
      const calls = Array.isArray(step) ? step : [step];
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          ...calls.flatMap((call, i) => {
            const id = `call-${stepId}-${i}`;
            const input = JSON.stringify(call.input);
            return [
              { type: "tool-input-start" as const, id, toolName: call.toolName },
              { type: "tool-input-delta" as const, id, delta: input },
              { type: "tool-input-end" as const, id },
              { type: "tool-call" as const, toolCallId: id, toolName: call.toolName, input },
            ];
          }),
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
}

async function run(steps: readonly (Call | Call[])[], mode: "native" | "vision" | "unavailable" = "native") {
  const deps = createDeps({}, mode);
  const sendMessage = vi.fn(async (_channel: string, _elements: unknown) => ["message-id"]);
  const bot = { platform: "test", sendMessage } as unknown as ChatAccount;
  const sender = new BotStickerSender(bot, scope);
  deps.sender.sendWithProof.mockImplementation(sender.sendWithProof.bind(sender) as never);
  let agent!: Agent;
  let invocations = 0;
  const reply = createReplyTools({
    bot,
    channelId: scope.channelId,
    resources: {} as never,
    pacing: { charactersPerSecond: 1000, maxTotalDelayMs: 0 },
    innerThought: false,
    journal: {
      begin: (input) =>
        beginReplyJournal({
          ...input,
          invocationId: `invocation-${++invocations}`,
          sessionId: "session",
          generation: 1,
          sink: { append: (entry) => agent.storage.append(entry).then(() => {}) },
        }),
    },
  });
  const textTool = reply.tools[0]!;
  const model = scriptedModel([...steps, { toolName: "finish", input: {} }]);
  agent = createAgent({ model, tools: [textTool, deps.preview, ...deps.tools, createFinishTool()], requireTerminalTool: true });
  const events: string[] = [];
  try {
    for await (const event of agent.run(createUserMessage("hello"))) events.push(event.type);
    await agent.wait();
    return {
      model,
      events,
      kinds: sendMessage.mock.calls.map(([, parts]) => (parts as Part[]).map((part) => partView(part).type)),
      entries: await agent.storage.read(),
      sendMessage,
      deps,
      textTool,
    };
  } finally {
    await agent.stop();
    deps.projection.clearAll();
    deps.gate.clear();
    deps.slot.clear();
  }
}

describe("Core and Sticker viewed delivery", () => {
  it.each([
    { name: "sticker only", steps: [sticker()], expected: [["img"]] },
    { name: "text only", steps: [text()], expected: [["text"]] },
    { name: "sticker then text", steps: [sticker(true), text()], expected: [["img"], ["text"]] },
    { name: "text then sticker", steps: [text(true), sticker()], expected: [["text"], ["img"]] },
    { name: "text sticker text", steps: [text(true), sticker(true), text()], expected: [["text"], ["img"], ["text"]] },
  ])("supports $name without inserting other output", async ({ steps, expected }) => {
    const result = await run(steps);
    expect(result.events).toContain("turn.done");
    expect(result.events).not.toContain("turn.failed");
    expect(result.kinds).toEqual(expected);
    expect(result.model.doStreamCalls).toHaveLength(steps.length + ((steps.at(-1) as Call)?.toolName === "send_message" ? 1 : 0));
    expect(JSON.stringify(result.entries)).not.toContain(Buffer.from(pngBytes).toString("base64"));
    if (expected.some((parts) => parts.includes("img"))) expect(result.deps.store.markUsed).toHaveBeenCalledOnce();
  });

  it("puts actual native preview bytes in the next request, but not durable history", async () => {
    const result = await run([preview, sticker()]);
    expect(JSON.stringify(result.model.doStreamCalls[1])).toContain('"type":"image-data"');
    expect(JSON.stringify(result.model.doStreamCalls[1])).toContain(Buffer.from(pngBytes).toString("base64"));
    expect(result.kinds).toEqual([["img"]]);
    expect(JSON.stringify(result.entries)).not.toContain('"type":"image-data"');
  });

  it("uses shared vision evidence without native image output", async () => {
    const result = await run([preview, sticker()], "vision");
    expect(result.kinds).toEqual([["img"]]);
    expect(result.deps.capability.describe).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.model.doStreamCalls[1])).toContain("红色与蓝色");
  });

  it("same-step preview does not constrain exact-ID delivery", async () => {
    const result = await run([[preview, sticker()]]);
    expect(result.kinds).toEqual([["img"]]);
  });

  it("sends an existing precise ID even with no image capability", async () => {
    const result = await run([sticker()], "unavailable");
    expect(result.kinds).toEqual([["img"]]);
    expect(result.deps.sender.sendWithProof).toHaveBeenCalledOnce();
  });

  it("allows text fallback after unavailable preview", async () => {
    const result = await run([preview, text()], "unavailable");
    expect(result.kinds).toEqual([["text"]]);
    expect(result.deps.store.markUsed).not.toHaveBeenCalled();
  });

  it("blocks two same-step send calls after a legitimate preview", async () => {
    const result = await run([preview, [sticker(), sticker()]]);
    expect(result.kinds).toEqual([["img"]]);
    expect(result.deps.store.markUsed).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.entries)).toContain("sticker_send_limit_reached");
  });

  it("delivers each text part as its own message without continuation", async () => {
    const result = await run([text(false, ["收到", "另一个补充"])], "native");
    expect(result.kinds).toEqual([["text"], ["text"]]);
    expect(JSON.stringify(result.sendMessage.mock.calls[0])).toContain("收到");
    expect(JSON.stringify(result.sendMessage.mock.calls[1])).toContain("另一个补充");
    expect(result.model.doStreamCalls).toHaveLength(2);
    expect(result.textTool.description).toContain("按交流意图分成不同 parts");
    expect(result.textTool.description).toContain("不结束本轮");
  });
});

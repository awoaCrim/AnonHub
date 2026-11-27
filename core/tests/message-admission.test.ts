import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { jsonSchema } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { expect, it, vi } from "vitest";

import { Channel } from "../src/channels/index.js";
import type { MessageBatchInput } from "../src/message-batches/index.js";
import type { MessageRecord } from "../src/messages/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { TestEvents, defaultConfig } from "./helpers/index.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["direct", "guild"] as const)("admits a busy %s batch once, after flushing, through the real Agent", async (type) => {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-admission-"));
  const channel = new Channel({ type, platform: "test", channelId: "room", guildId: "room", userId: "user", selfId: "bot" }, root);
  await channel.conversation.init();
  const requests: LanguageModelV3CallOptions[] = [];
  const finishedTurns: string[] = [];
  const gates = [gate(), gate()];
  const entered = [gate(), gate()];
  let workCalls = 0;
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "synthetic",
    modelId: "no-network",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("unused");
    },
    async doStream(options) {
      requests.push(structuredClone(options));
      const call = requests.length;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "tool-call", toolCallId: `call-${call}`, toolName: call <= 2 ? "work" : "finish", input: "{}" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: undefined },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 } },
            });
            controller.close();
          },
        }),
      };
    },
  };
  const queued: MessageBatchInput[] = [];
  let flush!: (messages: readonly MessageBatchInput[]) => Promise<void>;
  const runtime = new ChannelRuntime(new TestEvents(), {
    channel,
    bot: { selfId: "bot", sendMessage: vi.fn() } as never,
    model,
    will: { decide: () => "trigger", observe() {} },
    config: { ...defaultConfig(), basePath: root, modelRetries: 0 },
    readImagePolicy: { mode: "unavailable" },
    plugins: [
      {
        name: "synthetic-work",
        tools: [
          {
            name: "work",
            capability: { platforms: ["test"], sensitive: false, executionKind: "read" },
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            async execute() {
              const index = workCalls++;
              entered[index].resolve();
              await gates[index].promise;
              return { ok: true };
            },
          },
        ],
        onTurnFinish(result) {
          finishedTurns.push(result.turnId);
        },
      },
    ],
    messageBatch: {
      priority: 0,
      match: () => true,
      setup(_context, callback) {
        flush = callback;
        return {
          enqueue(input) {
            queued.push(input);
          },
        };
      },
    },
  });
  const input = (messageId: string): MessageRecord => ({
    platform: "test",
    selfId: "bot",
    timestamp: Date.now(),
    channel: { id: "room", type: type === "direct" ? 1 : 0 },
    user: { id: "user", name: "User" },
    messageId,
    parts: partsFromElements([{ type: "text", attrs: { content: messageId }, children: [] }] as never),
  });
  try {
    await runtime.init();
    await runtime.handle(input("ORIGINAL_TASK"));
    await flush(queued.splice(0));
    await entered[0].promise;
    await runtime.handle(input("BATCH_CONTEXT"));
    await runtime.handle(input("BATCH_SELECTED"));
    gates[0].resolve();
    await entered[1].promise;
    expect(JSON.stringify(requests[1].prompt)).not.toMatch(/BATCH_CONTEXT|BATCH_SELECTED/);

    await flush(queued.splice(0));
    gates[1].resolve();
    await runtime.wait();

    expect(requests).toHaveLength(type === "direct" ? 3 : 4);
    expect(new Set(finishedTurns).size).toBe(type === "direct" ? 1 : 2);
    if (type === "guild") expect(JSON.stringify(requests[2].prompt)).not.toMatch(/BATCH_CONTEXT|BATCH_SELECTED/);
    const finalPrompt = JSON.stringify(requests.at(-1)!.prompt);
    expect(finalPrompt).toContain("BATCH_CONTEXT");
    expect(finalPrompt).toContain("[CURRENT_MESSAGE]\\nBATCH_SELECTED");
    expect(finalPrompt).not.toContain("[CURRENT_MESSAGE]\\nBATCH_CONTEXT");
    const stored = await channel.conversation.storage.read();
    for (const messageId of ["BATCH_CONTEXT", "BATCH_SELECTED"]) {
      expect(
        stored.filter(
          (entry) =>
            entry.type === "message" &&
            entry.data.role === "custom" &&
            entry.data.type === "yesimbot.message" &&
            (entry.data.data as MessageRecord).messageId === messageId,
        ),
      ).toHaveLength(1);
    }
  } finally {
    for (const pending of gates) pending.resolve();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

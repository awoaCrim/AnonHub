import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { jsonSchema } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { expect, it, vi } from "vitest";

import { createAgent, type Agent } from "../src/agent.js";
import { createUserMessage } from "../src/message.js";

it("replaces only the specified queued turn, retaining its context, stream identity and FIFO slot", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: LanguageModelV3CallOptions[] = [];
  const agent = createAgent({
    model: new MockLanguageModelV3({
      async doStream(options) {
        requests.push(options);
        if (requests.length === 1) await blocked;
        return {
          stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "done" },
            { type: "text-end", id: "text" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ]),
        };
      },
    }),
  });
  const active = agent.run(createUserMessage("ACTIVE_INPUT"));
  const first = createUserMessage("QUEUED_FIRST");
  const second = createUserMessage("QUEUED_SECOND");
  const latest = createUserMessage("QUEUED_LATEST");
  const context = createUserMessage("QUEUED_CONTEXT");
  for (const message of [first, second, latest, context]) await agent.append(message, { deferred: true });
  const queued = agent.run(first, { contextMessages: [context] });
  const trailing = agent.run(createUserMessage("TRAILING_FIFO"));
  const activeEvents = Array.fromAsync(active);
  const queuedEvents = Array.fromAsync(queued);
  const trailingEvents = Array.fromAsync(trailing);
  try {
    expect(agent.replaceQueued(active.turnId, latest)).toBe(false);
    expect(agent.replaceQueued("missing-turn", latest)).toBe(false);
    expect(agent.replaceQueued(queued.turnId, second)).toBe(true);
    expect(agent.replaceQueued(queued.turnId, latest, { contextMessages: [first, context] })).toBe(true);
  } finally {
    release();
  }
  const [, events] = await Promise.all([activeEvents, queuedEvents, trailingEvents]);
  await agent.wait();
  expect(requests).toHaveLength(3);
  expect(events.every((event) => "turnId" in event && event.turnId === queued.turnId)).toBe(true);
  const pendingPrompt = JSON.stringify(requests[1]!.prompt);
  for (const message of [first, second, latest, context]) expect(pendingPrompt.split(String(message.content))).toHaveLength(2);
  expect(pendingPrompt).not.toContain("TRAILING_FIFO");
  expect(JSON.stringify(requests[2]!.prompt)).toContain("TRAILING_FIFO");
  const entries = await agent.storage.read();
  for (const message of [first, second, latest, context]) {
    expect(entries.filter((entry) => entry.type === "message" && entry.data.id === message.id)).toHaveLength(1);
  }
  expect(agent.replaceQueued(queued.turnId, latest)).toBe(false);
});

it("does not invoke another provider step after cancellation at a durable native tool pair", async () => {
  const requests: LanguageModelV3CallOptions[] = [];
  const execute = vi.fn(async () => ({ durable: "COMPLETED_EFFECT" }));
  let agent: Agent;
  agent = createAgent({
    maxRetries: 0,
    model: new MockLanguageModelV3({
      async doStream(options) {
        // Deliberately ignore abortSignal, as a transport mock or custom model may do.
        requests.push(options);
        const tool = requests.length === 1;
        const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
        if (tool) parts.push({ type: "tool-call", toolName: "write_once", toolCallId: "write-call", input: "{}" });
        else
          parts.push({ type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: "MUST_NOT_REQUEST" }, { type: "text-end", id: "answer" });
        parts.push({
          type: "finish",
          finishReason: { unified: tool ? "tool-calls" : "stop", raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: tool ? 0 : 1, reasoning: 0 },
          },
        });
        return { stream: convertArrayToReadableStream(parts) };
      },
    }),
    tools: [{ name: "write_once", inputSchema: jsonSchema({ type: "object" }), execute }],
    plugins: [
      {
        name: "cancel-at-durable-step",
        init({ channel }) {
          channel.subscribe("internal", (event) => {
            if (event.type === "turn.step") void agent.interrupt("new-input");
          });
        },
      },
    ],
  });
  const events = await Array.fromAsync(agent.run(createUserMessage("ORIGINAL_CURRENT")));
  await agent.wait();
  expect(events.at(-1)?.type).toBe("turn.aborted");
  expect(requests[0]!.abortSignal?.aborted).toBe(true);
  expect(requests).toHaveLength(1);
  expect(execute).toHaveBeenCalledOnce();
  const messages = (await agent.storage.read()).filter((entry) => entry.type === "message").map((entry) => entry.data);
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  expect(JSON.stringify(messages[2])).toContain("COMPLETED_EFFECT");
});

it("blocks an aborted zero-retry provider call after the SDK awaits supported URLs", async () => {
  let prepared!: () => void;
  const preparation = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  let releaseUrls!: (urls: Record<string, RegExp[]>) => void;
  const supportedUrls = new Promise<Record<string, RegExp[]>>((resolve) => {
    releaseUrls = resolve;
  });
  const doStream = vi.fn(async () => ({
    stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
      { type: "stream-start", warnings: [] },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
      },
    ]),
  }));
  const agent = createAgent({
    model: new MockLanguageModelV3({ supportedUrls, doStream }),
    maxRetries: 0,
    async beforeModelRequest() {
      prepared();
    },
  });
  const events = Array.fromAsync(agent.run(createUserMessage("CANCEL_DURING_SDK_AWAIT")));
  await preparation;
  // Let prepareStep return and the SDK reach its asynchronous URL preparation boundary.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const interrupted = agent.interrupt("new-input");
  releaseUrls({});
  await interrupted;
  expect((await events).at(-1)?.type).toBe("turn.aborted");
  expect(doStream).not.toHaveBeenCalled();
});

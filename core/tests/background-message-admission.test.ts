import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { currentModelRequestContext, jsonSchema, type TurnResult } from "@yesimbot/agent-runtime";
import { partsFromElements, textPart } from "@yesimbot/contracts/parts";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import type { WillEngine } from "../src/agents/will.js";
import { Channel } from "../src/channels/index.js";
import type { MessageBatchInput, MessageBatchPlugin } from "../src/message-batches/index.js";
import type { EventRecord, MessageRecord } from "../src/messages/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import type { PostOptions } from "../src/runtimes/types.js";
import { TestEvents, defaultConfig, h } from "./helpers/index.js";

const PREVIOUS_CONFIRMATION = "DAILY_NEWS_READY: 请确认后把这份日报发送到群里。";
const USER_CONFIRMATION = "ok捏";
const USER_REPLY = "收到确认，现在处理这份日报。";
const BACKGROUND_REPLY = "BACKGROUND_CHECK_FINISHED";
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function promptText(prompt: LanguageModelV3CallOptions["prompt"]): string {
  // Earlier web replies are send_message calls, so their text is a tool input.
  return prompt
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : part.type === "tool-call" ? [JSON.stringify(part.input)] : [])),
    )
    .join("\n");
}

async function fixture(blockAt: "tool" | "finish", batch?: "ordinary" | "will" | "event") {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-background-admission-"));
  const channel = new Channel({ type: "direct", platform: "web", channelId: "owner", userId: "owner", selfId: "bot" }, root);
  await channel.conversation.init();
  const entered = gate();
  const release = gate();
  const requests: { turnId: string | undefined; text: string }[] = [];
  const finished: TurnResult[] = [];
  let seeding = true;
  let callNumber = 0;
  const sentTurns = new Set<string | undefined>();
  const model = new MockLanguageModelV3({
    async doStream(options) {
      const text = promptText(options.prompt);
      // Web chat shows only send_message, and sending does not end the turn: the turn's next request finishes
      // (also after a send refused in a silent turn). That finish is not one of the recorded requests.
      const turnId = currentModelRequestContext()?.turnId;
      const afterSend = sentTurns.has(turnId);
      if (!seeding && !afterSend) requests.push({ turnId, text });
      const useTool = !seeding && !afterSend && requests.length === 1;
      const answer = seeding ? PREVIOUS_CONFIRMATION : text.includes(USER_CONFIRMATION) ? USER_REPLY : BACKGROUND_REPLY;
      if (!useTool && !afterSend) sentTurns.add(turnId);
      const chunks: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (useTool) chunks.push({ type: "tool-call", toolCallId: "background-lookup", toolName: "lookup", input: "{}" });
      else if (afterSend) chunks.push({ type: "tool-call", toolCallId: `finish-${++callNumber}`, toolName: "finish", input: "{}" });
      else chunks.push({ type: "tool-call", toolCallId: `answer-${++callNumber}`, toolName: "send_message", input: JSON.stringify({ messages: [answer] }) });
      chunks.push({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 } },
      });
      return { stream: convertArrayToReadableStream(chunks) };
    },
  });
  let deliveryNumber = 0;
  const createMessage = vi.fn(async (_channelId: string, _content: unknown) => [{ id: `web-${++deliveryNumber}` }]);
  const delivered = vi.fn();
  const ctx = new TestEvents();
  ctx.on("yesimbot/delivered", delivered);
  const queued: MessageBatchInput[] = [];
  let flush: ((inputs: readonly MessageBatchInput[]) => Promise<void>) | undefined;
  const messageBatch: MessageBatchPlugin | undefined = batch
    ? {
        priority: 0,
        match: () => true,
        setup(_context, _callback, extensions) {
          flush = extensions!.flushInputs;
          return {
            enqueue: (input) => queued.push(input),
            enqueueEvent: (input) => {
              queued.push(input);
              return true;
            },
          };
        },
      }
    : undefined;
  const will: WillEngine = {
    decide: () => "trigger",
    ...(batch === "will" || batch === "event"
      ? {
          decideBatch: (inputs: readonly MessageBatchInput[]) => ({
            decision: "trigger" as const,
            ...(batch === "will" ? { candidate: { inputId: inputs.at(-1)!.id, authorId: "owner", score: 1, probability: 1 } } : {}),
          }),
        }
      : {}),
  };
  const runtime = new ChannelRuntime(ctx, {
    channel,
    bot: { selfId: "bot", platform: "web", createMessage, sendMessage: vi.fn() } as never,
    model,
    will,
    config: defaultConfig({ basePath: root, modelRetries: 0, customInnerThought: false }),
    readImagePolicy: { mode: "unavailable" },
    messageBatch,
    plugins: [
      {
        name: "background-admission-fixture",
        tools: [
          {
            name: "lookup",
            capability: { platforms: ["web"], sensitive: false, executionKind: "read" },
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            async execute() {
              if (blockAt === "tool") {
                entered.resolve();
                await release.promise;
              }
              return { ok: true };
            },
          },
        ],
        async onTurnFinish(result) {
          if (seeding) return;
          if (blockAt === "finish" && finished.length === 0) {
            entered.resolve();
            await release.promise;
          }
          finished.push(result);
        },
      },
    ],
  });
  const input = (messageId: string, text: string): MessageRecord => ({
    platform: "web",
    selfId: "bot",
    timestamp: Date.now(),
    channel: { id: "owner", type: 1 },
    user: { id: "owner", name: "Owner" },
    messageId,
    parts: partsFromElements([h.text(text)]),
  });
  cleanup.push(async () => {
    release.resolve();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.init();
  // Seed the pending confirmation through a real conversation turn and web delivery.
  const previous = await runtime.post(input("prepare-daily", "请先整理日报，等我确认后再发。"));
  if (previous.kind !== "run") throw new Error("seed_turn_not_started");
  await previous.done;
  await runtime.wait();
  expect(await previous.outcome).toMatchObject({ status: "done", delivered: true });
  expect(createMessage.mock.calls.map(([, body]) => body)).toEqual([[textPart(PREVIOUS_CONFIRMATION)]]);
  seeding = false;
  createMessage.mockClear();
  delivered.mockClear();

  const event: EventRecord<"task.result"> = {
    eventType: "task.result",
    platform: "web",
    selfId: "bot",
    timestamp: Date.now(),
    channel: { id: "owner", type: 1 },
    user: { id: "owner" },
    task: { id: "heartbeat-check", status: "succeeded" },
    text: "Check pending matters during the scheduled heartbeat.",
  };
  return {
    runtime,
    input,
    event,
    entered,
    release,
    requests,
    finished,
    createMessage,
    delivered,
    async confirm() {
      const result = await runtime.handle(input("user-confirmation", USER_CONFIRMATION));
      if (batch === "event") {
        const poke: EventRecord<"notice.poke"> = {
          eventType: "notice.poke",
          platform: "web",
          selfId: "bot",
          timestamp: Date.now(),
          channel: { id: "owner", type: 1 },
          actorId: "owner",
          targetId: "bot",
          action: "poke",
          text: "USER_POKE_AFTER_CONFIRMATION",
        };
        await runtime.handle(poke);
      }
      if (flush) await flush(queued.splice(0));
      return result;
    },
  };
}

const backgroundCases: { name: string; origin: "event" | "message"; options: PostOptions }[] = [
  { name: "silent event", origin: "event", options: { delivery: "silent" } },
  { name: "channel event", origin: "event", options: { delivery: "channel" } },
  { name: "channel event with conversation history", origin: "event", options: { delivery: "channel", historyMode: "conversation" } },
  { name: "silent message", origin: "message", options: { delivery: "silent" } },
  { name: "message with event history", origin: "message", options: { delivery: "channel", historyMode: "event" } },
];

it.each(backgroundCases.flatMap((background) => (["tool", "finish"] as const).map((blockAt) => ({ ...background, blockAt }))))(
  "starts a separate visible user turn during $name $blockAt execution",
  async ({ options, origin, blockAt }) => {
    const f = await fixture(blockAt);
    const background = await f.runtime.post(origin === "event" ? f.event : f.input("background-message", "Check pending matters."), options);
    if (background.kind !== "run") throw new Error("background_turn_not_started");
    await f.entered.promise;
    const confirmation = await f.confirm();
    f.release.resolve();
    await f.runtime.wait();
    await background.done;

    expect(confirmation.kind).toBe("run");
    expect(new Set(f.requests.map((request) => request.turnId)).size).toBe(2);
    expect(f.finished.map((turn) => turn.status)).toEqual(["done", "done"]);
    const backgroundTurnId = f.requests[0]!.turnId;
    expect(f.requests.filter((request) => request.turnId === backgroundTurnId).every((request) => !request.text.includes(USER_CONFIRMATION))).toBe(true);
    expect(f.requests[0]!.text.includes(PREVIOUS_CONFIRMATION)).toBe(
      origin === "message" ? options.historyMode !== "event" : options.historyMode === "conversation",
    );
    const userRequest = f.requests.find((request) => request.turnId !== backgroundTurnId);
    expect(userRequest?.text).toContain(`[CURRENT_MESSAGE]\n${USER_CONFIRMATION}\n[/CURRENT_MESSAGE]`);
    expect(userRequest?.text).toContain(PREVIOUS_CONFIRMATION);
    const expectedBodies = options.delivery === "silent" ? [USER_REPLY] : [BACKGROUND_REPLY, USER_REPLY];
    expect(f.createMessage.mock.calls.map(([, body]) => body)).toEqual(expectedBodies.map((body) => [textPart(body)]));
    expect(f.delivered).toHaveBeenCalledTimes(expectedBodies.length);
  },
);

it.each(["ordinary", "will"] as const)("starts a visible user turn when a %s batch flushes during a silent event", async (batch) => {
  const f = await fixture("tool", batch);
  await f.runtime.post(f.event, { delivery: "silent" });
  await f.entered.promise;
  expect((await f.confirm()).kind).toBe("wait");
  f.release.resolve();
  await f.runtime.wait();

  expect(new Set(f.requests.map((request) => request.turnId)).size).toBe(2);
  expect(f.finished.map((turn) => turn.status)).toEqual(["done", "done"]);
  expect(f.requests.at(-1)?.text).toContain(`[CURRENT_MESSAGE]\n${USER_CONFIRMATION}\n[/CURRENT_MESSAGE]`);
  expect(f.requests.at(-1)?.text).toContain(PREVIOUS_CONFIRMATION);
  expect(f.createMessage.mock.calls.map(([, body]) => body)).toEqual([[textPart(USER_REPLY)]]);
});

it("keeps a user confirmation and its history when a mixed batch selects a poke during a silent event", async () => {
  const f = await fixture("tool", "event");
  await f.runtime.post(f.event, { delivery: "silent" });
  await f.entered.promise;
  expect((await f.confirm()).kind).toBe("wait");
  f.release.resolve();
  await f.runtime.wait();

  expect(new Set(f.requests.map((request) => request.turnId)).size).toBe(2);
  const backgroundTurnId = f.requests[0]!.turnId;
  expect(f.requests.filter((request) => request.turnId === backgroundTurnId).every((request) => !request.text.includes(USER_CONFIRMATION))).toBe(true);
  const userRequest = f.requests.find((request) => request.turnId !== backgroundTurnId);
  expect(userRequest?.text).toContain(USER_CONFIRMATION);
  expect(userRequest?.text).toContain("USER_POKE_AFTER_CONFIRMATION");
  expect(userRequest?.text).toContain(PREVIOUS_CONFIRMATION);
  expect(f.createMessage.mock.calls.map(([, body]) => body)).toEqual([[textPart(USER_REPLY)]]);
});

it("supersedes an ordinary direct message while retaining one visible web delivery", async () => {
  const f = await fixture("tool");
  const ordinary = await f.runtime.handle(f.input("original-user", "先帮我查一下。"));
  if (ordinary.kind !== "run") throw new Error("ordinary_turn_not_started");
  await f.entered.promise;
  const confirmation = await f.confirm();
  f.release.resolve();
  await f.runtime.wait();
  await ordinary.done;

  expect(confirmation.kind).toBe("run");
  expect(f.requests).toHaveLength(2);
  expect(new Set(f.requests.map((request) => request.turnId)).size).toBe(2);
  expect(f.finished.map((turn) => turn.status)).toEqual(["aborted", "done"]);
  expect(f.requests.at(-1)?.text).toContain(`[CURRENT_MESSAGE]\n${USER_CONFIRMATION}\n[/CURRENT_MESSAGE]`);
  expect(f.requests.at(-1)?.text).toContain(PREVIOUS_CONFIRMATION);
  expect(f.createMessage.mock.calls.map(([, body]) => body)).toEqual([[textPart(USER_REPLY)]]);
  expect(f.delivered).toHaveBeenCalledOnce();
});

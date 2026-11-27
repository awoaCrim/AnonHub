import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  currentModelRequestContext,
  jsonSchema,
  type AgentInternalEvent,
  type AgentPlugin,
  type AgentToolExecuteContext,
  type TurnResult,
} from "@yesimbot/agent-runtime";
import { partsMarkup, textPart, type Part } from "@yesimbot/contracts/parts";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import type { WillEngine } from "../src/agents/will.js";
import { Channel } from "../src/channels/index.js";
import { collectDeliveredSourceRecords } from "../src/conversations/internal-history.js";
import type { MessageBatchInput, MessageBatchPlugin } from "../src/message-batches/index.js";
import type { EventRecord, MessageRecord } from "../src/messages/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { defaultConfig, TestEvents } from "./helpers/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.restoreAllMocks();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let stepNumber = 0;
function step(text?: string, tools: { name: string; input?: object }[] = []) {
  const stepId = ++stepNumber;
  const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (text) parts.push({ type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: text }, { type: "text-end", id: "text" });
  for (const [index, tool] of tools.entries())
    parts.push({ type: "tool-call", toolCallId: `call-${stepId}-${index}`, toolName: tool.name, input: JSON.stringify(tool.input ?? {}) });
  parts.push({
    type: "finish",
    finishReason: { unified: tools.length ? "tool-calls" : "stop", raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  });
  return { stream: convertArrayToReadableStream(parts) };
}

const sends = new WeakSet<object>();
/** Web chat shows only what send_message sends. Sending does not end the turn; the fixture then finishes it. */
function say(text: string) {
  const result = step(undefined, [{ name: "send_message", input: { messages: [text] } }]);
  sends.add(result);
  return result;
}

type StreamResult = ReturnType<typeof step>;

async function fixture(options: {
  stream: (request: LanguageModelV3CallOptions, index: number) => StreamResult | Promise<StreamResult>;
  plugin?: AgentPlugin;
  platform?: string;
  group?: boolean;
  will?: WillEngine;
  batch?: MessageBatchPlugin;
  send?: (channel: string, content: unknown) => Promise<string[]>;
}) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-input-interrupt-"));
  const platform = options.platform ?? "web";
  const scope = options.group
    ? { type: "guild" as const, platform, selfId: "bot", channelId: "room", guildId: "room" }
    : { type: "direct" as const, platform, selfId: "bot", channelId: "owner", userId: "owner" };
  const channel = new Channel(scope, root);
  await channel.conversation.init();
  const requests: { turnId?: string; options: LanguageModelV3CallOptions }[] = [];
  const finished: TurnResult[] = [];
  const events: AgentInternalEvent[] = [];
  // Per turn: how many user messages the request that sent had. Nothing new since then means the turn is done.
  const sentTurns = new Map<string | undefined, number>();
  const model = new MockLanguageModelV3({
    async doStream(request) {
      const turnId = currentModelRequestContext()?.turnId;
      const users = request.prompt.filter((message) => message.role === "user").length;
      // The finish after a send is not one of the scripted requests.
      if (sentTurns.get(turnId) === users) return step(undefined, [{ name: "finish" }]);
      sentTurns.delete(turnId);
      const index = requests.length;
      requests.push({ turnId, options: request });
      const result = await options.stream(request, index);
      if (sends.has(result)) sentTurns.set(turnId, users);
      return result;
    },
  });
  const createMessage = vi.fn(async (_channel: string, _content: unknown) => [{ id: `web-${createMessage.mock.calls.length}` }]);
  const sendMessage = vi.fn(options.send ?? (async (_channel: string, _content: unknown) => [`sent-${sendMessage.mock.calls.length}`]));
  const activity = vi.fn();
  const delivered = vi.fn();
  const ctx = new TestEvents();
  ctx.on("yesimbot/turn", activity);
  ctx.on("yesimbot/delivered", delivered);
  const runtime = new ChannelRuntime(ctx, {
    channel,
    bot: { platform, selfId: "bot", createMessage, sendMessage } as never,
    model,
    will: options.will ?? { decide: () => "trigger" },
    config: defaultConfig({ basePath: root, modelRetries: 0, customInnerThought: false, pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 } }),
    readImagePolicy: { mode: "unavailable" },
    messageBatch: options.batch,
    plugins: [
      {
        name: "interrupt-observer",
        init: ({ channel }) => {
          channel.subscribe("internal", (event) => {
            events.push(event);
          });
        },
        onTurnFinish: (result) => {
          finished.push(result);
        },
      },
      ...(options.plugin ? [options.plugin] : []),
    ],
  });
  await runtime.init();
  cleanup.push(async () => {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  let inputNumber = 0;
  const input = (text: string): MessageRecord => ({
    platform,
    selfId: "bot",
    timestamp: Date.now(),
    channel: { id: scope.channelId, type: options.group ? 0 : 1 },
    user: { id: "owner", name: "Owner" },
    messageId: `input-${++inputNumber}`,
    parts: [textPart(text)],
  });
  const event = (text: string): EventRecord<"task.result"> => ({
    eventType: "task.result",
    platform,
    selfId: "bot",
    timestamp: Date.now(),
    channel: { id: scope.channelId, type: options.group ? 0 : 1 },
    task: { id: text, status: "succeeded" },
    text,
  });
  return { runtime, channel, requests, finished, events, createMessage, sendMessage, activity, delivered, input, event };
}

function interruptible(request: LanguageModelV3CallOptions, entered: ReturnType<typeof gate>) {
  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        request.abortSignal!.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        entered.resolve();
      },
    }),
  };
}

it("aborts the actual model request and answers the latest input with the interrupted input retained once", async () => {
  const entered = gate();
  const f = await fixture({ stream: (request, index) => (index === 0 ? interruptible(request, entered) : say("LATEST_ANSWER")) });
  const first = await f.runtime.handle(f.input("USER_A_UNIQUE"));
  await entered.promise;
  const latest = await f.runtime.handle(f.input("USER_B_UNIQUE"));
  expect(f.requests[0]!.options.abortSignal?.aborted).toBe(true);
  if (first.kind !== "run" || latest.kind !== "run") throw Error("expected separate runs");
  await Promise.all([first.done, latest.done]);
  await f.runtime.wait();
  expect(await first.outcome).toMatchObject({ status: "aborted", delivered: false });
  expect(f.requests).toHaveLength(2);
  const prompt = JSON.stringify(f.requests[1]!.options.prompt);
  for (const text of ["USER_A_UNIQUE", "USER_B_UNIQUE"]) expect(prompt.split(text)).toHaveLength(2);
  expect(prompt).toContain("[CURRENT_MESSAGE]\\nUSER_B_UNIQUE\\n[/CURRENT_MESSAGE]");
  expect(f.createMessage.mock.calls.map(([, content]) => content)).toEqual([[textPart("LATEST_ANSWER")]]);
});

it("coalesces A/B/C while a write is running and aborts only after its native tool pair is durable", async () => {
  const entered = gate();
  const releaseTool = gate();
  const after = gate();
  const releaseAfter = gate();
  const pair = gate();
  const releasePair = gate();
  let toolSignal: AbortSignal | undefined;
  const execute = vi.fn(async (_input: unknown, context: AgentToolExecuteContext) => {
    toolSignal = context.abortSignal;
    entered.resolve();
    await releaseTool.promise;
    return { writeResult: "WRITE_COMPLETED_ONCE" };
  });
  const neverStart = vi.fn(async () => ({ staleEffect: true }));
  const settleReservation = vi.fn(async () => {});
  let reservation = 0;
  const f = await fixture({
    stream: (_request, index) =>
      index === 0
        ? step("CHECKING_OLD", [{ name: "write_once" }, { name: "never_start" }])
        : index === 1
          ? step("FIFO_CHECK_COMPLETE", [{ name: "finish" }])
          : say("ABC_FINAL"),
    will: { decide: () => "trigger", decideBatch: () => ({ decision: "trigger", reservationId: `reservation-${++reservation}` }), settleReservation },
    plugin: {
      name: "write-fixture",
      tools: [
        {
          name: "write_once",
          capability: { platforms: ["web"], sensitive: false, executionKind: "communication" },
          inputSchema: jsonSchema({ type: "object" }),
          execute,
        },
        {
          name: "never_start",
          capability: { platforms: ["web"], sensitive: false, executionKind: "communication" },
          inputSchema: jsonSchema({ type: "object" }),
          execute: neverStart,
        },
      ],
      async afterToolCall(result) {
        if (result.toolName === "write_once") {
          after.resolve();
          await releaseAfter.promise;
        }
      },
      async onAppend(entries) {
        if (entries.some((entry) => entry.type === "message" && entry.data.role === "tool" && JSON.stringify(entry.data).includes("WRITE_COMPLETED_ONCE"))) {
          pair.resolve();
          await releasePair.promise;
        }
      },
    },
  });
  cleanup.unshift(async () => {
    releaseTool.resolve();
    releaseAfter.resolve();
    releasePair.resolve();
  });
  const first = await f.runtime.handle(f.input("ABC_A"));
  await entered.promise;
  const queuedPost = await f.runtime.post(f.event("FIFO_POST_CHECK"), { historyMode: "conversation", delivery: "silent" });
  const second = await f.runtime.handle(f.input("ABC_B"));
  const third = await f.runtime.handle(f.input("ABC_C"));
  expect(second.kind).toBe("run");
  expect(third.kind).toBe("join");
  expect(toolSignal?.aborted).toBe(false);
  releaseTool.resolve();
  await after.promise;
  expect(toolSignal?.aborted).toBe(false);
  releaseAfter.resolve();
  await pair.promise;
  expect(toolSignal?.aborted).toBe(false);
  releasePair.resolve();
  if (first.kind !== "run" || second.kind !== "run" || queuedPost.kind !== "run") throw Error("expected runs");
  await Promise.all([first.done, second.done, queuedPost.done]);
  await f.runtime.wait();
  expect(toolSignal?.aborted).toBe(true);
  expect(execute).toHaveBeenCalledOnce();
  expect(neverStart).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(3);
  const fifoPrompt = JSON.stringify(f.requests[1]!.options.prompt);
  expect(fifoPrompt).toContain("ABC_A");
  expect(fifoPrompt).not.toContain("ABC_B");
  expect(fifoPrompt).not.toContain("ABC_C");
  const prompt = JSON.stringify(f.requests[2]!.options.prompt);
  for (const text of ["ABC_A", "ABC_B", "ABC_C", "WRITE_COMPLETED_ONCE"]) expect(prompt.split(text)).toHaveLength(2);
  expect(prompt).toContain("[CURRENT_MESSAGE]\\nABC_C\\n[/CURRENT_MESSAGE]");
  expect(prompt.indexOf("ABC_A")).toBeLessThan(prompt.indexOf("WRITE_COMPLETED_ONCE"));
  const toolEntries = (await f.channel.conversation.storage.read()).filter((entry) => entry.type === "message" && entry.data.role === "tool");
  expect(JSON.stringify(toolEntries)).toContain("WRITE_COMPLETED_ONCE");
  expect(f.createMessage.mock.calls.map(([, content]) => content)).toEqual([[textPart("ABC_FINAL")]]);
  expect(settleReservation).toHaveBeenCalledWith("reservation-3", expect.objectContaining({ kind: "release", reason: "coalesced-pending-turn" }));
  expect(settleReservation).toHaveBeenCalledWith("reservation-2", expect.objectContaining({ kind: "commit" }));
  const oldTurn = f.requests[0]!.turnId;
  const ended = f.activity.mock.calls.findIndex(([event]) => event.turnId === oldTurn && !event.active);
  expect(ended).toBeGreaterThanOrEqual(0);
  expect(f.activity.mock.calls.slice(ended + 1).some(([event]) => event.turnId === oldTurn && event.active)).toBe(false);
});

it.each([
  { name: "direct", group: false },
  { name: "group", group: true },
])("stops old $name send_message tail parts, retains the confirmed prefix and isolates a late transport receipt", async ({ group }) => {
  const entered = gate();
  const lateReceipt = gate();
  let calls = 0;
  const text = (value: string) => ({ kind: "text", text: value });
  const f = await fixture({
    platform: "onebot",
    group,
    stream: (_request, index) =>
      index === 0
        ? step(undefined, [{ name: "send_message", input: { parts: [text("PREFIX_CONFIRMED"), text("PENDING_TRANSPORT"), text("STALE_TAIL")] } }])
        : index === 1
          ? step(undefined, [{ name: "send_message", input: { parts: [text("FRESH_REPLY")] } }])
          : step(undefined, [{ name: "finish" }]),
    async send() {
      const index = ++calls;
      if (index === 2) {
        entered.resolve();
        await lateReceipt.promise;
      }
      return [`platform-${index}`];
    },
  });
  cleanup.unshift(async () => {
    lateReceipt.resolve();
  });
  const first = await f.runtime.handle(f.input("SEND_A"));
  await entered.promise;
  expect(f.delivered.mock.calls.some(([notice]) => notice.messageId === "platform-1")).toBe(true);
  const latest = await f.runtime.handle(f.input("SEND_B"));
  if (first.kind !== "run" || latest.kind !== "run") throw Error("expected runs");
  await Promise.all([first.done, latest.done]);
  await f.runtime.wait();
  expect(await first.outcome).toMatchObject({ status: "aborted", delivered: true });
  expect(await latest.outcome).toMatchObject({ status: "done", delivered: true });
  expect(f.requests[0]!.options.abortSignal?.aborted).toBe(true);
  const sent = f.sendMessage.mock.calls.map(([, content]) => partsMarkup(content as Part[]));
  expect(sent).toEqual(["PREFIX_CONFIRMED", "PENDING_TRANSPORT", "FRESH_REPLY"]);
  const deliveredBeforeLate = [...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text);
  expect(deliveredBeforeLate).toContain("PREFIX_CONFIRMED");
  expect(deliveredBeforeLate).toContain("FRESH_REPLY");
  expect(deliveredBeforeLate).not.toContain("STALE_TAIL");
  lateReceipt.resolve();
  await vi.waitFor(() => {
    expect(f.delivered.mock.calls.some(([notice]) => notice.messageId === "platform-2")).toBe(true);
  });
  const allProofs = [...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text);
  expect(allProofs).toContain("PENDING_TRANSPORT");
  expect(f.sendMessage).toHaveBeenCalledTimes(3);
  expect(f.createMessage).not.toHaveBeenCalled();
});

it("does not start an old tool after a beforeToolCall hook yields to a new user message", async () => {
  const entered = gate();
  const release = gate();
  const execute = vi.fn(async () => ({ changed: true }));
  const f = await fixture({
    stream: (_request, index) => (index === 0 ? step("OLD_ACTIVITY", [{ name: "write_once" }]) : say("LATEST_ONLY")),
    plugin: {
      name: "delayed-admission",
      tools: [
        {
          name: "write_once",
          capability: { platforms: ["web"], sensitive: false, executionKind: "communication" },
          inputSchema: jsonSchema({ type: "object" }),
          execute,
        },
      ],
      async beforeToolCall() {
        entered.resolve();
        await release.promise;
      },
    },
  });
  cleanup.unshift(async () => {
    release.resolve();
  });
  await f.runtime.handle(f.input("HOOK_A"));
  await entered.promise;
  const latest = await f.runtime.handle(f.input("HOOK_B"));
  expect(f.requests[0]!.options.abortSignal?.aborted).toBe(true);
  release.resolve();
  if (latest.kind !== "run") throw Error("expected run");
  await latest.done;
  expect(execute).not.toHaveBeenCalled();
  expect(f.createMessage.mock.calls.map(([, content]) => content)).toEqual([[textPart("LATEST_ONLY")]]);
});

it.each(["message", "event"])("carries explicitly joined %s input across a later user supersession", async (kind) => {
  const entered = gate();
  const f = await fixture({ stream: (request, index) => (index === 0 ? interruptible(request, entered) : say("WITH_JOINED_CONTEXT")) });
  await f.runtime.handle(f.input("JOIN_OWNER_A"));
  await entered.promise;
  const joined = await f.runtime.post(kind === "message" ? f.input("JOINED_PRIVATE_INPUT") : f.event("JOINED_EVENT_INPUT"), { ifBusy: "join" });
  expect(joined.kind).toBe("join");
  const latest = await f.runtime.handle(f.input("JOIN_OWNER_B"));
  if (latest.kind !== "run") throw Error("expected run");
  await latest.done;
  const prompt = JSON.stringify(f.requests[1]!.options.prompt);
  expect(prompt).toContain(kind === "message" ? "JOINED_PRIVATE_INPUT" : "JOINED_EVENT_INPUT");
  const entries = await f.channel.conversation.storage.read();
  expect(entries.filter((entry) => entry.type === "message" && entry.data.id === joined.eventId)).toHaveLength(1);
});

it("does not replay an explicitly joined event after the old turn has already admitted it", async () => {
  const toolEntered = gate();
  const releaseTool = gate();
  const nextModel = gate();
  const f = await fixture({
    stream: (request, index) =>
      index === 0 ? step(undefined, [{ name: "lookup" }]) : index === 1 ? interruptible(request, nextModel) : say("AFTER_PROCESSED_EVENT"),
    plugin: {
      name: "event-admission-fixture",
      tools: [
        {
          name: "lookup",
          capability: { platforms: ["web"], sensitive: false, executionKind: "read" },
          inputSchema: jsonSchema({ type: "object" }),
          async execute() {
            toolEntered.resolve();
            await releaseTool.promise;
            return { ok: true };
          },
        },
      ],
    },
  });
  cleanup.unshift(async () => {
    releaseTool.resolve();
  });
  await f.runtime.handle(f.input("PROCESSED_EVENT_A"));
  await toolEntered.promise;
  await f.runtime.post(f.event("EVENT_ALREADY_PROCESSED"), { ifBusy: "join" });
  releaseTool.resolve();
  await nextModel.promise;
  expect(JSON.stringify(f.requests[1]!.options.prompt).includes("EVENT_ALREADY_PROCESSED")).toBe(true);
  const latest = await f.runtime.handle(f.input("PROCESSED_EVENT_B"));
  if (latest.kind !== "run") throw Error("expected run");
  await latest.done;
  expect(JSON.stringify(f.requests[2]!.options.prompt).includes("EVENT_ALREADY_PROCESSED")).toBe(false);
});

it("defers an explicit post joining after the active user turn was already superseded", async () => {
  const entered = gate();
  const release = gate();
  const f = await fixture({
    stream: (_request, index) => (index === 0 ? step(undefined, [{ name: "lookup" }]) : step(index === 1 ? "USER_RESPONSE" : "PRIVATE_POST_RESPONSE")),
    plugin: {
      name: "late-join-fixture",
      tools: [
        {
          name: "lookup",
          capability: { platforms: ["web"], sensitive: false, executionKind: "read" },
          inputSchema: jsonSchema({ type: "object" }),
          async execute() {
            entered.resolve();
            await release.promise;
            return { ok: true };
          },
        },
      ],
    },
  });
  cleanup.unshift(async () => {
    release.resolve();
  });
  await f.runtime.handle(f.input("LATE_JOIN_A"));
  await entered.promise;
  const next = await f.runtime.handle(f.input("LATE_JOIN_B"));
  const privatePost = await f.runtime.post(f.input("LATE_JOIN_PRIVATE"), { ifBusy: "join" });
  expect(privatePost.kind).toBe("run");
  release.resolve();
  if (next.kind !== "run" || privatePost.kind !== "run") throw Error("expected runs");
  await Promise.all([next.done, privatePost.done]);
  await f.runtime.wait();
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(f.requests[1]!.options.prompt).includes("LATE_JOIN_PRIVATE")).toBe(false);
  expect(JSON.stringify(f.requests[2]!.options.prompt).includes("LATE_JOIN_PRIVATE")).toBe(true);
});

it("retains the existing join policy for a visible private post", async () => {
  const entered = gate();
  const release = gate();
  const f = await fixture({
    stream: async (_request, index) => {
      if (index === 0) {
        entered.resolve();
        await release.promise;
      }
      return say("VISIBLE_PRIVATE_REPLY");
    },
  });
  cleanup.unshift(async () => {
    release.resolve();
  });
  const original = await f.runtime.post(f.input("VISIBLE_PRIVATE_POST"));
  await entered.promise;
  const joined = await f.runtime.handle(f.input("NORMAL_USER_JOIN"));
  expect(joined.kind).toBe("join");
  expect(f.requests[0]!.options.abortSignal?.aborted).toBe(false);
  release.resolve();
  if (original.kind !== "run") throw Error("expected run");
  await original.done;
  await f.runtime.wait();
  expect(new Set(f.requests.map((request) => request.turnId)).size).toBe(1);
  expect(f.requests).toHaveLength(2);
});

it("leaves background turns and FIFO positions intact while updating one queued user turn", async () => {
  const entered = gate();
  const release = gate();
  const f = await fixture({
    stream: async (_request, index) => {
      if (index === 0) {
        entered.resolve();
        await release.promise;
      }
      // The silent background posts end with finish; this test only checks FIFO order and prompts.
      return step(`FIFO_REPLY_${index}`, [{ name: "finish" }]);
    },
  });
  cleanup.unshift(async () => {
    release.resolve();
  });
  await f.runtime.post(f.event("BACKGROUND_FIRST"), { delivery: "silent" });
  await entered.promise;
  await f.runtime.post(f.event("BACKGROUND_SECOND"), { delivery: "silent" });
  const firstUser = await f.runtime.handle(f.input("QUEUED_USER_B"));
  await f.runtime.post(f.event("BACKGROUND_LAST"), { delivery: "silent" });
  expect((await f.runtime.handle(f.input("QUEUED_USER_C"))).kind).toBe("join");
  expect(f.requests[0]!.options.abortSignal?.aborted).toBe(false);
  release.resolve();
  if (firstUser.kind !== "run") throw Error("expected queued run");
  await firstUser.done;
  await f.runtime.wait();
  expect(f.finished.map((result) => result.status)).toEqual(["done", "done", "done", "done"]);
  expect(f.requests).toHaveLength(4);
  expect(JSON.stringify(f.requests[1]!.options.prompt)).toContain("BACKGROUND_SECOND");
  expect(JSON.stringify(f.requests[2]!.options.prompt)).toContain("[CURRENT_MESSAGE]\\nQUEUED_USER_C\\n[/CURRENT_MESSAGE]");
  expect(JSON.stringify(f.requests[3]!.options.prompt)).toContain("BACKGROUND_LAST");
});

it("does not interrupt an admitted group turn for a Will wait message", async () => {
  const entered = gate();
  const release = gate();
  let decision = 0;
  const f = await fixture({
    platform: "test",
    group: true,
    will: { decide: () => (++decision === 1 ? "trigger" : "wait") },
    stream: async () => {
      entered.resolve();
      await release.promise;
      return step(undefined, [{ name: "finish" }]);
    },
  });
  cleanup.unshift(async () => {
    release.resolve();
  });
  const first = await f.runtime.handle(f.input("GROUP_ADMITTED"));
  await entered.promise;
  expect((await f.runtime.handle(f.input("GROUP_WAIT"))).kind).toBe("wait");
  expect(f.requests[0]!.options.abortSignal?.aborted).toBe(false);
  release.resolve();
  if (first.kind !== "run") throw Error("expected run");
  await first.done;
  await f.runtime.wait();
  expect(f.finished[0]!.status).toBe("done");
});

it("keeps an enabled message batch on its existing joined-turn behavior", async () => {
  const entered = gate();
  const release = gate();
  const pending: MessageBatchInput[] = [];
  let flush!: (inputs: readonly MessageBatchInput[]) => Promise<void>;
  const f = await fixture({
    stream: async (_request, index) => {
      if (index === 0) {
        entered.resolve();
        await release.promise;
      }
      return say("BATCH_REPLY");
    },
    batch: {
      priority: 0,
      match: () => true,
      setup(_context, _callback, extension) {
        flush = extension!.flushInputs;
        return {
          enqueue: (input) => {
            pending.push(input);
          },
        };
      },
    },
  });
  cleanup.unshift(async () => {
    release.resolve();
  });
  await f.runtime.handle(f.input("BATCH_A"));
  await flush(pending.splice(0));
  await entered.promise;
  await f.runtime.handle(f.input("BATCH_B"));
  await flush(pending.splice(0));
  expect(f.requests[0]!.options.abortSignal?.aborted).toBe(false);
  release.resolve();
  await f.runtime.wait();
  expect(new Set(f.requests.map((request) => request.turnId)).size).toBe(1);
  expect(f.requests).toHaveLength(2);
});

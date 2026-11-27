import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createEntry, type Agent, type AgentPlugin } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));

import { StickerDeliveryService } from "../../plugins/sticker-manager/src/delivery.js";
import type { StickerStore } from "../../plugins/sticker-manager/src/store.js";
import { config as stickerConfig, createDeps, scope, stickerId } from "../../plugins/sticker-manager/tests/preview-fixtures.js";
import { Channel } from "../src/channels/index.js";
import { collectDeliveredSourceRecords } from "../src/conversations/internal-history.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import type { ChannelRuntimeOptions } from "../src/runtimes/types.js";
import { TestEvents, defaultConfig, defaultMessageRecord } from "./helpers/index.js";

type Call = { toolName: string; input: Record<string, unknown> };

type Step = Call | ((messages: ModelMessage[]) => Call);
const text = (value: string) => ({ kind: "text" as const, text: value });
const finish = { toolName: "finish", input: {} };
const notifyWebhookEvent = {
  eventType: "notify-webhook",
  platform: "test",
  selfId: "bot",
  timestamp: 2,
  channel: { id: scope.channelId, type: 0 },
  text: "[SYSTEM_NOTIFICATION] webhook completed",
  payload: { status: "completed", result: "ok" },
} as never;
const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
function modelFor(steps: Step[]) {
  const prompts: ModelMessage[][] = [];
  return {
    prompts,
    model: new MockLanguageModelV3({
      doStream: async (options) => {
        const step = steps[prompts.length];
        if (!step) throw new Error("unexpected scripted request");
        const id = `call-${prompts.length}`;
        const messages = options.prompt as ModelMessage[];
        prompts.push(messages);
        const call = typeof step === "function" ? step(messages) : step;
        const input = JSON.stringify(call.input);
        return {
          stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id, toolName: call.toolName },
            { type: "tool-input-delta", id, delta: input },
            { type: "tool-input-end", id },
            { type: "tool-call", toolCallId: id, toolName: call.toolName, input },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            },
          ]),
        };
      },
    }),
  };
}

async function fixture(steps: Step[], options: Partial<Pick<ChannelRuntimeOptions, "replyStillCurrent">> & { send?: () => Promise<string[]> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-modern-runtime-"));
  roots.push(root);
  const channel = new Channel(scope, root);
  await channel.conversation.init();
  const deps = createDeps();
  const sendMessage = vi.fn(options.send ?? (async () => ["platform-id"]));
  const delivery = new StickerDeliveryService({
    store: deps.store as unknown as StickerStore,
    sender: { sendWithProof: sendMessage },
    scope,
    config: stickerConfig,
    sendSlot: deps.slot,
    previewGate: deps.gate,
  });
  const ctx = new TestEvents();
  const notices: unknown[] = [];
  ctx.on("yesimbot/delivered", (notice) => {
    notices.push(notice);
  });
  const scripted = modelFor(steps);
  const settleReservation = vi.fn(async () => {});
  const plugin: AgentPlugin = {
    name: "runtime-sticker-fixture",
    tools: () => [{ ...deps.preview, capability: { platforms: ["test"], sensitive: false, executionKind: "read" } }],
    onTurnFinish: (_result, context) => {
      deps.gate.clearTurn(context.turnId);
      deps.slot.clearTurn(context.turnId);
    },
  };
  const runtime = new ChannelRuntime(ctx, {
    channel,
    bot: { selfId: "bot", platform: "test", sendMessage } as never,
    will: {
      decide: async () => "trigger" as const,
      decideBatch: async () => ({ decision: "trigger" as const, reservationId: "reservation" }),
      settleReservation,
      observe: () => {},
    },
    model: scripted.model,
    readImagePolicy: { mode: "native" },
    imageProjection: deps.projection,
    config: defaultConfig({ basePath: root, pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 }, modelRetries: 0 }),
    plugins: [plugin],
    roleProfile: { characterDefinition: "FULL NORMAL MAIN ROLE" },
    ...options,
    sticker: {
      revision: 1,
      status: (turn) => delivery.status(turn),
      catalog: () => delivery.catalog(),
      view: (turn, messages) => delivery.view(turn, messages),
      isViewCurrent: (view, turn) => delivery.isViewCurrent(view, turn),
      preflight: (input) => delivery.preflight(input),
    },
  });
  runtimes.push(runtime);
  await runtime.init();
  const handle = async () => {
    const outcome = await runtime.handle(defaultMessageRecord({ channel: { id: scope.channelId, type: 0 } }));
    if (outcome.kind === "run") await outcome.done;
    await runtime.wait();
  };
  return { runtime, channel, ctx, handle, sendMessage, settleReservation, notices, prompts: scripted.prompts };
}

describe("actual ChannelRuntime modern reply boundaries", () => {
  it("announces scoped turn activity and clears it when the real agent finishes or fails", async () => {
    for (const step of [
      finish,
      () => {
        throw new Error("model failed");
      },
    ]) {
      const f = await fixture([step]);
      const activity: Array<{ active: boolean; turnId: string; context: unknown }> = [];
      f.ctx.on("yesimbot/turn", (event) => {
        activity.push(event);
      });
      await f.handle();
      expect(activity.map((event) => event.active)).toEqual([true, false]);
      expect(activity[0].turnId).toBe(activity[1].turnId);
      expect(activity[0].context).toEqual(f.channel.context);
    }
  });
  it("keeps the turn and its Will settlement intact when a turn activity listener throws", async () => {
    const f = await fixture([finish]);
    const listener = vi.fn(() => {
      throw new Error("broken observer");
    });
    f.ctx.on("yesimbot/turn", listener);
    await expect(f.handle()).resolves.toBeUndefined();
    expect(listener.mock.calls.map(([event]) => event.active)).toEqual([true, false]);
    expect(f.settleReservation).toHaveBeenCalledOnce();
  });
  it("sends twice without continue and finishes separately", async () => {
    const ack = { toolName: "send_message", input: { parts: [text("acknowledgement")] } };
    const result = { toolName: "send_message", input: { parts: [text("result")] } };
    const f = await fixture([ack, result, finish]);
    await f.handle();
    expect(f.prompts).toHaveLength(3);
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    const entries = await f.channel.conversation.storage.read();
    expect([...collectDeliveredSourceRecords(entries).values()].flat().map((record) => record.text)).toEqual(["acknowledgement", "result"]);
    expect(f.notices).toHaveLength(2);
  });

  it("sticker-only delivery with real platform IDs commits the active Will reservation", async () => {
    const f = await fixture([
      { toolName: "sticker_preview", input: { sticker_id: stickerId } },
      { toolName: "send_message", input: { parts: [{ kind: "sticker", sticker_id: stickerId }] } },
    ]);
    await f.handle();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledWith("reservation", expect.objectContaining({ kind: "commit", messageId: "platform-id" }));
    expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text)).toEqual([
      `[已发送表情包 ${stickerId}]`,
    ]);
    expect(JSON.stringify(f.prompts[0])).toContain("FULL NORMAL MAIN ROLE");
  });
  it("a zero-ID sticker attempt releases Will instead of promoting uncertainty to delivery", async () => {
    const f = await fixture(
      [
        { toolName: "sticker_preview", input: { sticker_id: stickerId } },
        { toolName: "send_message", input: { parts: [{ kind: "sticker", sticker_id: stickerId }] } },
        finish,
      ],
      { send: async () => [] },
    );
    await f.handle();
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledWith("reservation", expect.objectContaining({ kind: "release" }));
    expect(f.notices).toEqual([]);
  });
  it("a confirmed prefix commits Will and stays readable after actual SDK cancellation", async () => {
    const f = await fixture([{ toolName: "send_message", input: { parts: [text("confirmed"), text("never")] } }]);
    // Interrupt the actual SDK agent owned by this fixture without changing production visibility.
    const agent = Reflect.get(f.runtime, "agent") as Agent;
    f.ctx.on("yesimbot/delivered", () => {
      void agent.interrupt("after-first-id");
    });
    await f.handle();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledWith("reservation", expect.objectContaining({ kind: "commit" }));
    expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text)).toEqual(["confirmed"]);
  });
  it("late actual IDs after stop record proof but never resurrect a released Will tracker", async () => {
    let resolve!: (ids: string[]) => void;
    const pending = new Promise<string[]>((done) => {
      resolve = done;
    });
    const f = await fixture([{ toolName: "send_message", input: { parts: [text("late actual")] } }], { send: () => pending });
    const run = f.handle();
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce());
    await f.runtime.stop();
    await run;
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledWith("reservation", expect.objectContaining({ kind: "release" }));
    resolve(["late-platform"]);
    await vi.waitFor(async () =>
      expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text)).toEqual([
        "late actual",
      ]),
    );
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.notices).toHaveLength(1);
  });
  it("delivers only main-authored parts and keeps the complete normal role material", async () => {
    const f = await fixture([{ toolName: "send_message", input: { parts: [text("main authored")], inner_thought: "PRIVATE" } }]);
    await f.handle();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.prompts)).toContain("FULL NORMAL MAIN ROLE");
    expect(JSON.stringify(f.prompts)).not.toContain("PRIVATE");
    expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text)).toEqual([
      "main authored",
    ]);
  });
  it("no legacy draft, facts or reply_id channel can deliver", async () => {
    const f = await fixture([
      { toolName: "send_message", input: { messages: ["legacy draft"], facts: ["f"], intent: "react" } },
      { toolName: "send_message", input: { reply_id: "guessed" } },
      finish,
    ]);
    await f.handle();
    expect(f.sendMessage).not.toHaveBeenCalled();
    // The raw rejected calls stay durable, but nothing becomes delivered/role speech.
    expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()]).toEqual([]);
  });
  it("a stale reply boundary blocks transport before any output", async () => {
    const f = await fixture([{ toolName: "send_message", input: { parts: [text("must not send")] } }], { replyStillCurrent: () => false });
    await f.handle();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()]).toEqual([]);
  });
  it("explicit channel delivery lets a notify event author a reply without ordinary history", async () => {
    const f = await fixture([{ toolName: "send_message", input: { parts: [text("notification delivered")] } }]);
    await f.channel.conversation.storage.append(createEntry("message", { role: "user", id: "ordinary", timestamp: 1, content: "ORDINARY PRIVATE HISTORY" }));
    const outcome = await f.runtime.post(notifyWebhookEvent, {
      trigger: true,
      ifBusy: "defer",
      delivery: "channel",
      historyMode: "event",
    });
    if (outcome.kind === "run") await outcome.done;
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.prompts)).not.toContain("ORDINARY PRIVATE HISTORY");
    expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text)).toEqual([
      "notification delivered",
    ]);
  });
  it("silent notify events block authored sending and cannot read ordinary history", async () => {
    const f = await fixture([{ toolName: "send_message", input: { parts: [text("must not send")] } }, finish]);
    await f.channel.conversation.storage.append(createEntry("message", { role: "user", id: "ordinary", timestamp: 1, content: "ORDINARY PRIVATE HISTORY" }));
    const outcome = await f.runtime.post(notifyWebhookEvent, { trigger: true, ifBusy: "defer", delivery: "silent", historyMode: "event" });
    if (outcome.kind === "run") await outcome.done;
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(f.prompts)).not.toContain("ORDINARY PRIVATE HISTORY");
  });
});

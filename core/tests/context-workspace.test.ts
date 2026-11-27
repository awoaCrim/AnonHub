import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { AgentRequestProjection, createAgent, createEntry, createUserMessage, type AgentModelRequestContext } from "@yesimbot/agent-runtime";
import { textPart } from "@yesimbot/contracts/parts";
import { parseConfig } from "@yesimbot/foundation";
import { jsonSchema, type ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createContextWorkspaceTools, createFinishTool } from "../src/agents/tools.js";
import { Channel } from "../src/channels/index.js";
import { moduleConfig } from "../src/config.js";
import { Conversation } from "../src/conversations/index.js";
import { createInternalHistoryProjectionPlugin } from "../src/conversations/internal-history.js";
import { createMessage } from "../src/messages/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { ContextWorkspace } from "../src/runtimes/context-workspace.js";
import { createModelInputPlugin, mergeAdjacentUserMessages } from "../src/runtimes/model-input.js";
import { TestEvents } from "./helpers/index.js";

const roots: string[] = [];
const workspaces: ContextWorkspace[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const workspace of workspaces.splice(0)) workspace.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const draft = JSON.stringify({
  tiers: { P1: "已确认目标和约束，下一步继续核对原文。", P2: "已确认目标约束，待核对原文。", P3: "保留目标，待核对。", P4: "待核对。" },
  importance: 0.8,
});
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function historian(blocked?: ReturnType<typeof latch>, text = draft) {
  const entered = latch();
  const generate = vi.fn(async (_options: LanguageModelV3CallOptions) => {
    entered.release();
    await blocked?.promise;
    return {
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: { inputTokens: { total: 999999, noCache: 999999, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    };
  });
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "historian",
    modelId: "historian",
    supportedUrls: {},
    doGenerate: generate,
    doStream: async () => {
      throw new Error("unexpected stream");
    },
  };
  return { model, generate, entered };
}

function mainModel(script: readonly { name: string; input: () => string; usage?: number }[] = []) {
  const calls: LanguageModelV3CallOptions[] = [];
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "main",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unexpected generate");
    },
    async doStream(options) {
      const action = script[calls.length];
      calls.push(structuredClone(options));
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (action) controller.enqueue({ type: "tool-call", toolCallId: `call_${calls.length}`, toolName: action.name, input: action.input() });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: action ? "tool-calls" : "stop", raw: undefined },
              usage: {
                inputTokens: { total: action?.usage ?? 100, noCache: action?.usage ?? 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
  return { model, calls };
}

async function fixture(texts = ["已结束的历史原文"], extra: Partial<ConstructorParameters<typeof ContextWorkspace>[2]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-magic-"));
  roots.push(root);
  const conversation = new Conversation(root);
  await conversation.init();
  const entries = texts.map((content, index) =>
    createEntry("message", { id: `old_${index}`, timestamp: index + 1, role: "user", content }, { id: `old_${index}`, timestamp: index + 1 }),
  );
  await conversation.storage.append(...entries);
  const projection = new AgentRequestProjection();
  const { model, calls } = mainModel();
  const workspace = new ContextWorkspace(conversation, projection, {
    config: {},
    // The output reserve is fixed at 8192; a 1000-token model output limit keeps these budgets small.
    modelLimit: { context: 300000, output: 1000 },
    model,
    ...extra,
  });
  workspaces.push(workspace);
  workspace.capture(entries);
  return { root, conversation, entries, projection, model, calls, workspace };
}

function context(
  f: Awaited<ReturnType<typeof fixture>>,
  turnId = "turn",
  stepNumber = 0,
  more: ModelMessage[] = [],
  historyMode: "conversation" | "event" = "conversation",
): AgentModelRequestContext {
  const live: ModelMessage = { role: "user", content: "当前问题" };
  f.projection.register(live, { kind: "live", sourceEntryIds: ["live"] });
  const history: ModelMessage[] = f.entries.map((entry) => {
    const message: ModelMessage = { role: "user", content: entry.data.role === "user" ? String(entry.data.content) : "" };
    f.projection.register(message, { kind: "history", sourceEntryIds: [entry.id], timestamp: entry.timestamp });
    return message;
  });
  return {
    model: f.model,
    system: "system",
    messages: historyMode === "event" ? [live, ...more] : [...history, live, ...more],
    tools: {},
    currentMessageIds: ["live"],
    projection: f.projection,
    historyMode,
    turnId,
    stepNumber,
    signal: new AbortController().signal,
    rebuildMessages: async () => [],
  };
}
const many = () => Array.from({ length: 90 }, (_, index) => `历史${index}:` + "x".repeat(4000));
async function settled(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() => expect(f.workspace.status().backgroundActive).toBe(false), { timeout: 5000 });
}

describe("asynchronous Magic workspace", () => {
  it("keeps more than twenty messages and history beyond the old 20k budget without a measured trigger", async () => {
    const aux = historian();
    const f = await fixture(many(), { historianModel: aux.model });
    const result = await f.workspace.guard(context(f));
    expect(result).toHaveLength(91);
    expect(JSON.stringify(result)).toContain("历史0:");
    expect(aux.generate).not.toHaveBeenCalled();
    expect(await f.conversation.contextRegions()).toHaveLength(0);
  });
  it("99999 does not trigger; 100000 starts outside the foreground and storage FIFO; next request adopts ready", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { historianModel: aux.model });
    const original = await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 99999);
    expect(aux.generate).not.toHaveBeenCalled();
    await f.workspace.guard(context(f, "turn", 1));
    f.workspace.observeUsage("turn", 1, 100000);
    await aux.entered.promise;
    const newEntry = createEntry("message", createUserMessage("并发到达的新消息"));
    await f.conversation.storage.append(newEntry);
    const during = await f.workspace.guard(context(f, "turn", 2));
    expect(JSON.stringify(during)).toContain("历史0:");
    expect(aux.generate).toHaveBeenCalledTimes(1);
    block.release();
    await settled(f);
    expect((await f.conversation.storage.read()).some((entry) => entry.id === newEntry.id)).toBe(true);
    const next = await f.workspace.guard(context(f, "turn", 3));
    expect(JSON.stringify(next)).toContain("context_region");
    expect(JSON.stringify(next)).not.toContain("历史0:");
    expect(JSON.stringify(next)).toContain("历史89:");
    expect(JSON.stringify(original)).toContain("历史0:");
    expect(f.workspace.status().providerInputTokens).toBe(100000); // auxiliary 999999 never enters policy
    const count = aux.generate.mock.calls.length;
    await f.workspace.guard(context(f, "turn", 4));
    expect(aux.generate).toHaveBeenCalledTimes(count);
  });
  it("starts at a configured trigger and has the main model review each range once before its summary commits", async () => {
    const aux = historian();
    const gate = latch();
    const reviews: { messages: string; sourceEntryIds: readonly string[] }[] = [];
    const f = await fixture(many(), {
      historianModel: aux.model,
      config: { triggerTokens: 14000 },
      reviewBeforeRegion: async ({ request, sourceEntryIds }) => {
        reviews.push({ messages: JSON.stringify(request.messages), sourceEntryIds });
        await gate.promise;
      },
    });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 13999);
    expect(aux.generate).not.toHaveBeenCalled();
    await f.workspace.guard(context(f, "turn", 1, [{ role: "assistant", content: "STEP ONE REPLY" }]));
    f.workspace.observeUsage("turn", 1, 14000);
    await aux.entered.promise;
    // The summary is ready but waits for the review, which reuses the request that just returned.
    await vi.waitFor(() => expect(reviews).toHaveLength(1));
    expect(reviews[0]!.messages).toContain("STEP ONE REPLY");
    expect(reviews[0]!.messages).toContain("历史0:");
    expect(reviews[0]!.sourceEntryIds.every((id) => id.startsWith("old_"))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await f.conversation.contextRegions()).toHaveLength(0);
    gate.release();
    await settled(f);
    const regions = await f.conversation.contextRegions();
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.flatMap((region) => region.data.sourceEntryIds).every((id) => reviews[0]!.sourceEntryIds.includes(id))).toBe(true);
    expect(f.workspace.status().historyBudget).toBeCloseTo(11200 * 0.2);
  });
  it("commits even when the review fails and never reviews the same sources twice", async () => {
    const aux = historian();
    const review = vi.fn(async () => {
      throw new Error("review failure");
    });
    const f = await fixture(many(), { historianModel: aux.model, config: { triggerTokens: 14000 }, reviewBeforeRegion: review });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 14000);
    await settled(f);
    expect(review).toHaveBeenCalledTimes(1);
    expect((await f.conversation.contextRegions()).length).toBeGreaterThan(0);
    const reviewed = new Set((review.mock.calls[0] as unknown as [{ sourceEntryIds: string[] }])[0].sourceEntryIds);
    await f.workspace.guard(context(f, "turn", 1));
    f.workspace.observeUsage("turn", 1, 14000);
    await settled(f);
    for (const call of review.mock.calls.slice(1) as unknown as [{ sourceEntryIds: string[] }][])
      expect(call[0].sourceEntryIds.some((id) => reviewed.has(id))).toBe(false);
  });
  it("does not review event-only requests", async () => {
    const aux = historian();
    const review = vi.fn(async () => {});
    const f = await fixture(many(), { historianModel: aux.model, config: { triggerTokens: 14000 }, reviewBeforeRegion: review });
    await f.workspace.guard(context(f, "event-turn", 0, [], "event"));
    f.workspace.observeUsage("event-turn", 0, 14000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(review).not.toHaveBeenCalled();
  });
  it("does not move raw coverage after invalid historian output and does not retry every step", async () => {
    const aux = historian(undefined, "not-json");
    const f = await fixture(many(), { historianModel: aux.model });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 100000);
    await aux.entered.promise;
    await settled(f);
    expect(await f.conversation.contextRegions()).toHaveLength(0);
    expect(JSON.stringify(await f.workspace.guard(context(f, "turn", 1)))).toContain("历史0:");
    expect(aux.generate).toHaveBeenCalledTimes(2);
    expect(f.workspace.status().historianProgress).toMatchObject({ reason: "retry-exhausted", generationAttempts: 2, attemptedBatches: 1 });
  });
  it("admits fixed mandatory overflow without waiting for an impossible summary", async () => {
    const f = await fixture([], { modelLimit: { context: 10000, output: 1000 } });
    await expect(f.workspace.guard(context(f, "turn", 0, [{ role: "assistant", content: "x".repeat(100000) }]))).resolves.toHaveLength(2);
    expect(f.workspace.status().estimatedInputTokens).toBeGreaterThan(f.workspace.status().inputBudget);
  });
  it.each([false, true])("keeps committed history projected during mandatory overflow (previous request: %s)", async (previousRequest) => {
    const aux = historian();
    const f = await fixture([...Array.from({ length: 5 }, (_, index) => `COVERED_RAW_${index}:` + "h".repeat(40000)), "UNSUMMARIZED history"], {
      modelLimit: { context: 30000, output: 1000 },
      historianModel: aux.model,
    });
    for (const entry of f.entries.slice(0, 5)) {
      await f.conversation.commitContextRegion(await f.conversation.freezeContextRegion([entry.id]), JSON.parse(draft));
    }
    let previousBytes = 0;
    if (previousRequest) {
      const previous = await f.workspace.guard(context(f, "turn", 0, [{ role: "assistant", content: "LIVE:" + "l".repeat(103000) }]));
      expect(JSON.stringify(previous).includes("COVERED_RAW_")).toBe(false);
      previousBytes = Buffer.byteLength(JSON.stringify(previous));
    }
    const live: ModelMessage = { role: "assistant", content: "LIVE:" + "l".repeat(105000) };
    const result = await f.workspace.guard(context(f, "turn", 1, [live]));
    expect(JSON.stringify(result).includes("COVERED_RAW_")).toBe(false);
    expect(JSON.stringify(result)).toContain("UNSUMMARIZED history");
    expect(result).toContainEqual(live);
    expect(result).toContainEqual({ role: "user", content: "当前问题" });
    expect(f.workspace.status().estimatedInputTokens).toBeGreaterThan(f.workspace.status().inputBudget);
    if (previousRequest) expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(previousBytes + 4000);
    expect(aux.generate).not.toHaveBeenCalled();
    expect((await f.conversation.storage.read()).filter((entry) => entry.type === "message")).toEqual(f.entries);
  });
  it("limits a safety episode to sixty seconds, retains late commits without a late request", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { historianModel: aux.model, modelLimit: { context: 100000, output: 1000 } });
    vi.useFakeTimers();
    const pending = f.workspace.guard(context(f));
    const outcome = pending.then(
      () => "accepted",
      (error: Error) => error.message,
    );
    await aux.entered.promise;
    await vi.advanceTimersByTimeAsync(59999);
    expect(f.workspace.status().historian).toBe("generating");
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("accepted");
    vi.useRealTimers();
    block.release();
    await settled(f);
    expect((await f.conversation.contextRegions()).length).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(0);
  });
  it("does not reuse a later sample from the old view after ready coverage is adopted", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { historianModel: aux.model });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 100000);
    await aux.entered.promise;
    await f.workspace.guard(context(f, "turn", 1));
    f.workspace.observeUsage("turn", 1, 100000);
    block.release();
    await settled(f);
    const calls = aux.generate.mock.calls.length;
    await f.workspace.guard(context(f, "turn", 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aux.generate).toHaveBeenCalledTimes(calls);
    expect(f.workspace.status().backgroundActive).toBe(false);
  });
  it("does not let event usage calibrate or trigger the following ordinary conversation", async () => {
    const aux = historian();
    const f = await fixture(many(), { historianModel: aux.model });
    await f.workspace.guard(context(f, "event", 0, [], "event"));
    f.workspace.observeUsage("event", 0, 100000);
    expect(f.workspace.status().providerInputTokens).toBeUndefined();
    expect(f.workspace.status().estimateMultiplier).toBe(0.25);
    await f.workspace.guard(context(f, "ordinary"));
    expect(aux.generate).not.toHaveBeenCalled();
  });
  it("includes post-progress storage reads in the same sixty-second safety deadline", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { historianModel: aux.model, modelLimit: { context: 100000, output: 1000 } });
    const readBlock = latch();
    const readEntered = latch();
    vi.useFakeTimers();
    const pending = f.workspace.guard(context(f));
    const outcome = pending.then(
      () => "accepted",
      (error: Error) => error.message,
    );
    await aux.entered.promise;
    const original = f.conversation.contextRegions.bind(f.conversation);
    vi.spyOn(f.conversation, "contextRegions").mockImplementationOnce(async () => {
      readEntered.release();
      await readBlock.promise;
      return original();
    });
    block.release();
    await readEntered.promise;
    await vi.advanceTimersByTimeAsync(60000);
    expect(await outcome).toBe("accepted");
    readBlock.release();
    vi.useRealTimers();
    await settled(f);
  });
  it("consumes a delayed source rejection when cancellation wins before the deadline wrapper attaches", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const blocked = latch();
    const finished = latch();
    vi.spyOn(f.conversation, "contextRegions").mockImplementationOnce(() => {
      controller.abort();
      return blocked.promise.then(() => {
        finished.release();
        throw new Error("late source failure");
      });
    });
    await expect(f.workspace.guard({ ...context(f), signal: controller.signal })).rejects.toThrow("context_stopped");
    blocked.release();
    await finished.promise;
    // Let Node report an unhandled rejection if the started read was abandoned.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  it("stop invalidates an in-flight historian before it can commit", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { historianModel: aux.model });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 100000);
    await aux.entered.promise;
    f.workspace.stop();
    block.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await f.conversation.contextRegions()).toHaveLength(0);
  });
  it("event-only neither injects normal regions nor starts work and denies context tools", async () => {
    const aux = historian();
    const f = await fixture(many(), { historianModel: aux.model });
    const messages = await f.workspace.guard(context(f, "event", 0, [], "event"));
    f.workspace.observeUsage("event", 0, 100000);
    expect(messages).toHaveLength(1);
    expect(aux.generate).not.toHaveBeenCalled();
    await expect(f.workspace.blocks({})).rejects.toThrow("context_event_history_isolated");
  });
  it("returns bounded bodies directly with stable paging, no page leases, and protects unsummarized raw", async () => {
    const f = await fixture(["🙂<&历史>".repeat(5000)]);
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const first = await f.workspace.load({ blockId: id });
    expect(first.records.length).toBeGreaterThan(0);
    expect(first.records[0]!.text).toContain("<&历史>");
    expect(first).toMatchObject({ readonly: true, status: "historical-data" });
    expect(first.nextCursor).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThan(65000);
    const second = await f.workspace.load({ blockId: id, cursor: first.nextCursor });
    expect(second.pageId).not.toBe(first.pageId);
    await expect(f.workspace.load({ blockId: id, cursor: "forged" })).rejects.toThrow("context_cursor_invalid");
    expect(await f.workspace.release(id)).toMatchObject({ state: "held" });
    expect(await f.workspace.release(id)).toMatchObject({ alreadyReleased: true });
    expect(f.workspace.status().loadedBlocks).toBe(0);
    expect(JSON.stringify(await f.workspace.guard(context(f, "later")))).not.toContain("context_block");
  });
  it("bounds simultaneous expansions by one shared remaining request allowance", async () => {
    const f = await fixture(['\\"\\n'.repeat(8000), "other".repeat(4000)], { modelLimit: { context: 50000, output: 1000 } });
    await f.workspace.guard(context(f, "turn", 0, [{ role: "assistant", content: "x".repeat(80000) }]));
    const blocks = (await f.workspace.blocks({})).blocks;
    const results = await Promise.allSettled(blocks.map((block) => f.workspace.load({ blockId: block.id })));
    const successful = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const available = f.workspace.status().inputBudget - f.workspace.status().estimatedInputTokens;
    expect(successful.length).toBeGreaterThan(0);
    expect(successful.reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result), "utf8") * 0.25, 0)).toBeLessThanOrEqual(available);
  });
  it("reduces committed summaries at a request boundary without deleting source and expands them again", async () => {
    const aux = historian();
    const f = await fixture(many(), { historianModel: aux.model });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 100000);
    await aux.entered.promise;
    await settled(f);
    await f.workspace.guard(context(f, "turn", 1));
    const region = (await f.conversation.contextRegions())[0]!;
    expect(await f.workspace.release(region.id)).toMatchObject({ state: "pending" });
    const view = await f.workspace.guard(context(f, "turn", 2));
    expect(view.some((message) => String(message.content).includes(`source="${region.id}"`))).toBe(false);
    expect(await f.workspace.release(region.id)).toMatchObject({ state: "applied", alreadyReleased: true });
    const page = await f.workspace.load({ blockId: region.id });
    expect(JSON.stringify(page.records)).toContain("历史0:");
    expect((await f.conversation.contextRegions()).some((entry) => entry.id === region.id)).toBe(true);
  });
  it("does not revive a stopped workspace after delayed source reads", async () => {
    const f = await fixture();
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const entered = latch();
    const blocked = latch();
    const original = f.conversation.contextSources.bind(f.conversation);
    vi.spyOn(f.conversation, "contextSources").mockImplementationOnce(async () => {
      entered.release();
      await blocked.promise;
      return original();
    });
    const pending = f.workspace.load({ blockId: id });
    await entered.promise;
    f.workspace.stop();
    blocked.release();
    await expect(pending).rejects.toThrow("context_read_stale");
  });
  it.each([
    [undefined, 125_000],
    [8000, 10_000],
    [14_000, 17_500],
  ])("derives capacity from the trigger (%s) when the model has no known limit", async (trigger, inputBudget) => {
    const f = await fixture([], { modelLimit: undefined, config: trigger === undefined ? {} : { triggerTokens: trigger } });
    await f.workspace.guard(context(f));
    expect(f.workspace.status()).toMatchObject({ inputBudget, outputReserveTokens: 8192 });
    expect(f.workspace.status().inputBudget).toBeGreaterThan(trigger ?? 100_000);
  });
  it("ignores a retired contextWindow left in an old config", async () => {
    const f = await fixture([], { modelLimit: undefined, config: { contextWindow: 20000 } as never });
    await f.workspace.guard(context(f));
    expect(f.workspace.status()).toMatchObject({ inputBudget: 125_000 });
  });
  it("calibrates only a matching main request and updates output caps when the model limit changes", async () => {
    let limit = { context: 50000, output: 1000 };
    const f = await fixture(undefined, { modelLimit: limit, resolveModelLimit: () => limit });
    await f.workspace.guard(context(f));
    const estimate = f.workspace.status().estimatedInputTokens;
    f.workspace.observeUsage("other", 0, estimate * 2);
    expect(f.workspace.status().estimateMultiplier).toBe(0.25);
    f.workspace.observeUsage("turn", 0, estimate * 2);
    expect(f.workspace.status().estimateMultiplier).toBeCloseTo(0.5, 1);
    limit = { context: 40000, output: 500 };
    await f.workspace.guard(context(f, "changed"));
    expect(f.workspace.status()).toMatchObject({ contextWindow: 40000, outputReserveTokens: 500, estimateMultiplier: 0.25 });
  });
});

function toolPair(text: string, id = "lookup"): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "lookup", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "lookup", output: { type: "text", value: text } }] },
  ];
}

describe("provisional tool-result safety", () => {
  it("keeps changed tool results provisional until a matching usage sample, without accumulating premiums", async () => {
    const f = await fixture([]);
    const original = toolPair("A".repeat(4000));
    await f.workspace.guard(context(f, "turn", 0, original));
    const initial = f.workspace.status().estimatedInputTokens;
    f.workspace.observeUsage("turn", 0, 500);
    await f.workspace.guard(context(f, "turn", 1, structuredClone(original)));
    expect(f.workspace.status().estimatedInputTokens).toBe(500);
    const changed = toolPair("B".repeat(4000));
    await f.workspace.guard(context(f, "turn", 2, changed));
    const provisional = f.workspace.status().estimatedInputTokens;
    expect(provisional).toBeGreaterThan(2000);
    expect(provisional).toBeLessThanOrEqual(initial);
    f.workspace.observeUsage("other", 2, 1);
    f.workspace.observeUsage("turn", 1, 1);
    await f.workspace.guard(context(f, "turn", 3, changed));
    expect(f.workspace.status().estimatedInputTokens).toBe(provisional);
    f.workspace.observeUsage("turn", 3, 700);
    await f.workspace.guard(context(f, "turn", 4, changed));
    expect(f.workspace.status().estimatedInputTokens).toBe(700);
    await f.workspace.guard(context(f, "turn", 5, changed));
    expect(f.workspace.status().estimatedInputTokens).toBe(700);
  });

  it("does not acknowledge aborted or event-only tool samples", async () => {
    const f = await fixture([]);
    const more = toolPair("x".repeat(4000));
    const controller = new AbortController();
    await f.workspace.guard({ ...context(f, "cancelled", 0, more), signal: controller.signal });
    const initial = f.workspace.status().estimatedInputTokens;
    controller.abort();
    f.workspace.observeUsage("cancelled", 0, 1);
    await f.workspace.guard(context(f, "event", 0, more, "event"));
    f.workspace.observeUsage("event", 0, 1);
    await f.workspace.guard(context(f, "normal", 0, more));
    expect(f.workspace.status().estimatedInputTokens).toBe(initial);
    expect(f.workspace.status().estimateMultiplier).toBe(0.25);
  });

  it("clears measured tool identities when the model budget changes", async () => {
    let limit = { context: 50000, output: 1000 };
    const f = await fixture([], { resolveModelLimit: () => limit });
    const more = toolPair("x".repeat(4000));
    await f.workspace.guard(context(f, "turn", 0, more));
    const initial = f.workspace.status().estimatedInputTokens;
    f.workspace.observeUsage("turn", 0, 500);
    await f.workspace.guard(context(f, "turn", 1, more));
    expect(f.workspace.status().estimatedInputTokens).toBe(500);
    limit = { context: 60000, output: 1000 };
    await f.workspace.guard(context(f, "changed", 0, more));
    expect(f.workspace.status().estimatedInputTokens).toBe(initial);
  });

  it("admits provisional costs in mandatory-only requests without starting impossible recovery", async () => {
    const f = await fixture([], { modelLimit: { context: 10000, output: 1000 } });
    // ~20KB previously fit at0.25 but cannot fit8k safe input at the provisional0.5.
    await expect(f.workspace.guard(context(f, "turn", 0, toolPair("x".repeat(20000))))).resolves.toHaveLength(3);
    expect(f.workspace.status().backgroundActive).toBe(false);
    expect(f.workspace.status().estimatedInputTokens).toBeGreaterThan(f.workspace.status().inputBudget);
  });

  it("clamps auxiliary output independently of the main reserve and rejects invalid limits without retries", async () => {
    for (const output of [321, -1]) {
      const aux = historian();
      const f = await fixture(many(), {
        historianModel: aux.model,
        resolveModelLimit: (model) => (typeof model !== "string" && model.provider === "historian" ? { context: 100000, output } : undefined),
      });
      await f.workspace.guard(context(f));
      f.workspace.observeUsage("turn", 0, 100000);
      await settled(f);
      if (output > 0) {
        expect(aux.generate.mock.calls[0]![0].maxOutputTokens).toBe(321);
        expect((await f.conversation.contextRegions()).length).toBeGreaterThan(0);
      } else {
        expect(aux.generate).not.toHaveBeenCalled();
        expect(f.workspace.status().historianProgress).toMatchObject({ reason: "non-retryable", code: "model-limit", generationAttempts: 1 });
        expect(await f.conversation.contextRegions()).toHaveLength(0);
      }
    }
  });

  it("recovers before a real SDK continuation with a large tool result, preserving the result and complete pair", async () => {
    const blocked = latch();
    const aux = historian(blocked);
    const diagnostics: Record<string, number | string>[] = [];
    const f = await fixture(many(), {
      historianModel: aux.model,
      modelLimit: undefined,
      onDiagnostic: (value) => diagnostics.push(value),
      mergeMessages: mergeAdjacentUserMessages,
    });
    const body = "PRIVATE_TOOL_ONLY:" + "网页详情：".repeat(6000);
    const scripted = mainModel([
      { name: "lookup", input: () => "{}", usage: 98378 },
      { name: "finish", input: () => "{}", usage: 80000 },
    ]);
    const agent = createAgent({
      model: scripted.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      beforeModelRequest: (request) => f.workspace.guard(request),
      onModelUsage: ({ turnId, stepNumber, inputTokens }) => f.workspace.observeUsage(turnId, stepNumber, inputTokens),
      tools: [{ name: "lookup", description: "Returns a large page", inputSchema: z.object({}), execute: async () => body }, createFinishTool()],
      requireTerminalTool: true,
      plugins: [
        {
          name: "capture",
          enforce: "pre",
          transformEntries(entries) {
            f.workspace.capture(entries);
            return entries;
          },
        },
        createInternalHistoryProjectionPlugin("gemini-native", f.projection),
      ],
    });
    const run = Array.fromAsync(agent.run(createUserMessage("current question")));
    await aux.entered.promise;
    expect(scripted.calls).toHaveLength(1); // The risky continuation has not reached the provider.
    expect(diagnostics.some((value) => value.event === "guard.estimate" && value.reason === "unsafe" && Number(value.estimatedInputTokens) > 124288)).toBe(
      true,
    );
    expect(JSON.stringify(aux.generate.mock.calls)).not.toContain("PRIVATE_TOOL_ONLY");
    blocked.release();
    const events = await run;
    await settled(f);
    expect(events.at(-1)).toMatchObject({ type: "turn.done" });
    expect(scripted.calls).toHaveLength(2);
    expect((await f.conversation.contextRegions()).length).toBeGreaterThan(0);
    const prompt = scripted.calls[1]!.prompt;
    expect(JSON.stringify(prompt)).toContain(body);
    const calls = prompt.flatMap((message) =>
      message.role === "assistant" ? message.content.filter((part) => part.type === "tool-call").map((part) => part.toolCallId) : [],
    );
    const results = prompt.flatMap((message) =>
      message.role === "tool" ? message.content.filter((part) => part.type === "tool-result").map((part) => part.toolCallId) : [],
    );
    expect(results).toEqual(calls);
    expect(results).toContain("call_1");
    const continuationEstimates = diagnostics.filter((value) => value.step === 1 && value.event === undefined);
    expect(continuationEstimates.length).toBeGreaterThan(0);
    expect(continuationEstimates.every((value) => Number(value.estimatedInputTokens) <= 124288)).toBe(true);
  });
});

describe("real Agent provider boundary", () => {
  it("wires the actual Core Gemini pipeline and a single Magic controller", async () => {
    const f = await fixture(Array.from({ length: 100 }, (_, i) => `历史${i}:` + "x".repeat(600)));
    const channel = new Channel({ type: "guild", platform: "mock", channelId: "room", guildId: "room" }, f.root);
    await channel.conversation.init();
    const scripted = mainModel([
      { name: "ctx_search", input: () => '{"query":"历史0"}', usage: 150001 },
      { name: "finish", input: () => "{}", usage: 150001 },
    ]);
    const aux = historian();
    const bot = { selfId: "bot", sendMessage: vi.fn() };
    const runtime = new ChannelRuntime(new TestEvents(), {
      channel,
      bot: bot as never,
      will: { decide: async () => "trigger", observe: async () => {} } as never,
      model: scripted.model,
      historianModel: aux.model,
      readImagePolicy: { mode: "unavailable" },
      historyProjection: "gemini-native",
      config: parseConfig(moduleConfig, {
        basePath: f.root,
        chatModel: "mock:main",
        logLevel: 0,
        modelRetries: 0,
        session: { archive: { maxKB: 0 }, magicContext: {} },
      } as never),
      plugins: [
        {
          name: "mandatory-plugin",
          prepareStep(messages) {
            return [...messages, { role: "assistant", content: "PLUGIN mandatory" }];
          },
        },
      ],
    });
    try {
      await runtime.init();
      const result = await runtime.handle({
        platform: "mock",
        selfId: "bot",
        channel: { id: "room", type: 0 },
        user: { id: "u", name: "User" },
        messageId: "current",
        timestamp: 102,
        parts: [textPart("CURRENT new request")],
      });
      expect(result.kind).toBe("run");
      if (result.kind === "run") await result.done;
      expect(scripted.calls).toHaveLength(2);
      for (const request of scripted.calls) {
        expect(request.maxOutputTokens).toBe(8192);
        expect(JSON.stringify(request.prompt)).toContain("CURRENT new request");
        expect(JSON.stringify(request.prompt)).toContain("PLUGIN mandatory");
        const start = request.prompt.findIndex((message) => message.role !== "system");
        expect(request.prompt.slice(start).some((message) => message.role === "system")).toBe(false);
        expect(request.tools?.filter((tool) => tool.type === "function" && tool.name === "ctx_expand")).toHaveLength(1);
      }
      expect(JSON.stringify(scripted.calls[1]!.prompt)).toContain("历史0:");
      await aux.entered.promise;
      expect(aux.generate).toHaveBeenCalled();
      expect(bot.sendMessage).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });
  it("reviews a range through plugins with its chat message IDs only, running just the offered review tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-region-review-"));
    roots.push(root);
    const context = { type: "guild", platform: "mock", channelId: "room", guildId: "room", selfId: "bot" } as const;
    const channel = new Channel(context, root);
    await channel.conversation.init();
    const record = (messageId: string, timestamp: number) => ({
      platform: "mock",
      selfId: "bot",
      channel: { id: "room", type: 0 },
      user: { id: "u", name: "User" },
      messageId,
      timestamp,
      parts: [textPart("原文 " + messageId)],
    });
    const covered = [
      createEntry("message", createMessage(record("m1", 5)), { timestamp: 5 }),
      createEntry("message", createMessage(record("m2", 7)), { timestamp: 7 }),
    ];
    const plain = createEntry("message", createUserMessage("not a chat record"));
    await channel.conversation.storage.append(...covered, createEntry("message", createMessage(record("later", 9))), plain);
    const prompts: LanguageModelV3CallOptions[] = [];
    const reviewModel: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "mock",
      modelId: "review",
      supportedUrls: {},
      doGenerate: async (options) => {
        prompts.push(structuredClone(options));
        const first = prompts.length === 1;
        return {
          content: first
            ? [
                { type: "text" as const, text: "这段话不会发出去" },
                { type: "tool-call" as const, toolCallId: "c1", toolName: "send_message", input: JSON.stringify({ messages: ["hi"] }) },
                { type: "tool-call" as const, toolCallId: "c2", toolName: "remember", input: JSON.stringify({ content: "u 喜欢猫" }) },
              ]
            : [{ type: "tool-call" as const, toolCallId: "c3", toolName: "finish", input: "{}" }],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: { inputTokens: { total: 500, noCache: 100, cacheRead: 400, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        };
      },
      doStream: async () => {
        throw new Error("unexpected stream");
      },
    };
    const ranges: unknown[] = [];
    const remembered: unknown[] = [];
    const sendMessage = vi.fn();
    const runtime = new ChannelRuntime(new TestEvents(), {
      channel,
      bot: { selfId: "bot", sendMessage } as never,
      will: { decide: async () => "trigger", observe: async () => {} } as never,
      model: mainModel().model,
      readImagePolicy: { mode: "unavailable" },
      config: parseConfig(moduleConfig, {
        basePath: root,
        chatModel: "mock:main",
        logLevel: 0,
        modelRetries: 0,
        session: { archive: { maxKB: 0 }, magicContext: {} },
      } as never),
      plugins: [
        {
          name: "memory",
          beforeContextRegion: (range: { messageIds: string[]; sourceStartAt: number; sourceEndAt: number }) => {
            ranges.push({ messageIds: range.messageIds, sourceStartAt: range.sourceStartAt, sourceEndAt: range.sourceEndAt });
            return {
              instructions: "REVIEW INSTRUCTION",
              tools: [
                {
                  name: "remember",
                  execute: async (input: unknown) => {
                    remembered.push(input);
                    return { saved: true };
                  },
                },
                { name: "not_offered", execute: async () => remembered.push("never") },
              ],
            };
          },
        } as never,
      ],
    });
    const tool = (name: string) => ({ type: "function" as const, description: name, inputSchema: jsonSchema({ type: "object" }), execute: vi.fn() });
    const tools = { remember: tool("remember"), send_message: tool("send_message"), finish: tool("finish") };
    try {
      await (runtime as unknown as { reviewBeforeRegion(input: unknown): Promise<void> }).reviewBeforeRegion({
        request: {
          model: reviewModel,
          system: "SYSTEM",
          messages: [
            { role: "assistant", content: "earlier" },
            { role: "user", content: "LAST USER" },
          ],
          tools,
        },
        sourceEntryIds: [...covered.map((entry) => entry.id), plain.id],
        signal: new AbortController().signal,
      });
      expect(ranges).toEqual([{ messageIds: ["m1", "m2"], sourceStartAt: 5, sourceEndAt: 7 }]);
      expect(remembered).toEqual([{ content: "u 喜欢猫" }]);
      expect(sendMessage).not.toHaveBeenCalled();
      for (const entry of Object.values(tools)) expect(entry.execute).not.toHaveBeenCalled();
      expect(prompts).toHaveLength(2);
      // Same tools as the main request; the instruction joins the trailing user message instead of adding another.
      expect(prompts[0]!.tools?.map((entry) => (entry as { name: string }).name).sort()).toEqual(["finish", "remember", "send_message"]);
      const users = prompts[0]!.prompt.filter((message) => message.role === "user");
      expect(users).toHaveLength(1);
      expect(JSON.stringify(users[0])).toContain("LAST USER");
      expect(JSON.stringify(users[0])).toContain("REVIEW INSTRUCTION");
      expect(JSON.stringify(prompts[1]!.prompt)).toContain("没有执行");
    } finally {
      await runtime.stop();
    }
  });
  it("returns safe tool bodies and preserves complete Gemini tool pairs in continuations", async () => {
    const f = await fixture(["older question"]);
    await f.conversation.storage.append(
      createEntry(
        "message",
        {
          id: "sent-call",
          timestamp: 2,
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "old-send", toolName: "send_message", input: { messages: ["older delivered reply"], inner_thought: "PRIVATE" } },
          ],
        },
        { id: "sent-call", timestamp: 2 },
      ),
      createEntry(
        "message",
        {
          id: "sent-result",
          timestamp: 3,
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "old-send",
              toolName: "send_message",
              output: { type: "json", value: { ok: true, count: 1, messageIds: ["platform-id"] } },
            },
          ],
        },
        { id: "sent-result", timestamp: 3 },
      ),
    );
    f.workspace.capture(await f.conversation.storage.read());
    await f.workspace.guard(context(f));
    const blockId = (await f.workspace.blocks({})).blocks[0]!.id;
    const scripted = mainModel([
      { name: "ctx_expand", input: () => JSON.stringify({ blockId }) },
      { name: "finish", input: () => "{}" },
    ]);
    const agent = createAgent({
      model: scripted.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      beforeModelRequest: (request) => f.workspace.guard(request),
      onModelUsage: ({ turnId, stepNumber, inputTokens }) => f.workspace.observeUsage(turnId, stepNumber, inputTokens),
      tools: [...createContextWorkspaceTools(f.workspace), createFinishTool()],
      requireTerminalTool: true,
      plugins: [
        {
          name: "capture",
          enforce: "pre",
          transformEntries(entries) {
            f.workspace.capture(entries);
            return entries;
          },
        },
        createInternalHistoryProjectionPlugin("gemini-native", f.projection),
      ],
    });
    const events = await Array.fromAsync(agent.run(createUserMessage("current question")));
    expect(events.at(-1)).toMatchObject({ type: "turn.done" });
    expect(scripted.calls).toHaveLength(2);
    const continuation = scripted.calls[1]!.prompt;
    expect(JSON.stringify(continuation)).toContain("historical-data");
    expect(JSON.stringify(continuation)).toContain("older delivered reply");
    expect(JSON.stringify(continuation)).not.toContain("PRIVATE");
    const calls = continuation.flatMap((message) =>
      message.role === "assistant" ? message.content.filter((part) => part.type === "tool-call").map((part) => part.toolCallId) : [],
    );
    const results = continuation.flatMap((message) =>
      message.role === "tool" ? message.content.filter((part) => part.type === "tool-result").map((part) => part.toolCallId) : [],
    );
    expect(results).toEqual(calls);
    expect(calls).toContain("old-send");
    expect(calls).toContain("call_1");
    expect(JSON.stringify(await f.conversation.storage.read())).toContain("historical-data"); // bounded ordinary tool receipt, not a hidden second body cache
  });
  it("keeps default-provider delivered transcripts independently eligible and commits complete canonical tool units", async () => {
    const blocked = latch();
    const aux = historian(blocked);
    const f = await fixture([], { historianModel: aux.model });
    for (let i = 0; i < 60; i++) {
      await f.conversation.storage.append(
        createEntry(
          "message",
          {
            id: `call_${i}`,
            timestamp: i * 2,
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: `send_${i}`, toolName: "send_message", input: { messages: [`reply ${i}:` + "x".repeat(7000)] } }],
          },
          { id: `source_call_${i}`, timestamp: i * 2 },
        ),
        createEntry(
          "message",
          {
            id: `result_${i}`,
            timestamp: i * 2 + 1,
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: `send_${i}`,
                toolName: "send_message",
                output: { type: "json", value: { ok: true, count: 1, messageIds: [`platform_${i}`] } },
              },
            ],
          },
          { id: `source_result_${i}`, timestamp: i * 2 + 1 },
        ),
      );
    }
    const scripted = mainModel([{ name: "finish", input: () => "{}", usage: 110000 }]);
    const agent = createAgent({
      model: scripted.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      tools: [createFinishTool()],
      beforeModelRequest: (request) => f.workspace.guard(request),
      onModelUsage: ({ turnId, stepNumber, inputTokens }) => f.workspace.observeUsage(turnId, stepNumber, inputTokens),
      plugins: [
        {
          name: "capture",
          enforce: "pre",
          transformEntries(entries) {
            f.workspace.capture(entries);
          },
        },
        createInternalHistoryProjectionPlugin("default", f.projection),
        createModelInputPlugin("default", true),
      ],
    });
    expect((await Array.fromAsync(agent.run(createUserMessage("current")))).at(-1)).toMatchObject({ type: "turn.done" });
    await aux.entered.promise;
    expect(scripted.calls[0]!.prompt.filter((message) => message.role === "assistant").length).toBeGreaterThan(50);
    blocked.release();
    await settled(f);
    const region = (await f.conversation.contextRegions())[0]!;
    expect(region.data.sourceEntryIds).toContain("source_call_0");
    expect(region.data.sourceEntryIds).toContain("source_result_0");
  });
  it("projects archived region semantics into the next session without regenerating history", async () => {
    const f = await fixture(["archived raw goal"]);
    await f.conversation.commitContextRegion(await f.conversation.freezeContextRegion(["old_0"]), JSON.parse(draft));
    await f.conversation.archive(false);
    const channel = new Channel({ type: "guild", platform: "mock", channelId: "room", guildId: "room" }, f.root);
    await channel.conversation.init();
    const scripted = mainModel([{ name: "finish", input: () => "{}" }]);
    const runtime = new ChannelRuntime(new TestEvents(), {
      channel,
      bot: { selfId: "bot", sendMessage: vi.fn() } as never,
      will: { decide: async () => "trigger", observe: async () => {} } as never,
      model: scripted.model,
      readImagePolicy: { mode: "unavailable" },
      plugins: [],
      config: parseConfig(moduleConfig, {
        basePath: f.root,
        chatModel: "mock:main",
        logLevel: 0,
        session: { archive: { maxKB: 0 }, magicContext: {} },
      } as never),
    });
    try {
      await runtime.init();
      const result = await runtime.handle({
        platform: "mock",
        selfId: "bot",
        channel: { id: "room", type: 0 },
        user: { id: "u", name: "User" },
        messageId: "current",
        timestamp: 102,
        parts: [textPart("CURRENT request")],
      });
      if (result.kind === "run") await result.done;
      expect(scripted.calls).toHaveLength(1);
      expect(JSON.stringify(scripted.calls[0]!.prompt)).toContain("已确认目标和约束");
      expect(JSON.stringify(scripted.calls[0]!.prompt)).not.toContain("archived raw goal");
      expect(scripted.calls[0]!.maxOutputTokens).toBe(8192);
    } finally {
      await runtime.stop();
    }
  });
  it("keeps current input and system prefix when Gemini users merge after selection", async () => {
    const f = await fixture(
      Array.from({ length: 30 }, (_, index) => `历史${index}`),
      { mergeMessages: mergeAdjacentUserMessages },
    );
    const request = context(f);
    const system: ModelMessage = { role: "system", content: "protected" };
    const messages = await f.workspace.guard({ ...request, messages: [system, ...request.messages] });
    expect(messages[0]).toBe(system);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain("当前问题");
    expect(JSON.stringify(messages)).toContain("历史0");
  });
  it("does not count native media payload bytes as text capacity", async () => {
    const f = await fixture();
    const agent = createAgent({
      model: f.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      beforeModelRequest: (request) => f.workspace.guard(request),
    });
    const events = await Array.fromAsync(agent.run(createUserMessage([{ type: "image", image: new Uint8Array(1000000), mediaType: "image/png" }])));
    expect(f.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "turn.done" });
  });
  it("exposes one expand tool, retains old facade names and redacts filesystem failures", async () => {
    const f = await fixture();
    const tools = createContextWorkspaceTools(f.workspace);
    expect(tools.filter((tool) => tool.name === "ctx_expand")).toHaveLength(1);
    expect(tools.map((tool) => tool.name)).toEqual(["ctx_search", "ctx_expand", "ctx_reduce"]);
    vi.spyOn(f.workspace, "blocks").mockRejectedValue(new Error("ENOENT C:/private/token-source"));
    const result = await tools[0]!.execute!({}, {} as never);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result).toMatchObject({ ok: false, error: { code: "context_read_failed" } });
  });
});

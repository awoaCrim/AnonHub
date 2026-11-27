import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { AgentRequestProjection, createToolMessage, type AgentMessage, type PrepareStepContext } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { Channel, type ChannelContext } from "../src/channels/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { createLongTurnPlugin, LONG_TURN_TOOL_CALLS } from "../src/runtimes/long-turn.js";
import { TestEvents, defaultConfig, defaultMessageRecord, h } from "./helpers/index.js";

const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const payload = (n: number) => `R${n}:${"x".repeat(6000)}`;

/** One assistant call and its result per tool call, as a turn's request holds them. */
function turn(names: readonly string[], prefix = "call") {
  const request: ModelMessage[] = [];
  const raw: AgentMessage[] = [];
  names.forEach((toolName, index) => {
    const toolCallId = `${prefix}-${index + 1}`;
    request.push({ role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input: {} }] });
    const content = [{ type: "tool-result" as const, toolCallId, toolName, output: { type: "text" as const, value: payload(index + 1) } }];
    request.push({ role: "tool", content });
    raw.push(createToolMessage(content));
  });
  return { request, raw };
}

function step(messages: AgentMessage[], projection?: AgentRequestProjection, turnId = "turn-1") {
  return { messages, turnId, stepNumber: 1, ...(projection ? { projection } : {}) } as unknown as PrepareStepContext;
}

const text = (messages: readonly ModelMessage[] | void) => JSON.stringify(messages ?? []);

describe("long turn: shortening older results of the current turn", () => {
  it("leaves the request alone below the trigger", async () => {
    const plugin = createLongTurnPlugin({ trigger: 100_000, delegation: false });
    const { request, raw } = turn(Array.from({ length: 14 }, () => "computer_exec"));
    plugin.observe("turn-1", 99_999);
    expect(await plugin.prepareStep!(request, step(raw))).toBeUndefined();
  });

  it("from the trigger shortens all but the latest 10 results, keeps the history and the projection origin", async () => {
    const plugin = createLongTurnPlugin({ trigger: 100_000, delegation: false });
    const history = turn(["computer_exec"], "old");
    const current = turn(Array.from({ length: 14 }, () => "computer_exec"));
    const request = [...history.request, ...current.request];
    const projection = new AgentRequestProjection();
    request.forEach((message, index) => projection.register(message, { kind: index < 2 ? "history" : "live", sourceEntryIds: [`e${index}`] }));
    plugin.observe("turn-1", 150_000);
    const result = (await plugin.prepareStep!(request, step(current.raw, projection))) as ModelMessage[];
    const body = text(result);
    // The earlier turn's result is history, which summaries handle.
    expect(body).toContain("R1:x");
    for (const n of [5, 14]) expect(body).toContain(payload(n));
    for (const n of [2, 3, 4]) expect(body).not.toContain(payload(n));
    expect(body.match(/本轮较早的 computer_exec 结果（约 6 KB）已从这次请求中省略/g)).toHaveLength(4);
    expect(result).toHaveLength(request.length);
    expect(projection.describe(result).map((origin) => origin?.kind)).toEqual(projection.describe(request).map((origin) => origin?.kind));
    expect(projection.describe(result)[3]).toMatchObject({ kind: "live", sourceEntryIds: ["e3"] });
  });

  it("only ever shortens more, so the start of the request stays the same while the usage drops", async () => {
    const plugin = createLongTurnPlugin({ trigger: 100_000, delegation: false });
    const first = turn(Array.from({ length: 12 }, () => "computer_exec"));
    plugin.observe("turn-1", 120_000);
    const before = (await plugin.prepareStep!(first.request, step(first.raw))) as ModelMessage[];
    plugin.observe("turn-1", 60_000);
    const later = turn(Array.from({ length: 13 }, () => "computer_exec"));
    const after = (await plugin.prepareStep!(later.request, step(later.raw))) as ModelMessage[];
    expect(text(after.slice(0, before.length - 2))).toBe(text(before.slice(0, before.length - 2)));
    expect(text(after).match(/本轮较早的/g)).toHaveLength(2);
    // A new turn starts over.
    const next = turn(Array.from({ length: 13 }, () => "computer_exec"));
    expect(await plugin.prepareStep!(next.request, step(next.raw, undefined, "turn-2"))).toBeUndefined();
  });

  it("points at the archive of a result that was already cut to a preview", async () => {
    const plugin = createLongTurnPlugin({ trigger: 100_000, delegation: false });
    const { request, raw } = turn(Array.from({ length: 11 }, () => "computer_exec"));
    const preview = {
      type: "json" as const,
      value: { truncated: true, outputId: "4f0c0a52-0000-4000-8000-000000000001", preview: "y".repeat(5000) },
    };
    const first = request[1] as Extract<ModelMessage, { role: "tool" }>;
    request[1] = { ...first, content: [{ ...(first.content[0] as object), output: preview } as never] };
    plugin.observe("turn-1", 100_000);
    const body = text(await plugin.prepareStep!(request, step(raw)));
    expect(body).toContain("完整结果仍可用 read_tool_output（id 4f0c0a52-0000-4000-8000-000000000001）读取");
    expect(body).not.toContain("y".repeat(5000));
  });
});

describe("long turn: suggesting a background task", () => {
  it(`reminds from ${LONG_TURN_TOOL_CALLS} working calls, not counting replies, and never removes a tool`, async () => {
    const plugin = createLongTurnPlugin({ trigger: 100_000, delegation: true });
    const short = turn([...Array.from({ length: LONG_TURN_TOOL_CALLS - 1 }, () => "computer_exec"), "send_message", "send_message"]);
    expect(await plugin.prepareStep!(short.request, step(short.raw))).toBeUndefined();
    const long = turn(Array.from({ length: LONG_TURN_TOOL_CALLS }, () => "computer_exec"));
    const projection = new AgentRequestProjection();
    const result = (await plugin.prepareStep!(long.request, step(long.raw, projection))) as ModelMessage[];
    expect(result).toHaveLength(long.request.length + 1);
    expect(result.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining(`这一轮你已经调用了 ${LONG_TURN_TOOL_CALLS} 次工具`) });
    expect(result.at(-1)!.content).toContain("用 task_create 交给后台任务");
    expect(projection.describe(result).at(-1)).toMatchObject({ kind: "mandatory" });
  });

  it("stops reminding once the turn delegated, and never without background tasks", async () => {
    const delegated = turn([...Array.from({ length: LONG_TURN_TOOL_CALLS }, () => "computer_exec"), "task_create"]);
    expect(await createLongTurnPlugin({ trigger: 100_000, delegation: true }).prepareStep!(delegated.request, step(delegated.raw))).toBeUndefined();
    const long = turn(Array.from({ length: 20 }, () => "computer_exec"));
    expect(await createLongTurnPlugin({ trigger: 100_000, delegation: false }).prepareStep!(long.request, step(long.raw))).toBeUndefined();
  });
});

describe("long turn in a channel runtime", () => {
  it("bounds a turn that keeps running commands once its actual input reaches the summary trigger", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-long-turn-"));
    roots.push(root);
    const scope: ChannelContext = { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1", selfId: "bot-1" };
    const channel = new Channel(scope, root);
    await channel.conversation.init();
    const requests: LanguageModelV3CallOptions[] = [];
    let calls = 0;
    const steps = [...Array.from({ length: 14 }, () => "big_read"), "finish"];
    const model = new MockLanguageModelV3({
      doStream: async (request) => {
        const toolName = steps[requests.length];
        if (!toolName) throw new Error("unexpected scripted model request");
        requests.push(request);
        return {
          stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: `call-${requests.length}`, toolName, input: "{}" },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: { inputTokens: { total: 150_000, noCache: 150_000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            },
          ]),
        };
      },
    });
    const runtime = new ChannelRuntime(new TestEvents(), {
      channel,
      bot: { selfId: "bot-1", platform: "test", sendMessage: vi.fn(async () => ["must-not-send"]) } as never,
      will: { decide: () => "trigger" },
      model,
      readImagePolicy: { mode: "native" },
      config: defaultConfig({ basePath: root, modelRetries: 0, session: { magicContext: {}, archive: { maxKB: 0 } } }),
      plugins: [
        {
          name: "big-read-fixture",
          tools: [
            {
              name: "big_read",
              capability: { platforms: ["test"], sensitive: false, executionKind: "read" },
              inputSchema: z.object({}),
              execute: async () => ({ text: payload(++calls) }),
            },
          ],
        },
      ],
    });
    runtimes.push(runtime);
    await runtime.init();
    await runtime.handle(
      defaultMessageRecord({ messageId: "m1", timestamp: 1, user: { id: "u1" }, parts: partsFromElements([h("at", { id: "bot-1" }), h.text("查一下")]) }),
    );
    await runtime.wait();

    expect(requests).toHaveLength(15);
    // The 12th request already has 11 results: the oldest one is shortened.
    expect(JSON.stringify(requests[11]!.prompt)).not.toContain(payload(1));
    const last = JSON.stringify(requests[14]!.prompt);
    for (const n of [1, 2, 3, 4]) expect(last).not.toContain(payload(n));
    for (const n of [5, 14]) expect(last).toContain(payload(n));
    expect(last.match(/本轮较早的 big_read 结果/g)).toHaveLength(4);
    // Every command still ran once; the conversation keeps every result.
    expect(calls).toBe(14);
    const stored = JSON.stringify(await channel.conversation.storage.read());
    for (const n of [1, 14]) expect(stored).toContain(`R${n}:`);
  });
});

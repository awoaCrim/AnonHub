import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AgentPlugin } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));

import { createGoogleProvider } from "../../providers/model-provider/src/google.js";
import { Channel } from "../src/channels/index.js";
import { isReplyDeliveryProof } from "../src/conversations/reply-receipt.js";
import { ModelService } from "../src/models/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { TestEvents, defaultConfig, defaultMessageRecord, h, testScope } from "./helpers/index.js";

/** Registers one Google connection, as the model-provider extension does for each. */
const applyGoogle = (ctx: { yesimbot: { model: { register(provider: never): unknown } } }, config: unknown) =>
  ctx.yesimbot.model.register(createGoogleProvider(config as never) as never);

type Call = { name: string; args: Record<string, unknown>; signature?: string };

type WirePart = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
};

type WireMessage = { role: string; parts: WirePart[] };

type WireRequest = { contents: WireMessage[]; systemInstruction?: { parts: WirePart[] } };

const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];
const services: ModelService[] = [];
const firstQuestion = "SYNTHETIC_QUESTION_ONE";
const secondQuestion = "SYNTHETIC_QUESTION_TWO";
const currentQuestion = "SYNTHETIC_CURRENT_QUESTION";
const firstAnswer = "SYNTHETIC_DELIVERED_ANSWER_ONE";
const secondAnswer = "SYNTHETIC_DELIVERED_ANSWER_TWO";
const liveSignature = "ZmFrZS1saXZlLXNpZ25hdHVyZQ==";
const send = (text: string): Call => ({ name: "send_message", args: { parts: [{ kind: "text", text }], inner_thought: "PRIVATE_PLAN" } });

function containing(request: WireRequest, text: string): number {
  return request.contents.findIndex((message) => message.parts.some((part) => part.text?.includes(text)));
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(calls: Call[], magic: boolean) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-gemini-reply-history-"));
  roots.push(root);
  const ctx = new TestEvents();
  const service = new ModelService({ baseDir: "/", emit: ctx.emit.bind(ctx) }, { basePath: root, logLevel: 0 });
  services.push(service);
  await service.start();
  const ready: Array<() => void> = [];
  applyGoogle(
    {
      on(event: string, callback: () => void) {
        if (event === "ready") ready.push(callback);
      },
      yesimbot: { model: service },
      logger: () => ({ warn: vi.fn() }),
    } as never,
    {
      id: "synthetic-google",
      apiKey: "test-not-a-real-key",
      baseURL: "https://provider.invalid/v1beta",
      chatModels: [{ id: "gemini-3.7-flash-high", limit: { context: 147200, output: 8192 } }],
    },
  );
  for (const callback of ready) callback();

  const requests: WireRequest[] = [];
  const continuations: WireRequest[] = [];
  let finishNext = false;
  const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
    expect(String(url)).toMatch(/^https:\/\/provider\.invalid\//);
    const call = finishNext ? { name: "finish", args: {} } : calls[requests.length];
    if (!call) throw new Error("unexpected synthetic provider request");
    (finishNext ? continuations : requests).push(JSON.parse(String(init.body)) as WireRequest);
    finishNext = call.name === "send_message";
    const response = {
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [{ functionCall: { name: call.name, args: call.args }, thoughtSignature: call.signature ?? liveSignature }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 },
    };
    return new Response(`data: ${JSON.stringify(response)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetch);
  const model = service.resolveChatModel("synthetic-google:gemini-3.7-flash-high");
  expect(model.capabilities.historyProjection).toBe("gemini-native");

  const channel = new Channel(testScope, root);
  await channel.conversation.init();
  let delivered = 0;
  const sendMessage = vi.fn(async () => [`synthetic-platform-${++delivered}`]);
  const config = defaultConfig({
    customInnerThought: true,
    basePath: root,
    modelRetries: 0,
    logLevel: 0,
    pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 },
  });
  const plugin: AgentPlugin = {
    name: "synthetic-lookup",
    tools: () => [{ name: "lookup", description: "Returns a synthetic local result", inputSchema: z.object({}), execute: async () => "CURRENT_LOOKUP_RESULT" }],
  };
  const runtime = new ChannelRuntime(ctx, {
    channel,
    bot: { selfId: "bot-1", platform: "test", sendMessage } as never,
    will: { decide: async () => "trigger" as const, observe: () => {} },
    model: model.model,
    historyProjection: model.capabilities.historyProjection,
    contextModelLimit: service.contextLimit(model.model),
    readImagePolicy: { mode: "native" },
    config: {
      ...config,
      session: {
        ...config.session,
        magicContext: {
          enabled: magic,
        },
      },
    },
    plugins: [plugin],
  });
  runtimes.push(runtime);
  await runtime.init();
  let inputs = 0;
  const handle = async (text: string) => {
    const outcome = await runtime.handle(
      defaultMessageRecord({ messageId: `synthetic-input-${++inputs}`, timestamp: Date.now(), parts: partsFromElements([h.text(text)]) }),
    );
    if (outcome.kind === "run") await outcome.done;
    await runtime.wait();
  };
  return { runtime, channel, ctx, handle, sendMessage, requests, continuations, fetch };
}

describe("Gemini native send history (real Core and SDK)", () => {
  it.each([false, true])("keeps real send calls/results in order and signed continuation (Magic=%s)", async (magic) => {
    const f = await fixture([send(firstAnswer), send(secondAnswer), { name: "finish", args: {} }], magic);
    await f.handle(firstQuestion);
    await f.handle(secondQuestion);
    await f.handle(currentQuestion);
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    const wire = f.requests[2]!;
    const all = JSON.stringify(wire.contents);
    expect(all).toContain("replyReceipt");
    expect(all).toContain(firstAnswer);
    expect(all).toContain(secondAnswer);
    expect(all).not.toMatch(/delivered_transcript|PRIVATE_PLAN|reply-delivery-proof/);
    const parts = wire.contents.flatMap((m) => m.parts);
    const calls = parts.filter((p) => p.functionCall?.name === "send_message");
    const results = parts.filter((p) => p.functionResponse?.name === "send_message");
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(calls.every((p) => p.thoughtSignature === liveSignature)).toBe(true);
    expect(containing(wire, firstQuestion)).toBeLessThan(containing(wire, secondQuestion));
    expect(containing(wire, secondQuestion)).toBeLessThan(containing(wire, currentQuestion));
    expect(f.continuations).toHaveLength(2);
    expect(JSON.stringify(f.continuations[0])).toContain("replyReceipt");
  });
  it.each([false, true])("does not invent tool pairs from journal-only recovery (Magic=%s)", async (magic) => {
    const f = await fixture([send(firstAnswer), { name: "finish", args: {} }], magic);
    await f.handle(firstQuestion);
    const entries = await f.channel.conversation.storage.read();
    const retained = entries.filter((e) => e.type !== "message" || (e.data.role !== "assistant" && e.data.role !== "tool"));
    expect(retained.some((e) => e.type === "message" && isReplyDeliveryProof(e.data))).toBe(true);
    await f.channel.conversation.storage.clear();
    await f.channel.conversation.storage.append(...retained);
    await f.handle(currentQuestion);
    expect(JSON.stringify(f.requests[1])).not.toMatch(/delivered_transcript|SYNTHETIC_DELIVERED_ANSWER_ONE/);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
  });
});

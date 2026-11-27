import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry, createUserMessage, EphemeralImageProjectionStore, type AgentPlugin } from "@yesimbot/agent-runtime";
import { textPart } from "@yesimbot/contracts/parts";
import { blankRoleCardText } from "@yesimbot/contracts/role-cards";
import { parseConfig } from "@yesimbot/foundation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));

import { moduleConfig as roleplayConfig } from "../../plugins/roleplay/src/config.js";
import { Roleplay } from "../../plugins/roleplay/src/roleplay-service.js";
import { createGoogleProvider } from "../../providers/model-provider/src/google.js";
import { createOpenAIProvider } from "../../providers/model-provider/src/openai.js";
import { Agents } from "../src/agents/index.js";
import { Channel, type ChannelContext } from "../src/channels/index.js";
import { ModelService } from "../src/models/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { defaultConfig, defaultMessageRecord, deferred, TestEvents, testScope } from "./helpers/index.js";

/** Registers one Google connection, as the model-provider extension does for each. */
const applyGoogle = (ctx: { yesimbot: { model: { register(provider: never): unknown } } }, config: unknown) =>
  ctx.yesimbot.model.register(createGoogleProvider(config as never) as never);
/** Registers one OpenAI connection, as the model-provider extension does for each. */
const applyOpenAI = (ctx: { yesimbot: { model: { register(provider: never): unknown } } }, config: unknown) =>
  ctx.yesimbot.model.register(createOpenAIProvider(config as never) as never);

type Provider = "openai" | "google";

type Action = { name: string; args: Record<string, unknown>; signature?: string } | { text: string };

type WirePart = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
};

type WireTurn = {
  role: string;
  parts?: WirePart[];
  content?: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
};

type WireRequest = { messages?: WireTurn[]; contents?: WireTurn[]; systemInstruction?: { parts: WirePart[] } };

const seedQuestion = "ROLE_HISTORY_SEED_QUESTION";
const seedAnswer = "ROLE_HISTORY_SEED_ANSWER";
const seedOnlyAnswer = "ROLE_HISTORY_CHARACTER_ONLY";
const currentQuestion = "ROLE_HISTORY_REAL_CURRENT";
const signature = "c3ludGhldGljLWxvb2t1cC1zaWduYXR1cmU=";
const exampleText = `对方：${seedQuestion}\nRoleFixture：${seedAnswer}\n\nRoleFixture：${seedOnlyAnswer}`;
const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];
const roleplays: Roleplay[] = [];
const services: ModelService[] = [];
const matrix = (["openai", "google"] as const).flatMap((provider) => [false, true].map((magic) => ({ provider, magic })));
const send = (text: string): Action => ({ name: "send_message", args: { parts: [{ kind: "text", text }] } });
const reminderHeading = "【回复前提醒；这是运行规则，不是新增聊天内容】";
const reminderMatrix = matrix.flatMap((entry) => [false, true].map((reminder) => ({ ...entry, reminder })));

function expectReminder(request: WireRequest): void {
  expect(occurrences(text(request), reminderHeading)).toBe(0);
  expect(systemText(request)).not.toContain(reminderHeading);
  expect(JSON.stringify(request)).not.toContain("sourceEntryIds");
  // The card's post-history note follows the history in every request, once.
  expect(occurrences(text(request), "SYNTHETIC_POST_RULE")).toBe(1);
  expect(systemText(request)).not.toContain("SYNTHETIC_POST_RULE");
  const noteTurn = dialogue(request).findLast((turn) => body(turn).includes("SYNTHETIC_POST_RULE"));
  expect(noteTurn?.role).toBe("user");
  expect(body(noteTurn!)).toContain("<character_post_history>\nSYNTHETIC_POST_RULE\n</character_post_history>");
}

function body(turn: WireTurn): string {
  if (turn.parts) return turn.parts.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n");
  if (typeof turn.content === "string") return turn.content;
  return turn.content?.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n") ?? "";
}

function dialogue(request: WireRequest): WireTurn[] {
  return (request.contents ?? request.messages ?? []).filter((turn) => turn.role !== "system" && turn.role !== "developer");
}

function systemBlocks(request: WireRequest): string[] {
  return request.systemInstruction?.parts.map((part) => part.text ?? "") ?? request.messages?.filter((turn) => turn.role === "system").map(body) ?? [];
}

function systemText(request: WireRequest): string {
  return systemBlocks(request).join("\n");
}

function expectCorePromptBlocks(request: WireRequest, provider: Provider): void {
  // This runtime fixture keeps defaultConfig.customInnerThought enabled.
  const headings = ["# 运行契约", "# 角色", "# 互动策略", "# 能力与证据边界", "# 内心判断"];
  const blocks = systemBlocks(request);
  const all = systemText(request);
  const offsets = headings.map((heading) => all.indexOf(heading));
  expect(offsets.every((offset) => offset >= 0)).toBe(true);
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  for (const heading of headings) expect(occurrences(all, heading)).toBe(1);
  expect(occurrences(all, "回应不必附带点评")).toBe(0);
  expect(occurrences(all, "同一作者、同一产品的其他动态不等于当前引用的上下文")).toBe(1);
  // The card's post-history note leaves the leading role section and rides in the trailing reminder.
  expect(all).not.toContain("SYNTHETIC_POST_RULE");
  for (const marker of ["SYNTHETIC_CHARACTER_DEFINITION", "SYNTHETIC_CARD_RULE"]) {
    expect(occurrences(all, marker)).toBe(1);
    expect(all.indexOf(marker)).toBeGreaterThan(all.indexOf("# 角色"));
    expect(all.indexOf(marker)).toBeLessThan(all.indexOf("# 互动策略"));
  }
  if (provider === "openai") {
    expect(blocks.slice(0, headings.length).map((block) => block.split("\n")[0])).toEqual(headings);
  } else {
    // Google may aggregate system messages into systemInstruction; content/order must survive.
    expect(request.systemInstruction?.parts.length).toBeGreaterThan(0);
  }
}

function text(request: WireRequest): string {
  return dialogue(request).map(body).join("\n");
}

function expectFocus(request: WireRequest, expected: string): void {
  const matches = [...text(request).matchAll(/\[CURRENT_MESSAGE\]\n?([\s\S]*?)\n?\[\/CURRENT_MESSAGE\]/g)];
  expect(matches.map((match) => match[1]?.trim())).toEqual([expected]);
}

function occurrences(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

function streamResponse(provider: Provider, action: Action, index: number): Response {
  if (provider === "google") {
    const part =
      "text" in action ? { text: action.text } : { functionCall: { name: action.name, args: action.args }, thoughtSignature: action.signature ?? signature };
    return new Response(
      `data: ${JSON.stringify({
        candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  const delta =
    "text" in action
      ? { role: "assistant", content: action.text }
      : {
          role: "assistant",
          tool_calls: [{ index: 0, id: `synthetic-call-${index}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }],
        };
  const chunks = [
    { id: `synthetic-${index}`, object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta, finish_reason: null }] },
    {
      id: `synthetic-${index}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, delta: {}, finish_reason: "text" in action ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
    },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function fixture(
  provider: Provider,
  magic: boolean,
  script: Action[],
  examples = exampleText,
  options: { preventSelfStyleImitation?: boolean; direct?: boolean; lookup?: () => Promise<string> } = {},
) {
  const scope: ChannelContext = options.direct ? { type: "direct", platform: "test", channelId: "room-1", selfId: "bot-1", userId: "user-1" } : testScope;
  const root = await mkdtemp(join(tmpdir(), "yesimbot-role-history-wire-"));
  roots.push(root);
  const cardDir = join(root, "data/yesimbot/characters/fixture");
  await mkdir(cardDir, { recursive: true });
  await writeFile(
    join(cardDir, "card.json"),
    JSON.stringify({
      ...blankRoleCardText("RoleFixture"),
      identity: "SYNTHETIC_CHARACTER_DEFINITION",
      rules: "SYNTHETIC_CARD_RULE",
      examples,
      reminder: "SYNTHETIC_POST_RULE",
      pictures: {},
    }),
  );
  const ctx = new TestEvents();
  const service = new ModelService({ baseDir: root, emit: (name, ...args) => ctx.emit(name, ...(args as never)) }, { basePath: root, logLevel: 0 });
  services.push(service);
  await service.start();
  const ready: Array<() => void> = [];
  const providerContext = {
    on(event: string, callback: () => void) {
      if (event === "ready") ready.push(callback);
    },
    yesimbot: { model: service },
    logger: () => ({ warn: vi.fn() }),
  };
  const modelId = provider === "google" ? "gemini-3.7-flash-high" : "gpt-4o";
  const common = {
    id: "role-history-wire",
    apiKey: "synthetic-not-a-real-key",
    baseURL: provider === "google" ? "https://provider.invalid/v1beta" : "https://provider.invalid/v1",
    chatModels: [{ id: modelId, limit: { context: 147200, output: 8192 } }],
  };
  if (provider === "google") applyGoogle(providerContext as never, common);
  else applyOpenAI(providerContext as never, { ...common, format: "chat" });
  for (const callback of ready) callback();
  const requests: WireRequest[] = [];
  const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
    expect(String(url)).toMatch(/^https:\/\/provider\.invalid\//);
    const action = script[requests.length];
    if (!action) throw new Error("unexpected synthetic provider request");
    requests.push(JSON.parse(String(init.body)) as WireRequest);
    return streamResponse(provider, action, requests.length);
  });
  vi.stubGlobal("fetch", fetch);
  const model = service.resolveChatModel(`role-history-wire:${modelId}`);
  const agents = new Agents();
  const core = { agent: agents, resource: { get: async () => ({}), use: () => () => {} } } as unknown as ConstructorParameters<typeof Roleplay>[0];
  const roleplay = new Roleplay(core, parseConfig(roleplayConfig, { characterCard: "fixture" }), root);
  roleplays.push(roleplay);
  await roleplay.start();
  const roleProfile = await agents.resolveRoleProfile(scope);
  const projection = new EphemeralImageProjectionStore();
  let deliveries = 0;
  const bot = { selfId: "bot-1", platform: "test", sendMessage: vi.fn(async () => [`synthetic-platform-${++deliveries}`]) };
  const plugins = await agents.setup(scope, bot as never, { rolePromptsManaged: true, imageProjection: projection });
  const lookupExecute = vi.fn(options.lookup ?? (async () => "SYNTHETIC_LOOKUP_RESULT"));
  const lookup: AgentPlugin = {
    name: "role-history-wire-lookup",
    tools: () => [
      {
        name: "lookup",
        capability: { platforms: ["test"], sensitive: false, executionKind: "read" },
        description: "Synthetic local lookup",
        inputSchema: z.object({}),
        execute: lookupExecute,
      },
    ],
  };
  const onTurnFinish = vi.fn();
  const channel = new Channel(scope, root);
  await channel.conversation.init();
  const config = defaultConfig({
    basePath: root,
    modelRetries: 0,
    logLevel: 0,
    pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 },
    ...(options.preventSelfStyleImitation === undefined ? {} : { preventSelfStyleImitation: options.preventSelfStyleImitation }),
  });
  const runtime = new ChannelRuntime(ctx, {
    channel,
    bot: bot as never,
    will: { decide: async () => "trigger" as const, observe: () => {} },
    model: model.model,
    historyProjection: model.capabilities.historyProjection,
    contextModelLimit: service.contextLimit(model.model),
    readImagePolicy: { mode: "native" },
    roleProfile,
    imageProjection: projection,
    config: {
      ...config,
      session: {
        ...config.session,
        magicContext: {
          enabled: magic,
        },
      },
    },
    plugins: [...plugins, lookup, { name: "role-history-wire-observer", onTurnFinish }],
  });
  runtimes.push(runtime);
  await runtime.init();
  let inputs = 0;
  const enqueue = (message: string) =>
    runtime.handle(
      defaultMessageRecord({
        messageId: `synthetic-real-input-${++inputs}`,
        timestamp: inputs,
        channel: { id: scope.channelId, type: options.direct ? 1 : 0 },
        parts: [textPart(message)],
      }),
    );
  const handle = async (message: string) => {
    const result = await enqueue(message);
    if (result.kind === "run") await result.done;
    await runtime.wait();
    for (const request of requests) expectCorePromptBlocks(request, provider);
  };
  return { runtime, channel, bot, roleplay, requests, fetch, handle, enqueue, onTurnFinish, lookupExecute };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roleplays.splice(0).map((roleplay) => roleplay.stop()));
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectExamples(request: WireRequest): void {
  const system = systemText(request);
  for (const marker of [seedQuestion, seedAnswer, seedOnlyAnswer]) {
    expect(occurrences(system, marker)).toBe(1);
    expect(text(request)).not.toContain(marker);
  }
  expect(system).toContain("以下是说话方式的示例，不是这段对话里发生过的事。");
}

describe("mandatory role workflow (actual Core and provider SDKs; stub HTTP only)", () => {
  it.each(matrix.flatMap((entry) => [undefined, false, true].flatMap((setting) => [false, true].map((direct) => ({ ...entry, setting, direct })))))(
    "does not remind a finish-only turn regardless of the obsolete setting ($provider, Magic=$magic, setting=$setting, direct=$direct)",
    async ({ provider, magic, setting, direct }) => {
      const f = await fixture(provider, magic, [{ name: "finish", args: {} }], exampleText, { preventSelfStyleImitation: setting, direct });
      await f.handle(currentQuestion);
      expect(f.fetch).toHaveBeenCalledOnce();
      expectExamples(f.requests[0]!);
      expectReminder(f.requests[0]!);
      expect(body(dialogue(f.requests[0]!).at(-1)!)).not.toContain(reminderHeading);
      expect(f.bot.sendMessage).not.toHaveBeenCalled();
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
      expect(JSON.stringify(await f.channel.conversation.contextSources())).not.toContain(reminderHeading);
    },
  );

  it.each(matrix)("retains genuine historical text identical to the reminder ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(
      provider,
      magic,
      [
        { name: "finish", args: {} },
        { name: "finish", args: {} },
      ],
      exampleText,
      { preventSelfStyleImitation: true },
    );
    await f.handle("REAL_FIRST_INPUT");
    const reminder = `${reminderHeading}\nGENUINE_HISTORY`;
    await f.channel.conversation.storage.append(createEntry("message", createUserMessage(reminder), { id: "genuine-identical-reminder", timestamp: 1 }));
    await f.handle(currentQuestion);
    expect(occurrences(text(f.requests[1]!), reminderHeading)).toBe(1);
    expect((await f.channel.conversation.storage.read()).find((entry) => entry.id === "genuine-identical-reminder")).toMatchObject({
      data: { content: reminder },
    });
  });

  it.each(matrix)("does not remind after a tool failure ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(
      provider,
      magic,
      [
        { name: "lookup", args: {}, signature },
        { name: "finish", args: {} },
      ],
      exampleText,
      {
        preventSelfStyleImitation: false,
        lookup: async () => {
          throw new Error("SYNTHETIC_LOOKUP_FAILURE");
        },
      },
    );
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    for (const request of f.requests) {
      expectReminder(request);
      expectFocus(request, currentQuestion);
    }
    expect(f.lookupExecute).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.requests[1])).toContain("execution_unknown");
    expect(JSON.stringify(f.requests[1])).toContain("automaticReplayBlocked");
    expect(JSON.stringify(f.requests[1])).not.toContain("SYNTHETIC_LOOKUP_FAILURE");
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
  });

  it.each(matrix)("reinjects one reminder after direct-channel supersession ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(
      provider,
      magic,
      [{ name: "lookup", args: {}, signature }, { name: "lookup", args: {}, signature }, send("JOINED_FINAL_REPLY"), { name: "finish", args: {} }],
      exampleText,
      {
        preventSelfStyleImitation: true,
        direct: true,
        lookup: async () => {
          entered.resolve();
          await release.promise;
          return "SYNTHETIC_LOOKUP_RESULT";
        },
      },
    );
    const first = await f.enqueue(currentQuestion);
    let replacement: Awaited<ReturnType<typeof f.enqueue>> | undefined;
    try {
      await entered.promise;
      replacement = await f.enqueue("JOINED_REAL_CURRENT");
      expect(f.requests).toHaveLength(1);
    } finally {
      release.resolve();
    }
    if (first.kind !== "run" || replacement?.kind !== "run") throw new Error("expected_superseding_turns");
    await Promise.all([first.done, replacement.done]);
    await f.runtime.wait();
    expect(await first.outcome).toMatchObject({ status: "aborted", delivered: false });
    expect(await replacement.outcome).toMatchObject({ status: "done", delivered: true });
    expect(f.requests).toHaveLength(4);
    expectFocus(f.requests[0]!, currentQuestion);
    for (const request of f.requests.slice(1)) expectFocus(request, "JOINED_REAL_CURRENT");
    for (const request of f.requests) {
      expectCorePromptBlocks(request, provider);
      expectExamples(request);
      expectReminder(request);
    }
    expect(text(f.requests[1]!)).toContain("JOINED_REAL_CURRENT");
    expect(JSON.stringify(f.requests[1])).toContain("SYNTHETIC_LOOKUP_RESULT");
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
  });
});

describe("illustrative Roleplay examples (actual Core and provider SDKs; stub HTTP only)", () => {
  it.each(matrix)("keeps examples out of conversation history ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(provider, magic, [{ name: "finish", args: {} }]);
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
    const request = f.requests[0]!;
    expectExamples(request);
    expect(systemText(request)).toContain("SYNTHETIC_CARD_RULE");
    expect(systemText(request)).not.toContain("SYNTHETIC_POST_RULE");
    expect(occurrences(text(request), "SYNTHETIC_POST_RULE")).toBe(1);
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY/);
    expect(JSON.stringify(await f.channel.conversation.contextSources())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY/);
  });

  it.each(reminderMatrix)(
    "keeps focus, illustrative examples and proven speech across two signed tool steps ($provider, Magic=$magic, reminder=$reminder)",
    async ({ provider, magic, reminder }) => {
      const f = await fixture(
        provider,
        magic,
        [
          send("REAL_DELIVERED_REPLY"),
          { name: "finish", args: {} },
          { name: "lookup", args: {}, signature },
          { name: "lookup", args: {}, signature },
          send("REAL_FINAL_REPLY"),
          { name: "finish", args: {} },
        ],
        exampleText,
        { preventSelfStyleImitation: reminder },
      );
      await f.handle("REAL_FIRST_INPUT");
      await f.handle(currentQuestion);
      expect(f.fetch).toHaveBeenCalledTimes(6);
      expect(f.bot.sendMessage).toHaveBeenCalledTimes(2);
      for (const request of f.requests.slice(2)) {
        expectFocus(request, currentQuestion);
        expectExamples(request);
        expect(JSON.stringify(request)).toContain("REAL_DELIVERED_REPLY");
        expect(JSON.stringify(request)).not.toContain("delivered_transcript_history");
      }
      for (const request of f.requests) expectReminder(request);
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
      expect(JSON.stringify(await f.channel.conversation.contextSources())).not.toContain(reminderHeading);
      const finalRequest = f.requests[4]!;
      expect(JSON.stringify(finalRequest)).toContain("SYNTHETIC_LOOKUP_RESULT");
      if (provider === "google") {
        const calls = finalRequest.contents?.flatMap((turn) => turn.parts ?? []).filter((part) => part.functionCall?.name === "lookup");
        expect(calls).toHaveLength(2);
        expect(calls?.every((call) => call.thoughtSignature === signature)).toBe(true);
      } else {
        expect(finalRequest.messages?.flatMap((turn) => turn.tool_calls ?? []).filter((call) => call.function.name === "lookup")).toHaveLength(2);
      }
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY/);
    },
  );

  it.each(reminderMatrix)(
    "retains examples and reminder during intermediate-tool terminal recovery ($provider, Magic=$magic, reminder=$reminder)",
    async ({ provider, magic, reminder }) => {
      const f = await fixture(
        provider,
        magic,
        [{ name: "lookup", args: {}, signature }, { text: "UNSENT_INTERNAL_TEXT" }, { name: "finish", args: {} }],
        exampleText,
        { preventSelfStyleImitation: reminder },
      );
      await f.handle(currentQuestion);
      expect(f.fetch).toHaveBeenCalledTimes(3);
      expect(f.bot.sendMessage).not.toHaveBeenCalled();
      expect(f.onTurnFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }), expect.any(Object));
      for (const request of f.requests) {
        expectFocus(request, currentQuestion);
        expectExamples(request);
        expectReminder(request);
      }
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
      expect(JSON.stringify(f.requests[2])).toContain("internal repair step");
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY|internal repair step/);
    },
  );

  it.each(matrix)("still rejects plain text as a terminal reply ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(provider, magic, [{ text: "UNSENT_INTERNAL_TEXT" }]);
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledOnce();
    expectExamples(f.requests[0]!);
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
    expect(f.onTurnFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ name: "AgentProtocolError", message: expect.stringContaining("text-only") }),
      }),
      expect.any(Object),
    );
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY/);
  });

  it.each(matrix)("keeps character-only examples in instructions ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(provider, magic, [{ name: "finish", args: {} }], `RoleFixture：${seedOnlyAnswer}`);
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledOnce();
    const request = f.requests[0]!;
    expect(occurrences(systemText(request), seedOnlyAnswer)).toBe(1);
    expect(text(request)).not.toContain(seedOnlyAnswer);
    expect(f.onTurnFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }), expect.any(Object));
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(seedOnlyAnswer);
  });

  it.each(matrix)("preserves real history matching an example ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(provider, magic, [{ name: "finish", args: {} }]);
    await f.channel.conversation.storage.append(createEntry("message", createUserMessage(seedQuestion), { id: "actual-identical-user-message", timestamp: 1 }));
    await f.handle(currentQuestion);
    expect(occurrences(text(f.requests[0]!), seedQuestion)).toBe(1);
    const original = (await f.channel.conversation.storage.read()).find((entry) => entry.id === "actual-identical-user-message");
    expect(original).toMatchObject({ id: "actual-identical-user-message", data: { role: "user", content: seedQuestion } });
    expect(occurrences(text(f.requests[0]!), seedAnswer)).toBe(0);
  });
});

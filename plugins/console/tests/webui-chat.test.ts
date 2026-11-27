import { createHmac, randomUUID, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createAssistantMessage, createEntry, createToolMessage, currentModelRequestContext, jsonSchema } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { defineModuleConfig, systemClock } from "@yesimbot/foundation";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { Channels } from "../../../core/src/channels/index.js";
import { createMessage } from "../../../core/src/messages/index.js";
import { Messenger } from "../../../core/src/messengers/index.js";
import type { ImagePart, Part } from "../../../packages/contracts/src/parts.js";
import { AdminAuth } from "../src/admin-auth.js";
import { ConfigStore } from "../src/config/store.js";
import { buildConversationIndex, readConversationDetail } from "../src/conversation-history.js";
import { installInstanceManagement } from "../src/instance-management.js";
import { relayChatUsername } from "../src/relay-chat-identity.js";
import { webChatContext, webConversationContext } from "../src/webui/chat-bot.js";
import { CHAT_PATH, CHAT_PENDING_LIMIT, installChat } from "../src/webui/chat.js";
import { installEvents } from "../src/webui/events.js";
import { chatHistory } from "../src/webui/history.js";
import type { HttpContext } from "../src/webui/plugins.js";

// Per turn: how many user messages the request that sent had. Sending does not end a turn; with nothing new
// since, the turn's next request finishes it.
const sentTurns = new Map<string | undefined, number>();
const userMessages = (request: LanguageModelV3CallOptions) => request.prompt.filter((message) => message.role === "user").length;

/** Web chat shows only what send_message sends. */
function webSend(request: LanguageModelV3CallOptions, toolCallId: string, ...messages: string[]): LanguageModelV3StreamPart {
  sentTurns.set(currentModelRequestContext()?.turnId, userMessages(request));
  return { type: "tool-call", toolCallId, toolName: "send_message", input: JSON.stringify({ messages }) };
}

function finishAfterSend(request: LanguageModelV3CallOptions): { stream: ReadableStream<LanguageModelV3StreamPart> } | undefined {
  const turnId = currentModelRequestContext()?.turnId;
  if (sentTurns.get(turnId) !== userMessages(request)) {
    sentTurns.delete(turnId);
    return undefined;
  }
  return {
    stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: `finish-${randomUUID()}`, toolName: "finish", input: "{}" },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      },
    ]),
  };
}
import { TopicRegistry } from "../src/webui/topics.js";
import { WebChat } from "../src/webui/web-chat.js";
import { fakeHost } from "./fixtures/fake-host.js";
import { kernelCore } from "./fixtures/kernel-core.js";

/** A Satori-shaped element, as the web chat reads what Core sends. */
const h = Object.assign((type: string, attrs: Record<string, unknown> = {}) => ({ type, attrs, children: [] }), {
  text: (content: string) => ({ type: "text", attrs: { content }, children: [] }),
  image: (src: string) => ({ type: "img", attrs: { src }, children: [] }),
});

function sendTo(chat: WebChat, channelId: string, content: string | ReturnType<typeof h>[]): Promise<string[]> {
  return chat.sendMessage(channelId, partsFromElements(typeof content === "string" ? [h.text(content)] : content, { sources: true }));
}

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-web-chat-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const { core, events, accounts } = kernelCore(root, { basePath: root, chatModel: "test:model", allowedChannels: [] });
  await core.start();
  const ctx = Object.assign(fakeHost({ baseDir: root, yesimbot: core, events, loader: { config: { plugins: { yesimbot: { basePath: root } } } } }), {
    emit: events.emit.bind(events),
  });
  const nativeMessenger = core.messenger;
  const channels = core.resource as Channels;
  // Several fake turns may run at once now that later messages no longer wait for a reply.
  const finishers: Array<() => void> = [];
  const finish = () => {
    for (const end of finishers.splice(0)) end();
  };
  const handle = vi.fn(async (record) => {
    const channel = await channels.resolve(webChatContext);
    const message = createMessage(record);
    await channel.conversation.storage.append(createEntry("message", message));
    ctx.emit("yesimbot/message", message);
    ctx.emit("yesimbot/turn", { context: webChatContext, turnId: record.messageId, active: true });
    return {
      kind: "run",
      eventId: message.id,
      done: new Promise<void>((resolve) => {
        finishers.push(() => {
          ctx.emit("yesimbot/turn", { context: webChatContext, turnId: record.messageId, active: false });
          resolve();
        });
      }),
    };
  });
  const messenger = new Messenger({
    allowedChannels: () => core.config.allowedChannels,
    channels,
    runtimes: { get: async () => ({ handle }), stop: async () => {} } as never,
    account: (platform, selfId) => accounts.find((account) => account.platform === platform && account.selfId === selfId),
    assignee: async () => undefined,
  });
  Object.assign(core, { messenger });
  vi.spyOn(core.model, "resolveChatModel").mockReturnValue({} as never);
  // The web chat registers as an account of Core and is listed among the host's bots, as `apps/server` does.
  ctx.openWebChat = (changed) => {
    const chat = new WebChat(core, changed, systemClock(), () => online.value);
    accounts.push(chat);
    (ctx.bots as unknown[]).push(chat);
    return chat;
  };
  const online = { value: true };
  const routes = new Map<string, (http: HttpContext) => Promise<void>>();
  Object.assign(ctx.server, {
    get: (path: string, handler: (http: HttpContext) => Promise<void>) => routes.set(`GET ${path}`, handler),
    post: (path: string, handler: (http: HttpContext) => Promise<void>) => routes.set(`POST ${path}`, handler),
  });
  const credential = join(root, "owner.json"),
    salt = Buffer.alloc(16, 1);
  await writeFile(
    credential,
    JSON.stringify({ version: 1, username: "alice", salt: salt.toString("base64"), hash: scryptSync("password-123456", salt, 64).toString("base64") }),
  );
  const auth = new AdminAuth({ enabled: true, credentialFile: credential, sessionHours: 1, publicOrigin: "http://console.test" }, credential);
  const cookie = `yesimbot_admin=${await auth.login("alice", "password-123456")}`;
  const topics = new TopicRegistry();
  const host = ctx;
  const chat = installChat(host, auth, topics);
  installEvents(host, auth, topics, { coalesceMs: 0, heartbeatMs: 20 });
  const bot = (ctx.bots as unknown as WebChat[]).find((item) => item.platform === "web")!;
  cleanup.push(async () => {
    finish();
    await messenger.stop();
  });
  const call = async (
    path = `${CHAT_PATH}/send`,
    body: unknown = { text: "hello", clientId: randomUUID() },
    headers: Record<string, string> = {},
    method = "POST",
    query: Record<string, unknown> = { topics: "chat" },
  ) => {
    const input = { cookie, origin: "http://console.test", "content-type": "application/json", ...headers };
    const req = new PassThrough();
    Object.assign(req, { socket: { setTimeout: vi.fn(), setNoDelay: vi.fn() } });
    const response: Record<string, string> = {};
    const http = {
      status: 200,
      body: undefined as unknown,
      request: { body },
      req,
      query,
      origin: "http://console.test",
      secure: false,
      get: (name: string) => input[name as keyof typeof input] ?? "",
      set: (key: string, value: string) => {
        response[key] = value;
      },
    };
    await routes.get(`${method} ${path}`)!(http as never);
    return { ...http, headers: response };
  };
  return { root, ctx, online, host, core, nativeMessenger, channels, bot, handle, finish, topics, chat, call, auth, cookie };
}

it("never puts an interface button into the web chat snapshot", async () => {
  const f = await fixture();
  expect((await f.call(undefined, { text: "连接 Google", clientId: randomUUID() })).status).toBe(202);
  await vi.waitFor(() => expect(f.bot.isAuthenticatedContext(webChatContext)).toBe(true));
  expect(await f.chat.snapshot()).not.toHaveProperty("actions");
});

it("updates its own configuration through a real web-origin service task, and offers the main agent the same change", async () => {
  const f = await fixture();
  vi.mocked(f.core.model.resolveChatModel).mockRestore();
  Object.assign(f.core, { messenger: f.nativeMessenger });
  cleanup.push(() => f.core.stop());
  const path = "yesimbot-schedule:local";
  const loader = f.ctx.loader;
  Object.assign(loader.config.plugins, { [path]: { title: "before", apiKey: "saved-secret", future: { retained: true } } });
  const writeConfig = vi.fn(async () => {});
  Object.assign(loader, {
    entry: f.ctx,
    writable: true,
    isTruthyLike: () => true,
    writeConfig,
    resolve: async () => ({
      moduleConfig: defineModuleConfig("chat-fixture", z.looseObject({ title: z.string().optional(), apiKey: z.string().optional().meta({ secret: true }) })),
    }),
    reload: async () => ({ isActive: true }),
    unload: vi.fn(),
  });
  const store = new ConfigStore(f.host, { selfService: true });
  installInstanceManagement(f.host, new Set());
  let requested = false,
    updated = false;
  const seen: { worker: boolean; tools: string[] }[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const tools = (request.tools ?? []).map((tool) => tool.name);
      const worker = tools.includes("task_report");
      seen.push({ worker, tools });
      let name = "finish",
        input: unknown = {};
      if (worker && !updated) {
        updated = true;
        name = "instance_config_write";
        input = {
          action: "update",
          path,
          revision: store.revision(),
          config: { title: "after", apiKey: { $secret: true, sourcePath: ["apiKey"] }, future: { retained: true } },
        };
      } else if (worker) {
        name = "task_report";
        input = { status: "succeeded", result: "SELF_CONFIG_UPDATED" };
      } else if (!requested) {
        requested = true;
        name = "task_create";
        input = { kind: "service", timeLimitMinutes: 30, instruction: "将本实例定时任务插件 title 改为 after，保留原秘密和其他字段，检查实际回执。" };
      }
      return {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `instance-call-${seen.length}`, toolName: name, input: JSON.stringify(input) },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
  f.core.model.register({
    id: "test",
    capabilities: { chat: true, embedding: false },
    chatModels: () => [{ id: "model", toolCall: true }],
    embeddingModels: () => [],
    chat: () => model,
  });
  expect((await f.call(undefined, { text: "修改本实例设置", clientId: randomUUID() })).status).toBe(202);
  await vi.waitFor(async () => expect((await f.core.tasks.store.list())[0]).toMatchObject({ status: "succeeded", notification: "unknown" }), { timeout: 5000 });
  await vi.waitFor(async () => expect((await f.chat.snapshot()).typing).toBe(false));
  expect(f.bot.belongsToRuntime(f.core)).toBe(true);
  expect(loader.config.plugins[path]).toEqual({ title: "after", apiKey: "saved-secret", future: { retained: true } });
  expect(writeConfig).toHaveBeenCalledTimes(1);
  expect(seen.some((request) => request.worker && request.tools.includes("instance_config_write"))).toBe(true);
  expect(seen.filter((request) => !request.worker).every((request) => request.tools.includes("instance_config_write"))).toBe(true);
});

it("runs the real Core agent with its registered role, memory plugin and retained private history", async () => {
  const f = await fixture();
  vi.mocked(f.core.model.resolveChatModel).mockRestore();
  Object.assign(f.core, { messenger: f.nativeMessenger });
  cleanup.push(() => f.core.stop());
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const finished = finishAfterSend(request);
      if (finished) return finished;
      const step = prompts.length;
      prompts.push(JSON.stringify(request.prompt));
      return {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          webSend(request, `real-reply-${step}`, `real reply ${step}`),
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
  f.core.model.register({
    id: "test",
    capabilities: { chat: true, embedding: false },
    chatModels: () => [{ id: "model", toolCall: true }],
    embeddingModels: () => [],
    chat: () => model,
  });
  const setup = vi.fn(() => ({ name: "existing-memory", appendSystemPrompt: () => "ACCOUNT_MEMORY_SENTINEL" }));
  f.core.agent.use({ roleProfile: { resolve: () => ({ characterDefinition: "ACTIVE_ROLE_CARD_SENTINEL" }) }, setup });
  for (const text of ["first private request", "second private request"]) {
    expect((await f.call(undefined, { text, clientId: randomUUID() })).status).toBe(202);
    const expected = text.startsWith("first") ? 1 : 2;
    await vi.waitFor(async () => {
      const snapshot = await f.chat.snapshot();
      expect(snapshot.messages.filter((message) => message.role === "bot")).toHaveLength(expected);
      expect(snapshot.typing).toBe(false);
    });
  }
  expect(setup.mock.calls[0][0]).toMatchObject(webChatContext);
  expect(prompts[0]).toContain("ACTIVE_ROLE_CARD_SENTINEL");
  expect(prompts[0]).toContain("ACCOUNT_MEMORY_SENTINEL");
  expect(prompts[1]).toContain("first private request");
  expect(prompts[1]).toContain("real reply 0");
  expect((await f.chat.snapshot()).messages.map((message) => message.text)).toEqual([
    "first private request",
    "real reply 0",
    "second private request",
    "real reply 1",
  ]);
});

it("delegates from web chat and returns the worker result", async () => {
  const f = await fixture();
  vi.mocked(f.core.model.resolveChatModel).mockRestore();
  Object.assign(f.core, { messenger: f.nativeMessenger });
  cleanup.push(() => f.core.stop());
  const execute = vi.fn(async () => ({ verified: "WEB_WORKER_PROOF" }));
  f.core.agent.use({
    setup: () => ({
      name: "web-worker-test",
      tools: [
        {
          name: "computer_exec",
          capability: { platforms: ["web"], sensitive: true, executionKind: "computer" },
          description: "Perform an isolated test operation",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute,
        },
      ],
    }),
  });
  let created = false;
  let calls = 0;
  const catalogs: string[][] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const finished = finishAfterSend(request);
      if (finished) return finished;
      const tools = (request.tools ?? []).map((tool) => tool.name);
      catalogs.push(tools);
      let step: { name: string; input: unknown } | undefined;
      if (tools.includes("task_report")) {
        step = execute.mock.calls.length
          ? { name: "task_report", input: { status: "succeeded", result: "WEB_WORKER_PROOF" } }
          : { name: "computer_exec", capability: { platforms: ["web"], sensitive: true, executionKind: "computer" }, input: {} };
      } else if (!created) {
        created = true;
        step = {
          name: "task_create",
          input: { kind: "computer", timeLimitMinutes: 30, instruction: "Perform the isolated test operation and verify its result." },
        };
      }
      const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
      if (step) parts.push({ type: "tool-call", toolCallId: `web-worker-${++calls}`, toolName: step.name, input: JSON.stringify(step.input) });
      else
        parts.push(
          webSend(request, `web-reply-${++calls}`, JSON.stringify(request.prompt).includes("WEB_WORKER_PROOF") ? "**WEB_WORKER_PROOF**" : "任务已受理"),
        );
      parts.push({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      });
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
  const selectedModel: import("@ai-sdk/provider").LanguageModelV3 = model;
  f.core.model.register({
    id: "test",
    capabilities: { chat: true, embedding: false },
    chatModels: () => [{ id: "model", toolCall: true }],
    embeddingModels: () => [],
    chat: () => selectedModel,
  });
  expect((await f.call(undefined, { text: "请用电脑执行一次隔离测试操作，并告诉我工具返回的 verified 标记。", clientId: randomUUID() })).status).toBe(202);
  await vi.waitFor(
    async () => {
      expect((await f.chat.snapshot()).messages.some((message) => message.role === "bot" && message.text.includes("WEB_WORKER_PROOF"))).toBe(true);
      expect((await f.core.tasks.store.list())[0]).toMatchObject({ status: "succeeded", notification: "delivered" });
    },
    { timeout: 10000, interval: 200 },
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await f.core.tasks.store.list()).toHaveLength(1);
  for (const tools of catalogs) {
    // Workers report through task_report; only the conversation's own agent sends messages.
    expect(tools.includes("send_message")).toBe(!tools.includes("task_report"));
    if (!tools.includes("task_report")) {
      expect(tools).toContain("task_create");
      // Like Muse, the main agent may run a simple command itself; this test's model still chose to delegate.
      expect(tools).toContain("computer_exec");
    }
  }
}, 150000);

it("retains the last intent between steps and clears it at turn end", async () => {
  const f = await fixture();
  const turn = { context: webChatContext, turnId: "intent-retention", active: true };
  f.ctx.emit("yesimbot/turn", { ...turn, activity: "正在查资料" });
  expect((await f.chat.snapshot()).activity).toBe("正在查资料");
  for (const activity of [undefined, "", "  "]) {
    f.ctx.emit("yesimbot/turn", { ...turn, activity });
    expect((await f.chat.snapshot()).activity).toBe("正在查资料");
    expect((await f.chat.snapshot()).typing).toBe(true);
  }
  f.ctx.emit("yesimbot/turn", { ...turn, activity: "正在核对版本" });
  expect((await f.chat.snapshot()).activity).toBe("正在核对版本");
  f.ctx.emit("yesimbot/turn", { ...turn, active: false });
  expect((await f.chat.snapshot()).activity).toBeUndefined();
  expect((await f.chat.snapshot()).typing).toBe(false);
  f.ctx.emit("yesimbot/turn", { ...turn, turnId: "next-turn" });
  expect((await f.chat.snapshot()).activity).toBeUndefined();
  f.ctx.emit("yesimbot/turn", { ...turn, turnId: "next-turn", active: false });
});

// User, 2026-11-18: 「消息都发出来了，但还是显示在思考/调用工具」.
it("stops showing the turn as busy once the bot has replied, until it states new work", async () => {
  const f = await fixture();
  const turn = { context: webChatContext, turnId: "wrap-up", active: true };
  f.ctx.emit("yesimbot/turn", { ...turn, activity: "检索最近对话" });
  expect(await f.chat.snapshot()).toMatchObject({ typing: true, activity: "检索最近对话" });
  await sendTo(f.bot, "owner", "看过了，还没有新工具。");
  let snapshot = await f.chat.snapshot();
  expect(snapshot.typing).toBe(false);
  expect(snapshot.activity).toBeUndefined();
  expect(snapshot.conversations?.[0]?.typing).toBeUndefined();
  // A later step with nothing new to say keeps it quiet; new stated work shows again.
  f.ctx.emit("yesimbot/turn", { ...turn });
  expect((await f.chat.snapshot()).typing).toBe(false);
  f.ctx.emit("yesimbot/turn", { ...turn, activity: "再查一次工具列表" });
  snapshot = await f.chat.snapshot();
  expect(snapshot).toMatchObject({ typing: true, activity: "再查一次工具列表" });
  f.ctx.emit("yesimbot/turn", { ...turn, active: false });
  expect((await f.chat.snapshot()).typing).toBe(false);
});

it("shows transient tool activity without persisting it in web messages", async () => {
  const f = await fixture();
  vi.mocked(f.core.model.resolveChatModel).mockRestore();
  Object.assign(f.core, { messenger: f.nativeMessenger });
  cleanup.push(() => f.core.stop());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let step = 0;
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const finished = finishAfterSend(request);
      if (finished) return finished;
      const index = step++;
      const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "private" },
        { type: "reasoning-delta", id: "private", delta: "PRIVATE_REASONING_SENTINEL" },
        { type: "reasoning-end", id: "private" },
      ];
      if (index < 2)
        parts.push(
          { type: "text-start", id: "public" },
          { type: "text-delta", id: "public", delta: index === 0 ? "我先查一下官方说明。" : "我再核对一下版本。" },
          { type: "text-end", id: "public" },
          { type: "tool-call", toolCallId: `lookup-${index}`, toolName: "lookup", input: "{}" },
        );
      else parts.push(webSend(request, "activity-reply", "**核对完成**"));
      parts.push({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      });
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
  f.core.model.register({
    id: "test",
    capabilities: { chat: true, embedding: false },
    chatModels: () => [{ id: "model", toolCall: true }],
    embeddingModels: () => [],
    chat: () => model,
  });
  const beforeExecution: string[][] = [];
  f.core.agent.use({
    setup: () => ({
      name: "lookup-fixture",
      tools: () => [
        {
          name: "lookup",
          capability: { platforms: ["web"], sensitive: false, executionKind: "read" },
          executionKind: "read",
          description: "Read reference documentation",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: async () => {
            beforeExecution.push((await f.chat.snapshot()).messages.map((message) => message.text));
            await gate;
            return { verified: true };
          },
        },
      ],
    }),
  });
  try {
    expect((await f.call(undefined, { text: "核对资料", clientId: randomUUID() })).status).toBe(202);
    await vi.waitFor(() => expect(beforeExecution).toHaveLength(1));
    expect(beforeExecution[0]).toEqual(["核对资料"]);
    expect((await f.chat.snapshot()).activity).toBe("我先查一下官方说明。");
    expect((await f.chat.snapshot()).typing).toBe(true);
    release();
    await vi.waitFor(async () => {
      const snapshot = await f.chat.snapshot();
      expect(snapshot.typing).toBe(false);
      expect(snapshot.activity).toBeUndefined();
      expect(snapshot.messages.map((message) => message.text)).toEqual(["核对资料", "**核对完成**"]);
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_REASONING_SENTINEL");
    });
    expect(beforeExecution[1]).toEqual(["核对资料"]);
  } finally {
    release();
  }
});

it("keeps web chat fixed while allowing its own role and model to change", async () => {
  const f = await fixture();
  vi.mocked(f.core.model.resolveChatModel).mockRestore();
  Object.assign(f.core, { messenger: f.nativeMessenger });
  cleanup.push(() => f.core.stop());
  const used: string[] = [];
  const reply = (name: string) => {
    return new MockLanguageModelV3({
      doStream: async (request) => {
        const finished = finishAfterSend(request);
        if (finished) return finished;
        used.push(name);
        return {
          stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
            { type: "stream-start", warnings: [] },
            webSend(request, `${name}-reply-${used.length}`, `${name} reply`),
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            },
          ]),
        };
      },
    });
  };
  const models = { model: reply("model"), other: reply("other") };
  f.core.model.register({
    id: "test",
    capabilities: { chat: true, embedding: false },
    chatModels: () => [
      { id: "model", toolCall: true },
      { id: "other", toolCall: true },
    ],
    embeddingModels: () => [],
    chat: (id: string) => models[id as keyof typeof models],
  });
  const cards: string[] = [];
  f.core.agent.use({
    roleProfile: {
      resolve: (scope: Parameters<typeof f.core.overrides.get>[0]) => {
        const card = f.core.overrides.get(scope)?.roleCard;
        cards.push(`${scope.type === "direct" ? scope.userId : ""}=${card ?? "@settings"}`);
        return { characterDefinition: `ROLE ${card ?? "current"}` };
      },
    },
    setup: () => ({ name: "role" }),
  });
  expect((await f.call(`${CHAT_PATH}/conversations`, { action: "create" })).status).toBe(400);
  expect((await f.call(`${CHAT_PATH}/conversations`, { action: "select", id: "12345678" })).status).toBe(400);
  expect((await f.call(undefined, { text: "wrong target", clientId: randomUUID(), conversation: "12345678" })).status).toBe(409);
  const id = "";
  expect((await f.call(`${CHAT_PATH}/conversations`, { action: "update", id, chatModel: "test:missing" })).body).toEqual({ message: "unknown_model" });
  expect((await f.call(`${CHAT_PATH}/conversations`, { action: "update", id, roleCard: "../outside.png" })).status).toBe(400);
  expect(
    (await f.call(`${CHAT_PATH}/conversations`, { action: "update", id, chatModel: "test:other", roleCard: "data/yesimbot/characters/b.png" })).status,
  ).toBe(200);
  expect((await f.call(undefined, { text: "hello there, new one", clientId: randomUUID(), conversation: id })).status).toBe(202);
  await vi.waitFor(async () => expect((await f.chat.snapshot(id)).messages.map((message) => message.text)).toEqual(["hello there, new one", "other reply"]));
  expect(used).toContain("other");
  expect(used).not.toContain("model");
  expect(cards).toContain(`owner=data/yesimbot/characters/b.png`);
  const snapshot = await f.chat.snapshot();
  // The open conversation is the new one; the first conversation's history is untouched.
  expect(snapshot.conversation.id).toBe(id);
  expect((await f.chat.snapshot("12345678")).conversation.id).toBe(id);
  expect(snapshot.conversations?.map((item) => [item.id, item.title, item.roleCard, item.chatModel])).toEqual([
    [id, "", "data/yesimbot/characters/b.png", "test:other"],
  ]);
  expect(snapshot.models?.map((model) => model.id)).toEqual(["test:model", "test:other"]);
  // Back to following 设置: the next turn uses the configured model.
  expect((await f.call(`${CHAT_PATH}/conversations`, { action: "update", id, chatModel: null, roleCard: null })).status).toBe(200);
  expect(f.core.overrides.get({ type: "direct", platform: "web", selfId: "bot", userId: "owner", channelId: "owner" })).toBeUndefined();
  expect((await f.call(`${CHAT_PATH}/conversations`, { action: "remove", id: "" })).status).toBe(400);
  expect((await f.call(`${CHAT_PATH}/conversations`, { action: "remove", id })).status).toBe(400);
  expect((await f.chat.snapshot()).conversations?.map((item) => item.id)).toEqual([""]);
});

it("interrupts the real Core request on a follow-up and publishes only the new web reply", async () => {
  const f = await fixture();
  vi.mocked(f.core.model.resolveChatModel).mockRestore();
  Object.assign(f.core, { messenger: f.nativeMessenger });
  cleanup.push(() => f.core.stop());
  let releaseFirst!: () => void;
  let releaseAnswer!: () => void;
  let firstSignal: AbortSignal | undefined;
  const answerGate = new Promise<void>((resolve) => (releaseAnswer = resolve));
  cleanup.push(() => {
    releaseFirst?.();
    releaseAnswer();
  });
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const finished = finishAfterSend(request);
      if (finished) return finished;
      const step = prompts.length;
      const prompt = JSON.stringify(request.prompt);
      prompts.push(prompt);
      if (step === 0) {
        firstSignal = request.abortSignal;
        await new Promise<void>((resolve, reject) => {
          releaseFirst = resolve;
          const aborted = () => reject(new DOMException("Superseded request", "AbortError"));
          if (firstSignal?.aborted) aborted();
          else firstSignal?.addEventListener("abort", aborted, { once: true });
        });
      } else await answerGate;
      const answer = step === 0 ? "draft before follow-up" : prompt.includes("follow-up request") ? "reply to both" : "missing follow-up";
      return {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          webSend(request, `interrupt-reply-${step}`, answer),
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
  f.core.model.register({
    id: "test",
    capabilities: { chat: true, embedding: false },
    chatModels: () => [{ id: "model", toolCall: true }],
    embeddingModels: () => [],
    chat: () => model,
  });
  const turns: string[] = [];
  f.ctx.on("yesimbot/turn", ({ turnId, active }) => {
    if (active) turns.push(turnId);
  });
  expect((await f.call(undefined, { text: "first request", clientId: randomUUID() })).status).toBe(202);
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  expect((await f.call(undefined, { text: "follow-up request", clientId: randomUUID() })).status).toBe(202);
  await vi.waitFor(() => {
    expect(firstSignal?.aborted).toBe(true);
    expect(prompts).toHaveLength(2);
  });
  // The follow-up is admitted immediately; the old request is cancelled before the new answer.
  await vi.waitFor(async () => {
    const snapshot = await f.chat.snapshot();
    expect(snapshot.typing).toBe(true);
    expect(snapshot.messages.map((message) => [message.text, message.status])).toEqual([
      ["first request", "sent"],
      ["follow-up request", "sent"],
    ]);
  });
  releaseAnswer();
  await vi.waitFor(async () => {
    const snapshot = await f.chat.snapshot();
    expect(snapshot.typing).toBe(false);
    expect(snapshot.messages.map((message) => message.text)).toEqual(["first request", "follow-up request", "reply to both"]);
  });
  expect(new Set(turns).size).toBe(2);
  expect(prompts[1]).toContain("first request");
  expect(prompts[1]).toContain("[CURRENT_MESSAGE]\\nfollow-up request");
});

it("hands Core one literal private input as the runtime owner and deduplicates retries during a running turn", async () => {
  const f = await fixture();
  const receive = vi.spyOn(f.core.messenger, "accept");
  const clientId = randomUUID();
  const response = await f.call(undefined, { text: "  <at id='other'/> & 你好  ", clientId });
  expect(response.status).toBe(202);
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledOnce());
  const [inbound, strict] = receive.mock.calls[0]!;
  expect(inbound.context).toEqual({ type: "direct", platform: "web", channelId: "owner", selfId: "bot", userId: "owner", userName: "alice" });
  expect(strict).toBe(true);
  // The text stays literal: markup in it is not read as a mention.
  expect(f.handle.mock.calls[0][0].parts).toEqual([{ type: "text", text: "<at id='other'/> & 你好" }]);
  expect(f.handle.mock.calls[0][0]).toMatchObject({ platform: "web", selfId: "bot", user: { id: "owner", name: "alice" }, channel: { id: "owner", type: 1 } });
  expect((await f.chat.snapshot()).typing).toBe(true);
  expect(response.body).toEqual({ messageId: clientId });
  expect((await f.chat.snapshot()).messages.map((message) => message.id)).toContain(clientId);
  const retry = await f.call(undefined, { text: "different retry text", clientId: clientId.toUpperCase() });
  expect(retry.body).toEqual(response.body);
  expect(receive).toHaveBeenCalledOnce();
  f.finish();
  await vi.waitFor(async () => expect((await f.chat.snapshot()).typing).toBe(false));
});

it("captures actual normal sends, attachments and SSE updates, retaining web history after a fresh reader", async () => {
  const f = await fixture();
  const events = await f.call("/yesimbot/api/v1/events", undefined, {}, "GET");
  const stream = events.body as PassThrough;
  let wire = "";
  stream.on("data", (chunk) => {
    wire += chunk;
  });
  cleanup.push(() => events.req.emit("close"));
  await f.call();
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(wire).toContain('"typing":true'));
  const [id] = await sendTo(f.bot, "owner", [
    h.text("actual <reply> & text"),
    h.image("file:///secret.png"),
    h("file", { src: "https://external.test/private", title: "notes.txt" }),
  ]);
  const snapshot = await f.chat.snapshot();
  expect(snapshot.messages.at(-1)).toMatchObject({
    id,
    role: "bot",
    text: "actual <reply> & text",
    attachments: [
      { kind: "image", name: "图片" },
      { kind: "file", name: "notes.txt" },
    ],
  });
  expect(JSON.stringify(snapshot)).not.toMatch(/file:|external.test/);
  await vi.waitFor(() => expect(wire).toContain(id));
  f.finish();
  await vi.waitFor(() => expect(wire).toContain('"typing":false'));
  const index = await buildConversationIndex(f.host, chatHistory);
  expect(index.channels).toHaveLength(1);
  expect(index.channels[0]).toMatchObject({ platform: "web", type: "direct", userId: "owner", selfId: "bot" });
  const detail = await readConversationDetail(f.host, snapshot.conversation, chatHistory);
  expect(detail.entries.find((item) => item.messageId === id)).toMatchObject({ kind: "assistant", eventType: "platform-message" });
  await expect(sendTo(f.bot, "other", "no")).rejects.toThrow("target_denied");
});

it("shows only current-session transport messages and preserves archived detail", async () => {
  const f = await fixture();
  const channel = await f.channels.resolve(webChatContext);
  for (let i = 0; i < 55; i++) await sendTo(f.bot, "owner", `reply ${i}`);
  await channel.conversation.storage.append(createEntry("message", { role: "assistant", content: [{ type: "text", text: "private model thought" }] }));
  const old = await f.core.conversation.locate(webChatContext);
  await channel.conversation.archive(true);
  await sendTo(f.bot, "owner", "new session");
  const snapshot = await f.chat.snapshot();
  expect(snapshot.messages).toHaveLength(1);
  expect(snapshot.messages.at(-1)?.text).toBe("new session");
  expect(JSON.stringify(snapshot)).not.toContain("private model thought");
  expect(snapshot.conversation.session).not.toBe(old.session);
  expect((await readConversationDetail(f.host, old, chatHistory)).hasMore).toBe(true);
});

it("bounds pending messages, validates body/auth/origin and reports readiness without dispatch", async () => {
  const f = await fixture();
  expect((await f.call(undefined, undefined, { cookie: "" })).status).toBe(401);
  expect((await f.call(undefined, undefined, { origin: "http://evil.test" })).status).toBe(403);
  expect((await f.call(CHAT_PATH, undefined, { origin: "http://evil.test" }, "GET")).status).toBe(403);
  for (const body of [
    { text: " ", clientId: randomUUID() },
    { text: "x".repeat(4001), clientId: randomUUID() },
    { text: "x", clientId: "bad" },
    { text: "x", clientId: randomUUID(), userId: "other" },
    { text: 42, clientId: randomUUID() },
    { text: "x".repeat(33000), clientId: randomUUID() },
  ])
    expect((await f.call(undefined, body)).status).toBe(400);
  expect(f.handle).not.toHaveBeenCalled();
  f.online.value = false;
  expect((await f.call()).body).toEqual({ message: "runtime_not_ready" });
  f.online.value = true;
  vi.mocked(f.core.model.resolveChatModel).mockImplementationOnce(() => {
    throw new Error("missing model");
  });
  expect((await f.call()).status).toBe(503);
  // Only messages Core has not saved yet count: hold the first one before it is saved.
  let save!: () => void;
  const held = f.handle.getMockImplementation()!;
  f.handle.mockImplementationOnce(async (record) => {
    await new Promise<void>((resolve) => (save = resolve));
    return held(record);
  });
  const ids: string[] = [];
  for (let i = 0; i < CHAT_PENDING_LIMIT; i++) {
    const id = randomUUID();
    ids.push(id);
    expect((await f.call(undefined, { text: "x", clientId: id })).status).toBe(202);
  }
  const busy = await f.call();
  expect([busy.status, busy.body]).toEqual([429, { message: "busy" }]);
  expect((await f.call(undefined, { text: "retry", clientId: ids[0] })).status).toBe(202);
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledOnce());
  save();
  // Once saved, the rest are handed to Core in order while the first reply is still running.
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledTimes(CHAT_PENDING_LIMIT));
  expect(f.handle.mock.calls.map(([record]) => record.messageId)).toEqual(
    await Promise.all(ids.map(async (id) => (await f.call(undefined, { text: "retry", clientId: id })).body)).then((bodies) =>
      bodies.map((body) => (body as { messageId: string }).messageId),
    ),
  );
  expect((await f.call()).status).toBe(202);
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledTimes(CHAT_PENDING_LIMIT + 1));
  f.finish();
});

it("hands a message sent during a long reply to Core at once, like a QQ private chat, keeping order", async () => {
  const f = await fixture();
  const first = await f.call(undefined, { text: "first", clientId: randomUUID() });
  await vi.waitFor(async () => expect((await f.chat.snapshot()).typing).toBe(true));
  const second = await f.call(undefined, { text: "second", clientId: randomUUID() });
  const third = await f.call(undefined, { text: "third", clientId: randomUUID() });
  // The first turn has not finished, yet both follow-ups reach Core in their original order.
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledTimes(3));
  expect(f.handle.mock.calls.map(([record]) => record.messageId)).toEqual([first, second, third].map((r) => (r.body as { messageId: string }).messageId));
  const { messages } = await f.chat.snapshot();
  expect(messages.map((message) => [message.text, message.status])).toEqual([
    ["first", "sent"],
    ["second", "sent"],
    ["third", "sent"],
  ]);
  f.finish();
  await vi.waitFor(async () => expect((await f.chat.snapshot()).typing).toBe(false));
});

it("accepts 4000 Unicode characters and rechecks authentication after asynchronous reads", async () => {
  const f = await fixture();
  const text = "😀".repeat(4000);
  expect((await f.call(undefined, { text, clientId: randomUUID() })).status).toBe(202);
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledOnce());
  expect(f.handle.mock.calls[0][0].parts).toEqual([{ type: "text", text }]);
  expect((await f.call(CHAT_PATH, undefined, { origin: "" }, "GET")).status).toBe(200);
  const locate = f.core.conversation.locate;
  vi.spyOn(f.core.conversation, "locate").mockImplementation(async (context) => {
    const result = await locate(context);
    f.auth.logout(f.cookie);
    return result;
  });
  const response = await f.call(CHAT_PATH, undefined, {}, "GET");
  expect([response.status, response.body]).toEqual([401, { message: "login_required" }]);
});

it("denies parent members and stale sessions, and only accepts a manager-bound display name", async () => {
  const f = await fixture();
  const original = f.auth.sessionFromCookie.bind(f.auth);
  const session = original(f.cookie)!;
  session.role = "member";
  vi.spyOn(f.auth, "sessionFromCookie").mockReturnValue(session);
  expect((await f.call()).status).toBe(403);
  expect(f.topics.get("chat")!.authorize(session)).toBe(false);
  session.role = "owner";
  vi.mocked(f.auth.sessionFromCookie).mockReturnValueOnce(session).mockReturnValueOnce(session).mockReturnValueOnce(undefined);
  expect((await f.call()).status).toBe(401);
  vi.mocked(f.auth.sessionFromCookie).mockImplementation(original);
  const name = Buffer.from("member-alice").toString("base64url");
  const proof = createHmac("sha256", f.cookie).update(`web-chat:${name}`).digest("hex");
  vi.stubEnv("YESIMBOT_TENANT_ID", "");
  const headers: Record<string, string> = { cookie: f.cookie, "x-yesimbot-chat-name": name, "x-yesimbot-chat-proof": proof };
  expect(relayChatUsername({ get: (key) => headers[key] ?? "" }, "alice")).toBe("alice");
  vi.stubEnv("YESIMBOT_TENANT_ID", "11111111-1111-4111-8111-111111111111");
  await f.call(undefined, undefined, { "x-yesimbot-chat-name": name, "x-yesimbot-chat-proof": "0".repeat(64) });
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledOnce());
  expect(f.handle.mock.calls[0][0].user.name).toBe("alice");
  f.finish();
  await f.call(undefined, undefined, { "x-yesimbot-chat-name": name, "x-yesimbot-chat-proof": proof });
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledTimes(2));
  expect(f.handle.mock.calls[1][0].user).toEqual({ id: "owner", name: "member-alice" });
  f.finish();
});

it("keeps failed admission visible and idempotent until the ten-minute receipt expires", async () => {
  const f = await fixture();
  const receive = vi.spyOn(f.core.messenger, "accept").mockRejectedValue(new Error("closed"));
  const clientId = randomUUID();
  const first = await f.call(undefined, { text: "hello", clientId });
  await vi.waitFor(async () => expect((await f.chat.snapshot()).messages[0]?.status).toBe("failed"));
  expect((await f.call(undefined, { text: "retry", clientId })).body).toEqual(first.body);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
  // The message ID is the client's own ID, so the page can list it whether or not the answer arrived.
  expect((await f.call(undefined, { text: "retry", clientId })).body).toEqual({ messageId: clientId });
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
});

it("keeps input that Core already persisted as sent when a later admission step fails", async () => {
  const f = await fixture();
  const receive = vi.spyOn(f.core.messenger, "accept");
  f.handle.mockImplementationOnce(async (record) => {
    const channel = await f.channels.resolve(webChatContext);
    const message = createMessage(record);
    await channel.conversation.storage.append(createEntry("message", message));
    f.ctx.emit("yesimbot/message", message);
    throw new Error("will failed after persistence");
  });
  const clientId = randomUUID();
  const response = await f.call(undefined, { text: "persisted once", clientId });
  await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
  await expect(receive.mock.results[0].value).rejects.toThrow("will failed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const { messages } = await f.chat.snapshot();
  expect(messages).toEqual([
    expect.objectContaining({ id: (response.body as { messageId: string }).messageId, role: "user", text: "persisted once", status: "sent" }),
  ]);
  expect((await f.call(undefined, { text: "retry", clientId })).body).toEqual(response.body);
  expect(receive).toHaveBeenCalledOnce();
});

it("reads only the fixed web channel, so an unrelated damaged manifest cannot break the chat", async () => {
  const f = await fixture();
  await sendTo(f.bot, "owner", "still readable");
  const foreign = join(f.root, "channels", "guild-onebot-1");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "channel.json"), "{damaged");
  expect((await f.chat.snapshot()).messages.map((message) => message.text)).toEqual(["still readable"]);
  expect((await f.call(CHAT_PATH, undefined, {}, "GET")).status).toBe(200);
});

it("persists uploaded attachment references for the model while presenting only their filenames", async () => {
  const f = await fixture();
  const deviceId = randomUUID();
  vi.spyOn(f.core.devices, "workspaceDevice").mockReturnValue(deviceId);
  vi.spyOn(f.core.devices, "list").mockResolvedValue([
    { deviceId, tenantId: randomUUID(), name: "test", platform: "win32", createdAt: 0, online: true, capabilities: ["workspace.files"] },
  ]);
  vi.spyOn(f.core.devices, "invoke").mockResolvedValue({ status: "succeeded", output: { bytes: 5 } });
  const uploaded = await f.call(`${CHAT_PATH}/uploads`, { name: "note.txt", data: Buffer.from("hello").toString("base64") });
  expect(uploaded.status).toBe(200);
  const file = uploaded.body as { id: string };
  const sent = await f.call(undefined, { text: "请检查", clientId: randomUUID(), uploads: [file.id] });
  expect(sent.status).toBe(202);
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalled());
  const snapshot = await f.chat.snapshot();
  expect(snapshot.messages[0]).toMatchObject({ text: "请检查", attachments: [{ kind: "file", name: "note.txt" }] });
  expect(JSON.stringify(snapshot.messages)).not.toContain("workspace:///");
  expect(JSON.stringify(f.handle.mock.calls[0][0])).toContain("workspace:///");
  f.finish();
});

it("shows a sent image and the bot's own image and file from the conversation's assets, without a computer", async () => {
  const f = await fixture();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("tiny image")]);
  const uploaded = await f.call(`${CHAT_PATH}/uploads`, { name: "截图.png", data: png.toString("base64") });
  expect(uploaded.body).toMatchObject({ kind: "image", name: "截图.png" });
  const sent = await f.call(undefined, { text: "看看这张", clientId: randomUUID(), uploads: [(uploaded.body as { id: string }).id] });
  expect(sent.status).toBe(202);
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalled());
  // The bot is shown the image itself (an asset), not a path it would have to open.
  const asset = (f.handle.mock.calls[0][0].parts as Part[]).find((part): part is ImagePart => part.type === "image")?.asset as string;
  expect(asset).toMatch(/^[a-f0-9]{32}$/);
  const fetch = async (url: string) => {
    const query = Object.fromEntries(new URL(url, "http://console.test").searchParams);
    return f.call(url.split("?")[0], undefined, {}, "GET", query);
  };
  let snapshot = await f.chat.snapshot();
  const mine = snapshot.messages.find((message) => message.role === "user")!;
  expect(mine).toMatchObject({ text: "看看这张", attachments: [{ kind: "image", name: "截图.png", size: png.length }] });
  const image = await fetch(mine.attachments![0]!.url!);
  expect(Buffer.from(image.body as Buffer).equals(png)).toBe(true);
  expect(image.headers).toMatchObject({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" });
  expect(image.headers["Content-Security-Policy"]).toContain("sandbox");
  f.finish();

  const chart = Buffer.concat([png, Buffer.from("chart")]);
  await sendTo(f.bot, "owner", [
    h.text("图和报告在这"),
    h("img", { src: `data:image/png;base64,${chart.toString("base64")}` }),
    h("file", { src: `data:text/markdown;base64,${Buffer.from("# 报告\n内容").toString("base64")}`, title: "report.md" }),
    // Any kind of file (user, 2026-11-17): kept under its name, offered as a download.
    h("file", { src: `data:application/pdf;base64,${Buffer.from("%PDF-1.7\0binary").toString("base64")}`, title: "季度报告.pdf" }),
    // Never a fake image, nor a source Core did not read.
    h("img", { src: `data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}` }),
    h.image("file:///secret.png"),
  ]);
  snapshot = await f.chat.snapshot();
  const reply = snapshot.messages.at(-1)!;
  expect(reply).toMatchObject({ role: "bot", text: "图和报告在这" });
  expect(reply.attachments!.map(({ kind, name, url }) => ({ kind, name, kept: !!url }))).toEqual([
    { kind: "image", name: "图片", kept: true },
    { kind: "file", name: "report.md", kept: true },
    { kind: "file", name: "季度报告.pdf", kept: true },
    { kind: "image", name: "图片", kept: false },
    { kind: "image", name: "图片", kept: false },
  ]);
  expect(Buffer.from((await fetch(reply.attachments![0]!.url!)).body as Buffer).equals(chart)).toBe(true);
  const report = await fetch(reply.attachments![1]!.url!);
  expect(report.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
  expect(Buffer.from(report.body as Buffer).toString()).toBe("# 报告\n内容");
  const download = await fetch(`${reply.attachments![1]!.url!}&download=1`);
  expect(download.headers["Content-Disposition"]).toBe(`attachment; filename*=UTF-8''report.md`);
  const pdf = await fetch(reply.attachments![2]!.url!);
  expect(Buffer.from(pdf.body as Buffer).toString()).toBe("%PDF-1.7\0binary");
  expect(pdf.headers["Content-Disposition"]).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("季度报告.pdf")}`);
  expect(JSON.stringify(snapshot)).not.toMatch(/data:|file:|asset:\/\//);

  // Only an existing conversation's own assets, and only to its owner.
  const url = new URL(reply.attachments![0]!.url!, "http://console.test");
  expect((await f.call(url.pathname, undefined, {}, "GET", { c: "nope", asset: url.searchParams.get("asset") })).status).toBe(404);
  expect((await f.call(url.pathname, undefined, {}, "GET", { c: "", asset: "../channel" })).status).toBe(400);
  expect((await f.call(url.pathname, undefined, { cookie: "" }, "GET", Object.fromEntries(url.searchParams))).status).toBe(401);
});

// User, 2026-11-18 (「全做」): clickable choices, emoji reactions, its computer work in the chat, and a stop button.
it("shows clickable choices and the bot's reactions, and stops a reply on request", async () => {
  const f = await fixture();
  const [botMessage] = await sendTo(f.bot, "owner", [h.text("要我替你发吗？"), h("web-choices", { options: ["替我发", "先等等", 7] })]);
  let snapshot = await f.chat.snapshot();
  expect(snapshot.messages.at(-1)).toMatchObject({ id: botMessage, role: "bot", text: "要我替你发吗？", choices: ["替我发", "先等等"] });

  // The bot reacts to the user's message, never to its own or to one from elsewhere.
  await f.call();
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledOnce());
  const userMessage = (f.handle.mock.calls[0] as unknown as [{ messageId: string }])[0].messageId;
  const plugins = await f.core.agent.setup(webChatContext, f.bot as never);
  const tools = plugins.flatMap((plugin) => (typeof plugin.tools === "function" ? [] : (plugin.tools ?? [])));
  const react = tools.find((tool) => tool.name === "web_create_reaction")!;
  expect(react).toBeDefined();
  const execution = {} as never;
  expect(await react.execute({ messageId: userMessage, emoji: "两个字" }, execution)).toMatchObject({ ok: false, error: { name: "InvalidEmoji" } });
  expect(await react.execute({ messageId: botMessage, emoji: "👍" }, execution)).toMatchObject({ ok: false, error: { name: "MessageNotFound" } });
  expect(await react.execute({ messageId: "elsewhere", emoji: "👍" }, execution)).toMatchObject({ ok: false });
  expect(await react.execute({ messageId: userMessage, emoji: "👍" }, execution)).toMatchObject({ ok: true });
  expect(await react.execute({ messageId: userMessage, emoji: "❤️" }, execution)).toMatchObject({ ok: true, emoji: "❤️" });
  snapshot = await f.chat.snapshot();
  expect(snapshot.messages.find((message) => message.id === userMessage)?.reaction).toBe("❤️");
  expect(snapshot.messages.find((message) => message.id === botMessage)?.reaction).toBeUndefined();
  // Other platforms never get the web reaction tool.
  const qq = await f.core.agent.setup({ type: "direct", platform: "onebot", selfId: "1", userId: "2", channelId: "private:2" }, f.bot as never);
  expect(qq.flatMap((plugin) => (typeof plugin.tools === "function" ? [] : (plugin.tools ?? []))).map((tool) => tool.name)).not.toContain(
    "web_create_reaction",
  );

  // The stop button: validated, owner-only, and says whether a reply was running.
  expect((await f.call(`${CHAT_PATH}/stop`, { conversation: "" })).body).toEqual({ stopped: false });
  expect((await f.call(`${CHAT_PATH}/stop`, { conversation: "zzzz" })).status).toBe(400);
  expect((await f.call(`${CHAT_PATH}/stop`, { conversation: "0000abcd" })).status).toBe(404);
  expect((await f.call(`${CHAT_PATH}/stop`, { conversation: "" }, { cookie: "" })).status).toBe(401);
  const interrupt = vi.spyOn(f.core.conversation, "interrupt").mockResolvedValue(true);
  expect((await f.call(`${CHAT_PATH}/stop`, { conversation: "" })).body).toEqual({ stopped: true });
  expect(interrupt).toHaveBeenCalledWith(webConversationContext(""));
});

import { randomUUID, scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import { systemClock } from "@yesimbot/foundation";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import type { ChannelContext, Channels } from "../../../core/src/channels/index.js";
import { WHISPER_SENDER } from "../../../core/src/messages/index.js";
import { AdminAuth } from "../src/admin-auth.js";
import { buildConversationIndex, readConversationDetail } from "../src/conversation-history.js";
import type { PromptOverview } from "../src/shared/prompt.js";
import { channelContext, installGlobalBrain, WHISPER_PATH, whisperOutputs } from "../src/webui/global-brain.js";
import { chatHistory } from "../src/webui/history.js";
import type { HttpContext } from "../src/webui/plugins.js";
import { installPromptOverview, PROMPT_PATH } from "../src/webui/prompt.js";
import { WebChat } from "../src/webui/web-chat.js";
import { fakeHost } from "./fixtures/fake-host.js";
import { kernelCore, receive, textAccount } from "./fixtures/kernel-core.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

// A QQ-style group: its channel is the guild itself.
const group = { type: "guild" as const, platform: "onebot", channelId: "room-1", guildId: "room-1", selfId: "bot-1" };

type Step = { tool: string; input: Record<string, unknown> };

async function fixture(
  respond?: (request: { prompt: string; tools: string[] }) => Step,
  liveModel?: import("@ai-sdk/provider").LanguageModelV3,
  direct = false,
) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-global-brain-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  // The account holder's own QQ is a registered admin, so sensitive work they ask for runs (user, 2026-11-18).
  const { core, events, accounts, assigned } = kernelCore(root, {
    basePath: root,
    chatModel: "test:model",
    allowedChannels: [{ platform: "onebot", channelId: "*" }],
    admins: [{ platform: "onebot", userId: "owner" }],
  });
  await core.start();
  cleanup.push(() => core.stop());
  assigned.selfId = "bot-1";
  const ctx = fakeHost({ baseDir: root, yesimbot: core, events, loader: { config: { plugins: { yesimbot: { basePath: root } } } } });

  // Each request records what the model saw and answers with the next scripted tool call.
  const requests: { prompt: string; tools: string[] }[] = [];
  const script: Step[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      requests.push({ prompt: JSON.stringify(request.prompt), tools: (request.tools ?? []).map((tool) => tool.name) });
      if (liveModel) return liveModel.doStream(request);
      const step = respond?.(requests.at(-1)!) ?? script.shift() ?? { tool: "finish", input: {} };
      return {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `call-${requests.length}`, toolName: step.tool, input: JSON.stringify(step.input) },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
  core.model.register({
    id: "test",
    capabilities: { chat: true, embedding: false },
    chatModels: () => [{ id: "model", toolCall: true }],
    embeddingModels: () => [],
    chat: () => model,
  });
  const bot = textAccount();
  accounts.push(bot);
  (ctx.bots as unknown[]).push(bot);

  const routes = new Map<string, (http: HttpContext) => Promise<void>>();
  Object.assign(ctx.server, {
    get: (path: string, handler: (http: HttpContext) => Promise<void>) => routes.set(`GET ${path}`, handler),
    post: (path: string, handler: (http: HttpContext) => Promise<void>) => routes.set(path, handler),
  });
  const credential = join(root, "owner.json"),
    salt = Buffer.alloc(16, 1);
  await writeFile(
    credential,
    JSON.stringify({ version: 1, username: "alice", salt: salt.toString("base64"), hash: scryptSync("password-123456", salt, 64).toString("base64") }),
  );
  const auth = new AdminAuth({ enabled: true, credentialFile: credential, sessionHours: 1, publicOrigin: "http://console.test" }, credential);
  const cookie = `yesimbot_admin=${await auth.login("alice", "password-123456")}`;
  const plugins: Parameters<typeof core.agent.use>[0][] = [];
  const use = core.agent.use.bind(core.agent);
  vi.spyOn(core.agent, "use").mockImplementation((plugin) => {
    plugins.push(plugin as never);
    return use(plugin as never);
  });
  installGlobalBrain(ctx, auth);
  installPromptOverview(ctx, auth);
  const get = async (path: string, query: Record<string, string> = {}) => {
    const headers: Record<string, string> = { cookie };
    const http = { status: 200, body: undefined as unknown, query, get: (name: string) => headers[name] ?? "", set: () => {} };
    await routes.get(`GET ${path}`)!(http as never);
    return http;
  };

  const post = async (body: unknown) => {
    const headers: Record<string, string> = { cookie, origin: "http://console.test", "content-type": "application/json" };
    const http = {
      status: 200,
      body: undefined as unknown,
      request: { body },
      origin: "http://console.test",
      get: (name: string) => headers[name] ?? "",
      set: () => {},
    };
    await routes.get(WHISPER_PATH)!(http as never);
    return http;
  };
  // The conversation exists once Core has resolved it, as after its first message.
  const channels = core.resource as Channels;
  const context = direct ? { type: "direct" as const, platform: "onebot", channelId: "private:owner", selfId: "bot-1", userId: "owner" } : group;
  await channels.resolve(context);
  const key = (await buildConversationIndex(ctx, chatHistory, false)).channels.find((channel) => channel.channelId === context.channelId)!.key;
  const entries = async () => {
    const summary = (await buildConversationIndex(ctx, chatHistory, false)).channels.find((channel) => channel.key === key)!;
    return (await readConversationDetail(ctx, { channel: key, session: summary.activeSession!, limit: 200 }, chatHistory)).entries;
  };
  return { ctx, core, accounts, bot, requests, script, post, get, key, entries, plugins, root, context };
}

it("posts the account holder's private word into a chat, answers privately in that turn only, and keeps it in context", async () => {
  const f = await fixture();
  f.script.push(
    { tool: "reply_owner", input: { text: "好的，我少聊游戏" } },
    { tool: "send_message", input: { parts: [{ kind: "text", text: "大家今天聊点别的吧" }] } },
    { tool: "finish", input: {} },
  );

  const plugin = f.plugins.find((plugin) => (plugin as { id?: string }).id === "yesimbot-console")!;
  const brain = await plugin.setup({ type: "direct", platform: "web", channelId: "owner", selfId: "bot", userId: "owner" }, {} as never);
  const relay = (brain!.tools as AgentTool[]).find((tool) => tool.name === "relay_to_conversation")!;
  await relay.execute({ conversation: f.key, text: "少说点游戏的事" }, { abortSignal: new AbortController().signal } as never);
  await vi.waitFor(async () => expect(f.requests.length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
  await vi.waitFor(async () => expect((await f.entries()).some((entry) => entry.toolName === "finish" && entry.kind === "tool-result")).toBe(true));

  // The model was told who said it and that the chat never saw it; reply_owner was offered.
  expect(f.requests[0].prompt).toContain(JSON.stringify(WHISPER_SENDER).slice(1, -1));
  expect(f.requests[0].prompt).toContain("少说点游戏的事");
  expect(f.requests[0].tools).toContain("reply_owner");
  // The chat got only the chat message; the private answer never went to the platform.
  expect(f.bot.sent.join("")).toContain("大家今天聊点别的吧");
  expect(f.bot.sent.join("")).not.toContain("我少聊游戏");

  const entries = await f.entries();
  const word = entries.find((entry) => entry.kind === "user")!;
  expect(word).toMatchObject({ whisper: true, sender: "主人", text: "少说点游戏的事" });
  expect(whisperOutputs(entries, word.messageId!)).toEqual({ privateReplies: ["好的，我少聊游戏"], chatMessages: ["大家今天聊点别的吧"] });

  // A later turn on an ordinary group message: no reply_owner, and the word is still in its history.
  const before = f.requests.length;
  await receive(f.core, { context: group, text: "bot-1 在吗", messageId: "m-2", userName: "群友", mention: true });
  await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(before));
  const later = f.requests[before];
  expect(later.tools).not.toContain("reply_owner");
  expect(later.prompt).toContain("少说点游戏的事");
});

it("gives web conversations tools to list, read and relay, returning the other turn's private answer and chat messages", async () => {
  const f = await fixture();
  const consolePlugin = f.plugins.find((plugin) => (plugin as { id?: string }).id === "yesimbot-console")!;
  const web = { type: "direct" as const, platform: "web", channelId: "owner", selfId: "bot", userId: "owner" };
  const brain = await consolePlugin.setup(web, {} as never);
  const tools = new Map(((brain!.tools as AgentTool[]) ?? []).map((tool) => [tool.name, tool]));
  expect([...tools.keys()]).toEqual(["list_conversations", "read_conversation", "relay_to_conversation"]);
  // A chat conversation gets only reply_owner, never the brain tools.
  const chat = await consolePlugin.setup(group, f.bot as never);
  expect(((chat!.tools as AgentTool[]) ?? []).map((tool) => tool.name)).toEqual(["reply_owner"]);

  const execute = (name: string, input: unknown) => tools.get(name)!.execute(input, { abortSignal: new AbortController().signal } as never);
  const listed = (await execute("list_conversations", {})) as { conversations: { conversation: string; kind: string }[] };
  expect(listed.conversations).toEqual([expect.objectContaining({ conversation: f.key, kind: "群聊" })]);

  f.script.push(
    { tool: "reply_owner", input: { text: "收到，我去说" } },
    { tool: "send_message", input: { parts: [{ kind: "text", text: "主人说今晚八点开会" }] } },
    { tool: "finish", input: {} },
  );
  const relayed = await execute("relay_to_conversation", { conversation: f.key, text: "告诉大家今晚八点开会" });
  expect(relayed).toEqual({ ok: true, status: "done", privateReplies: ["收到，我去说"], chatMessages: ["主人说今晚八点开会"] });

  const read = (await execute("read_conversation", { conversation: f.key })) as { messages: { from: string; text: string }[] };
  expect(read.messages.map((line) => [line.from, line.text])).toEqual([
    ["主人（私话）", "告诉大家今晚八点开会"],
    ["你（私下回主人）", "收到，我去说"],
    ["你", "主人说今晚八点开会"],
  ]);
  expect(await execute("relay_to_conversation", { conversation: "nope", text: "x" })).toEqual({ ok: false, error: "conversation_not_found" });
});

it.each(["web-first", "chat-first"])("isolates web guidance across real platform runtimes (%s)", async (order) => {
  const f = await fixture();
  f.core.agent.use({
    roleProfile: { resolve: () => ({ characterDefinition: "SHARED_PLATFORM_ROLE_SENTINEL" }) },
    setup: () => ({ name: "shared-role" }),
  });
  const webBot = new WebChat(
    f.core,
    () => {},
    systemClock(),
    () => true,
  );
  f.accounts.push(webBot);
  for (const platform of ["onebot", "wechat-bridge", "xiaoheihe"]) f.accounts.push(textAccount(platform, "bot"));

  const direct = { type: "direct" as const, channelId: "owner", userId: "owner", selfId: "bot" };
  const contexts: ChannelContext[] = [
    { ...direct, platform: "web" },
    { ...direct, platform: "onebot" },
    { type: "guild", platform: "onebot", channelId: "owner", guildId: "owner", selfId: "bot" },
    { ...direct, platform: "wechat-bridge" },
    { ...direct, platform: "xiaoheihe" },
  ];
  const ordered = order === "web-first" ? contexts : [...contexts].reverse();
  const roleSections = new Set<string>();
  // Revisit the cached runtimes after every platform has initialized in this same Core instance.
  for (const context of [...ordered, ...ordered]) {
    const preview = await f.core.conversation.prompt(context);
    const text = preview.segments
      .filter((segment) => segment.enabled)
      .map((segment) => segment.text ?? "")
      .join("\n");
    const web = context.platform === "web";
    for (const marker of ["每一项显示为一条 Markdown 消息", "只在等待动画旁作为临时状态显示", "后台任务仍绑定发起它的会话"])
      expect(text.includes(marker), `${context.platform}/${context.type}: ${marker}`).toBe(web);
    expect(preview.segments.some((segment) => segment.key === "plugin:global-brain")).toBe(web);
    expect(preview.tools.some((tool) => tool.name === "send_message")).toBe(true);
    expect(text.includes("文字消息使用 send_message")).toBe(!web);
    const role = preview.segments.find((segment) => segment.key === "role")?.text ?? "";
    expect(role).toContain("SHARED_PLATFORM_ROLE_SENTINEL");
    roleSections.add(role);
  }
  expect(roleSections.size).toBe(1);
});

it("keeps cross-conversation guidance visible to the real web main and service worker across the tool boundary", async () => {
  let delegated = false;
  const f = await fixture((request) => {
    if (request.tools.includes("task_report")) return { tool: "task_report", input: { status: "succeeded", result: "RELAY_GUIDANCE_CHECKED" } };
    if (!delegated) {
      delegated = true;
      return {
        tool: "task_create",
        input: { kind: "service", timeLimitMinutes: 30, instruction: "Only verify the available relay guidance; do not relay or create a plan." },
      };
    }
    return { tool: "finish", input: {} };
  });
  const bot = new WebChat(
    f.core,
    () => {},
    systemClock(),
    () => true,
  );
  f.accounts.push(bot);
  await bot.receive("alice", "PARENT_BODY_NOT_FOR_WORKER: verify the delegation guidance only", "relay-guidance", Date.now(), "", [], () => true);
  await vi.waitFor(async () => expect((await f.core.tasks.store.list())[0]?.status).toBe("succeeded"));

  const main = f.requests.filter((request) => !request.tools.includes("task_report"));
  const workers = f.requests.filter((request) => request.tools.includes("task_report"));
  expect(main.length).toBeGreaterThan(0);
  expect(workers.length).toBeGreaterThan(0);
  for (const request of [...main, ...workers]) {
    expect(request.prompt).toContain("后台任务仍绑定发起它的会话");
    expect(request.prompt).toContain("由目标会话自己执行");
    expect(request.prompt).toContain("事项、限制、执行时机和回复方式");
    expect(request.prompt).toContain("status=done 只表示目标本轮结束");
  }
  // Like Muse, the main agent relays directly and a background task inherits the conversation it came from.
  expect(main[0].tools).toContain("task_create");
  expect(main[0].tools).toContain("relay_to_conversation");
  expect(workers[0].tools).toContain("relay_to_conversation");
  expect(workers[0].prompt).toContain("以下是委派这项任务时主对话的上下文");
  expect(workers[0].prompt).toContain("PARENT_BODY_NOT_FOR_WORKER");
  expect(f.bot.sent).toEqual([]);
});

it("preserves a complete multi-paragraph private request and its constraints in the target conversation", async () => {
  const f = await fixture(undefined, undefined, true);
  const paragraphs = [
    "【临时心跳验收】待跟进：Python tarfile 的提取过滤默认值在不同版本间有什么变化？",
    "现在不要检索或回答；等待本会话心跳触发后再核实官方资料，有可用解法才通知。",
    "请在本 QQ 私聊委派本地 service 创建标题 RELAY-MULTIPART 的计划，purpose=heartbeat、delivery=channel、cron=37 * * * *；具体问题只留在会话，不复制进计划 prompt。",
    "不要修改已有计划或记忆，不查邮箱，不操作电脑，不发群消息。",
    "建好只用 reply_owner 私下返回真实计划 ID 和 nextRunAt，不要用 send_message 播报配置状态。",
  ];
  const text = paragraphs.join("\n\n");
  const privateReply = "本地 service 子任务 queued，尚未拿到计划创建回执。";
  f.script.push({ tool: "reply_owner", input: { text: privateReply } }, { tool: "finish", input: {} });
  const plugin = f.plugins.find((item) => (item as { id?: string }).id === "yesimbot-console")!;
  const brain = await plugin.setup({ type: "direct", platform: "web", channelId: "owner", selfId: "bot", userId: "owner" }, {} as never);
  const relay = (brain!.tools as AgentTool[]).find((tool) => tool.name === "relay_to_conversation")!;
  const whisper = vi.spyOn(f.core.messenger, "whisper");

  const result = await relay.execute({ conversation: f.key, text }, { abortSignal: new AbortController().signal } as never);

  expect(whisper).toHaveBeenCalledExactlyOnceWith(f.context, text);
  expect((await f.entries()).find((entry) => entry.kind === "user")).toMatchObject({ whisper: true, text });
  for (const paragraph of paragraphs) expect(f.requests[0].prompt).toContain(paragraph);
  expect(result).toEqual({ ok: true, status: "done", privateReplies: [privateReply], chatMessages: [] });
  expect(f.bot.sent).toEqual([]);
});

it("refuses malformed requests and unknown conversations, and maps stored conversations back to their own key only", async () => {
  const f = await fixture();
  expect((await f.post({ channel: f.key, text: "  ", clientId: randomUUID() })).status).toBe(410);
  expect((await f.post({ channel: f.key, text: "hi", clientId: "nope" })).status).toBe(410);
  expect((await f.post({ channel: f.key, text: "hi", clientId: randomUUID(), extra: 1 })).status).toBe(410);
  expect((await f.post({ channel: "direct-test-bot-1-ghost", text: "hi", clientId: randomUUID() })).status).toBe(410);

  const summary = (await buildConversationIndex(f.ctx, chatHistory, false)).channels.find((channel) => channel.key === f.key)!;
  expect(channelContext(summary)).toMatchObject(group);
  expect(channelContext({ ...summary, key: "something-else" })).toBeUndefined();
  expect(channelContext({ ...summary, selfId: undefined })).toBeUndefined();
});

it("shows the prompt a conversation's model receives, in order, each section with its source", async () => {
  const f = await fixture();
  f.core.agent.use({
    roleProfile: { resolve: () => ({ characterDefinition: "CARD_SENTINEL", postHistoryInstructions: "POST_SENTINEL" }) },
    setup: () => ({ name: "memory-x", appendSystemPrompt: () => "MEMORY_SENTINEL" }),
  });

  const response = await f.get(PROMPT_PATH);
  expect(response.status).toBe(200);
  const overview = response.body as PromptOverview;
  // No conversation asked for: the most recently active one, the only one here.
  expect(overview.conversation).toBe(f.key);
  expect(overview.segments.map((segment) => segment.key)).toEqual([
    "contract",
    "role",
    "role-boundaries",
    "interaction",
    "capability",
    "inner-thought",
    "runtime",
    "plugin:memory-x",
    "plugin:core.tasks",
    "history",
    "current",
    "post-history",
    "self-check",
  ]);
  const by = new Map(overview.segments.map((segment) => [segment.key, segment]));
  expect(by.get("role")).toMatchObject({ source: "card", enabled: true });
  expect(by.get("role")!.text).toContain("CARD_SENTINEL");
  expect(by.get("role")!.text).not.toContain("Athena");
  expect(by.get("plugin:memory-x")).toMatchObject({ source: "plugin", text: "MEMORY_SENTINEL", chars: 15 });
  expect(by.get("post-history")).toMatchObject({ source: "card", enabled: true, text: "POST_SENTINEL" });
  expect(by.get("history")!.text).toBeUndefined();
  expect(overview.tools.map((tool) => tool.name)).toContain("send_message");

  expect((await f.get(PROMPT_PATH, { channel: "nope" })).status).toBe(404);
});

it("delegates from a real channel runtime, executes once, and reports back through the original conversation", async () => {
  let created = false,
    executed = false,
    replied = false;
  const f = await fixture(
    (request) => {
      if (request.tools.includes("task_report")) {
        if (!executed) {
          executed = true;
          return { tool: "computer_exec", input: {} };
        }
        return { tool: "task_report", input: { status: "succeeded", result: "E2E_EXECUTED_SENTINEL" } };
      }
      if (request.prompt.includes("E2E_EXECUTED_SENTINEL") && !replied) {
        replied = true;
        return { tool: "send_message", input: { parts: [{ kind: "text", text: "后台操作已完成" }] } };
      }
      if (!created) {
        created = true;
        return { tool: "task_create", input: { kind: "computer", timeLimitMinutes: 30, instruction: "执行隔离测试操作" } };
      }
      return { tool: "finish", input: {} };
    },
    undefined,
    true,
  );
  const execute = vi.fn(async () => {
    await writeFile(join(f.root, "worker-result.txt"), "executed once");
    return { ok: true };
  });
  f.core.agent.use({
    setup: () => ({
      name: "test-computer",
      tools: [
        {
          name: "computer_exec",
          capability: { platforms: ["onebot"], sensitive: true, executionKind: "computer" },
          description: "Isolated acceptance operation",
          inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
          execute,
        },
      ],
    }),
  });
  await receive(f.core, { context: f.context, text: "bot-1 执行隔离测试操作", messageId: "e2e-task", userName: "测试用户", mention: true });
  await vi.waitFor(() => expect(f.bot.sent.join("")).toContain("后台操作已完成"), { timeout: 10000 });
  await vi.waitFor(async () => expect((await f.core.tasks.store.list(f.key))[0]?.notification).toBe("delivered"));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.root, "worker-result.txt"), "utf8")).toBe("executed once");
  const tasks = await f.core.tasks.store.list(f.key);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ status: "succeeded", notification: "delivered", channel: f.key });
  for (const request of f.requests) {
    if (request.tools.includes("task_report")) expect(request.tools).not.toContain("send_message");
    // Like Muse, the main agent may run a simple command itself; this test's model still chose to delegate.
    else expect(request.tools).toContain("computer_exec");
  }
});

it("does not claim result delivery when the main bot finishes without sending a reply", async () => {
  const f = await fixture((request) =>
    request.tools.includes("task_report")
      ? { tool: "task_report", input: { status: "succeeded", result: "completed in isolation" } }
      : { tool: "finish", input: {} },
  );
  const channel = (await buildConversationIndex(f.ctx, chatHistory, false)).channels.find((c) => c.key === f.key)!;
  const task = await f.core.tasks.create({ channel: f.key, session: channel.activeSession! }, "computer", "isolated check", "no-reply");
  await vi.waitFor(async () => expect((await f.core.tasks.store.get(task.id))?.notification).toBe("unknown"));
  expect((await f.core.tasks.store.get(task.id))?.status).toBe("succeeded");
  expect(f.bot.sent).toEqual([]);
});

// User, 2026-11-19: 「按任务类型给工具」: only the main conversation and a service task can relay.
it("gives the relay guidance only to the main conversation and service tasks", async () => {
  const f = await fixture();
  const plugin = f.plugins.find((plugin) => (plugin as { id?: string }).id === "yesimbot-console")!;
  const web = { type: "direct" as const, platform: "web", channelId: "owner", selfId: "bot", userId: "owner" };
  const guided: Record<string, boolean> = {};
  for (const role of [undefined, "main", "service", "content", "computer"] as const) {
    const brain = await plugin.setup(web, {} as never, role ? ({ executionRole: role } as never) : undefined);
    guided[String(role)] = !!(await brain!.appendSystemPrompt?.({} as never));
  }
  expect(guided).toEqual({ undefined: true, main: true, service: true, content: false, computer: false });
});

import { type AgentMessage, type AgentPlugin, type AgentTool } from "@yesimbot/agent-runtime";
import { channelStorageDirectory } from "@yesimbot/contracts";
import { directChannelId, isRetiredPlatform, WEB_CHAT } from "@yesimbot/contracts/platforms";
import type { ChannelContext, WhisperResult } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import type { AdminAuth } from "../admin-auth.js";
import { buildConversationIndex, readConversationDetail, type ConversationChannelSummary, type ConversationEntryView } from "../conversation-history.js";
import type { Host } from "../host.js";
import { listContacts } from "./contacts.js";
import { chatHistory } from "./history.js";
import { authorizeOwner } from "./plugins.js";

export const WHISPER_PATH = "/yesimbot/api/v1/conversations/whisper";

const MAX_TEXT = 4000;

/** How long the 全局大脑 waits for the other conversation's turn before reporting it as still running. */
const RELAY_WAIT_MS = 10 * 60_000;

const READ_DEFAULT = 30;

const READ_MAX = 100;

const REPLY_OWNER_SCHEMA = z.strictObject({ text: z.string().min(1).max(MAX_TEXT).describe("给主人的私下回复") });

const LIST_CONVERSATIONS_SCHEMA = z.strictObject({});

const READ_CONVERSATION_SCHEMA = z.strictObject({
  conversation: z.string().describe("list_conversations 返回的 conversation"),
  limit: z.int().min(1).max(READ_MAX).describe(`最多读多少条，默认 ${READ_DEFAULT}`).optional(),
});

const RELAY_SCHEMA = z.strictObject({
  conversation: z.string().describe("list_conversations 返回的 conversation"),
  text: z.string().min(1).max(MAX_TEXT).describe("以主人的口吻完整转达的正文，包含事项、限制、执行时机和回复方式；要求原样传递时保留原文"),
});

const NAMES_MS = 60_000;

const ONLINE = 1;

/** What the bot did in the turn a private word started: its private answers and what it said in the chat. */
export interface WhisperOutputs {
  readonly privateReplies: string[];
  readonly chatMessages: string[];
}

interface ReadableLine {
  readonly at: number;
  readonly who: string;
  readonly text: string;
}

/** The bot's conversations on chat platforms, as the 全局大脑 sees them. */
export class Conversations {
  private names?: { at: number; value: Promise<Map<string, string>> };

  public constructor(private readonly ctx: Host) {}

  public async list(): Promise<{ summary: ConversationChannelSummary; name: string }[]> {
    const index = await buildConversationIndex(this.ctx, (manifest) => chatHistory(manifest) && manifest.platform !== WEB_CHAT.platform, false);
    const names = await this.contactNames().catch(() => new Map<string, string>());
    return index.channels
      .filter((channel) => !isRetiredPlatform(channel.platform) && channel.platform !== WEB_CHAT.platform)
      .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
      .map((summary) => ({ summary, name: names.get(nameKey(summary)) ?? summary.channelId }));
  }

  public async find(key: string): Promise<ConversationChannelSummary | undefined> {
    return (await this.list()).find((item) => item.summary.key === key)?.summary;
  }

  /** Posts the private word and, once the turn has ended, reads what the bot did in it. */
  public async whisper(summary: ConversationChannelSummary, text: string): Promise<{ result: WhisperResult; outputs?: WhisperOutputs }> {
    const context = channelContext(summary);
    if (!context) throw new Error("conversation_not_addressable");
    const result = await this.ctx.yesimbot.messenger.whisper(context, text);
    if (result.kind !== "run") return { result };
    return { result, outputs: await this.outputs(summary.key, result.messageId) };
  }

  public async read(summary: ConversationChannelSummary, limit: number): Promise<ReadableLine[]> {
    const sessions = summary.sessions.map((session) => session.filename).sort();
    const entries: ConversationEntryView[] = [];
    // Newest file first, then older ones, until enough readable lines are found.
    for (const session of sessions.reverse()) {
      const detail = await readConversationDetail(this.ctx, { channel: summary.key, session, limit: Math.max(limit * 4, 40) }, chatHistory);
      entries.unshift(...detail.entries);
      if (readable(entries).length >= limit) break;
    }
    return readable(entries).slice(-limit);
  }

  private async outputs(key: string, messageId: string): Promise<WhisperOutputs> {
    const summary = await this.find(key);
    const session =
      summary?.activeSession ??
      summary?.sessions
        .map((item) => item.filename)
        .sort()
        .at(-1);
    if (!summary || !session) return { privateReplies: [], chatMessages: [] };
    const detail = await readConversationDetail(this.ctx, { channel: key, session, limit: 200 }, chatHistory);
    return whisperOutputs(detail.entries, messageId);
  }

  private contactNames(): Promise<Map<string, string>> {
    const now = this.ctx.clock.now();
    if (this.names && now - this.names.at < NAMES_MS) return this.names.value;
    const value = (async () => {
      const names = new Map<string, string>();
      const bots = (this.ctx.bots as unknown as Parameters<typeof listContacts>[0][]).filter(
        (bot) => bot.platform !== WEB_CHAT.platform && bot.status === ONLINE && typeof bot.getGuildList === "function",
      );
      for (const listing of await Promise.allSettled(bots.map((bot) => listContacts(bot, this.ctx.clock)))) {
        if (listing.status !== "fulfilled") continue;
        const { platform, selfId } = listing.value;
        for (const contact of listing.value.contacts)
          names.set(`${platform}:${selfId}:${contact.direct ? "direct" : "group"}:${contact.channelId}`, contact.name);
      }
      return names;
    })();
    this.names = { at: now, value };
    value.catch(() => (this.names = undefined));
    return value;
  }
}

/**
 * The account holder's two ways to reach the bot in another conversation, both on one primitive (a private
 * word that wakes that conversation's bot for a turn):
 * - the 对话 page posts one to the selected conversation (`POST /conversations/whisper`);
 * - every web conversation (the 全局大脑) gets tools to list and read the bot's conversations and to relay
 *   to one of them, waiting for that turn's private answer and chat messages.
 * Only private-word turns offer `reply_owner`, the bot's way to answer the account holder privately.
 */
export function installGlobalBrain(ctx: Host, auth: AdminAuth) {
  const conversations = new Conversations(ctx);

  ctx.server.post(WHISPER_PATH, async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    http.status = 410;
    http.body = { message: "direct_conversation_input_removed" };
  });

  const dispose = ctx.yesimbot.agent.use({
    id: "yesimbot-console",
    setup: (context: ChannelContext, _bot: unknown, runtime?: { readonly executionRole?: string }): AgentPlugin | null =>
      context.platform === WEB_CHAT.platform
        ? brainPlugin(conversations, !runtime?.executionRole || runtime.executionRole === "main" || runtime.executionRole === "service")
        : context.type === "direct" || context.type === "channel" || context.type === "guild"
          ? whisperPlugin()
          : null,
  });
  ctx.on("dispose", dispose);
}

/** The Core channel a stored conversation belongs to; refused when it does not map back to the same key. */
export function channelContext(summary: ConversationChannelSummary): ChannelContext | undefined {
  if (!summary.selfId) return undefined;
  const context: ChannelContext | undefined =
    summary.type === "direct"
      ? summary.userId
        ? { type: "direct", platform: summary.platform, channelId: summary.channelId, selfId: summary.selfId, userId: summary.userId }
        : undefined
      : summary.guildId
        ? { type: summary.type, platform: summary.platform, channelId: summary.channelId, guildId: summary.guildId, selfId: summary.selfId }
        : undefined;
  if (!context) return undefined;
  try {
    return channelStorageDirectory(context) === summary.key ? context : undefined;
  } catch {
    return undefined;
  }
}

/** What the bot did after one private word: everything it actually sent until the next private word. */
export function whisperOutputs(entries: readonly ConversationEntryView[], messageId: string): WhisperOutputs {
  const start = entries.findIndex((entry) => entry.kind === "user" && entry.messageId === messageId);
  const outputs: WhisperOutputs = { privateReplies: [], chatMessages: [] };
  if (start < 0) return outputs;
  const done = succeeded(entries);
  for (const entry of entries.slice(start + 1)) {
    if (entry.kind === "user" && entry.whisper) break;
    if (entry.kind !== "tool-call" || !entry.toolCallId || !done.has(entry.toolCallId)) continue;
    const text = toolText(entry);
    if (!text) continue;
    (entry.toolName === "reply_owner" ? outputs.privateReplies : outputs.chatMessages).push(text);
  }
  return outputs;
}

function nameKey(summary: ConversationChannelSummary): string {
  return summary.type === "direct"
    ? `${summary.platform}:${summary.selfId}:direct:${directChannelId(summary.platform, summary.userId ?? summary.channelId)}`
    : `${summary.platform}:${summary.selfId}:group:${summary.channelId}`;
}

/** The lines a person would read: chat messages, sends, private words and private answers. */
function readable(entries: readonly ConversationEntryView[]): ReadableLine[] {
  const lines: ReadableLine[] = [];
  const done = succeeded(entries);
  for (const entry of entries) {
    if (entry.kind === "user" && entry.text)
      lines.push({ at: entry.timestamp, who: entry.whisper ? "主人（私话）" : entry.sender || "对方", text: entry.text });
    const sent = entry.kind === "tool-call" && entry.toolCallId && done.has(entry.toolCallId) ? toolText(entry) : undefined;
    if (sent) lines.push({ at: entry.timestamp, who: entry.toolName === "reply_owner" ? "你（私下回主人）" : "你", text: sent });
  }
  return lines;
}

/**
 * Calls that actually went out. A send held for review, refused or failed answers without `ok: true`;
 * only its later accepted call counts.
 */
function succeeded(entries: readonly ConversationEntryView[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "tool-result" || entry.error || !entry.toolCallId) continue;
    let value = entry.result as { type?: unknown; value?: unknown; ok?: unknown } | undefined;
    if (value && value.type === "json") value = value.value as typeof value;
    if (value?.ok === true) ids.add(entry.toolCallId);
  }
  return ids;
}

function toolText(entry: ConversationEntryView): string | undefined {
  const args = entry.args as { text?: unknown; parts?: unknown } | undefined;
  if (entry.toolName === "reply_owner") return typeof args?.text === "string" ? args.text : undefined;
  if (entry.toolName !== "send_message" || !Array.isArray(args?.parts)) return undefined;
  const text = (args.parts as { kind?: unknown; text?: unknown }[])
    .filter((part) => part?.kind === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  return text || undefined;
}

const hasWhisper = (messages: readonly AgentMessage[]) =>
  messages.some((message) => message.role === "custom" && message.type === "yesimbot.message" && (message.data as { whisper?: unknown }).whisper === true);

/** In a chat conversation: `reply_owner`, offered only in a turn the account holder's private word started. */
function whisperPlugin(): AgentPlugin {
  const replyOwner: AgentTool<z.infer<typeof REPLY_OWNER_SCHEMA>> = {
    name: "reply_owner",
    description: "私下回复主人（账号持有人）。只在主人私下对你说话的这一轮可用；群里其他人看不到这条回复。要在群里说话仍然用 send_message。",
    inputSchema: REPLY_OWNER_SCHEMA,
    execute: async ({ text }) => ({ ok: true, delivered: "owner", length: [...text].length }),
  };
  return {
    name: "owner-whisper",
    tools: [replyOwner],
    filterTools: (tools, context) => (hasWhisper(context.messages) ? tools : tools.filter((tool) => tool.name !== "reply_owner")),
    beforeToolCall: (call, context) =>
      call.toolName === "reply_owner" && !hasWhisper(context.messages) ? { type: "block", reason: "这一轮没有主人的私话" } : { type: "allow" },
  };
}

/** In a web conversation: see every chat conversation of this bot and relay to its bot there. */
function brainPlugin(conversations: Conversations, relays: boolean): AgentPlugin {
  const list: AgentTool<z.infer<typeof LIST_CONVERSATIONS_SCHEMA>> = {
    name: "list_conversations",
    description: "列出你在各聊天平台上的会话（群聊和私聊），最近活跃的在前。conversation 字段用于 read_conversation 和 relay_to_conversation。",
    inputSchema: LIST_CONVERSATIONS_SCHEMA,
    execute: async () => ({
      conversations: (await conversations.list()).slice(0, 100).map(({ summary, name }) => ({
        conversation: summary.key,
        name,
        kind: summary.type === "direct" ? "私聊" : "群聊",
        platform: summary.platform,
        lastActivityAt: summary.lastActivityAt ? new Date(summary.lastActivityAt).toISOString() : null,
      })),
    }),
  };
  const read: AgentTool<z.infer<typeof READ_CONVERSATION_SCHEMA>> = {
    name: "read_conversation",
    description: "读某个会话最近的聊天记录（群成员的话、你在那里发的消息、主人的私话和你的私下回复）。",
    inputSchema: READ_CONVERSATION_SCHEMA,
    execute: async ({ conversation, limit }) => {
      const summary = await conversations.find(conversation);
      if (!summary) return { ok: false, error: "conversation_not_found" };
      const lines = await conversations.read(summary, Math.min(Math.max(limit ?? READ_DEFAULT, 1), READ_MAX));
      return { ok: true, messages: lines.map((line) => ({ at: new Date(line.at).toISOString(), from: line.who, text: line.text })) };
    },
  };
  const relay: AgentTool<z.infer<typeof RELAY_SCHEMA>> = {
    name: "relay_to_conversation",
    description:
      "替主人向指定会话里的你完整转达私话，会立即唤醒目标会话；私话留在目标上下文里，聊天成员看不到。正文须保留事项、限制、执行时机和回复方式，不能只摘出问题。在目标会话创建或管理计划时，转达完整执行要求，由目标会话自己执行；当前会话的 schedule_* 不能指定其他会话。等目标本轮结束后返回其私下回复和实际发出的聊天消息。status=done 只表示目标本轮结束；若目标只返回后台子任务 queued/accepted，操作尚未核实完成。",
    inputSchema: RELAY_SCHEMA,
    execute: async ({ conversation, text }, options) => {
      const summary = await conversations.find(conversation);
      if (!summary) return { ok: false, error: "conversation_not_found" };
      const run = conversations.whisper(summary, text);
      const waited = await Promise.race([
        run,
        new Promise<"running">((resolve) => {
          const timer = setTimeout(() => resolve("running"), RELAY_WAIT_MS);
          options.abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve("running");
          });
        }),
      ]);
      if (waited === "running") {
        run.catch(() => undefined);
        return { ok: true, status: "running", note: "那边还在处理，稍后可以用 read_conversation 查看结果" };
      }
      const { result, outputs } = waited;
      if (result.kind === "closed") return { ok: false, error: "runtime_stopping" };
      const status = result.kind !== "run" ? result.kind : (result.outcome?.status ?? "done");
      return { ok: status === "done", status, privateReplies: outputs?.privateReplies ?? [], chatMessages: outputs?.chatMessages ?? [] };
    },
  };
  return {
    name: "global-brain",
    tools: [list, read, relay],
    // The main agent and a service task can relay, so both need this guidance; other tasks only read conversations.
    appendSystemPrompt: () =>
      !relays
        ? undefined
        : "后台任务仍绑定发起它的会话；在 instruction 写入另一个会话的 ID 不会改变 schedule_* 等会话工具的归属。" +
          "用户要求另一会话里的你执行操作、例如在该会话创建或管理计划时，调用 relay_to_conversation 把完整请求转给指定会话，由目标会话自己执行。" +
          "转达须保留事项、限制、执行时机和回复方式；用户要求原样传递的正文要完整原样转达，不得自行追加改变执行时机或限制范围的文字，不把问题与目标会话应执行的步骤拆给网页任务。" +
          "relay 会立即唤醒目标，因此暂不查询、等待心跳后核实、只用 reply_owner 私下返回等约束必须随正文送达。仅转达已授权范围，不自行扩大目标、检查范围或创建额外计划。" +
          "status=done 只表示目标本轮结束，不代表目标后台操作完成；queued/accepted 也不是完成回执。创建计划须核对实际计划 ID、nextRunAt 和所属会话；创建心跳还须核对 purpose=heartbeat，不得为绕过会话限制省略 purpose 或降级为普通 task。未取得回执时如实说明。",
  };
}

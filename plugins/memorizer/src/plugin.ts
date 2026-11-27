import { type AgentMessage, type AgentTool, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import type { Clock, ToolFailure } from "@yesimbot/foundation";
import { isEvent, isMessage, type ChannelContext, type ConversationReadOptions, type EventBase, type MessageRecord } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { attachmentUri } from "./attachment-uri.js";
import { guarded } from "./errors.js";
import { MAX_ATTACHMENTS, type EvidenceStore } from "./store/evidence.js";
import type { MemoryStore } from "./store/memory.js";
import { type MemoryAttachment, type MemoryRecall, type MemoryScope, type MemorySearchReport, type MemoryType } from "./types.js";
import {
  MAX_WRITE_SOURCES,
  rememberMemory,
  SHORT_ID_LENGTH,
  updateMemory,
  type MemoryWriter,
  type OpenedResource,
  type RememberInput,
  type UpdateMemoryInput,
} from "./writer.js";

const MEMORY_TYPES = ["fact", "preference", "event", "relationship", "knowledge", "experience"] as const;

const MEMORY_SCOPES = ["channel", "user", "shared"] as const;

const RECALL_SCHEMA = z.strictObject({
  query: z.string().describe("关键词搜索，匹配记忆内容和标签").optional(),
  tags: z.array(z.string()).describe("按标签过滤（交集匹配）").optional(),
  types: z.array(z.enum(MEMORY_TYPES)).describe("按记忆类型过滤").optional(),
  scope: z.enum(MEMORY_SCOPES).describe("限定记忆主体；实例归属与私人可见性由系统授权").optional(),
  semantic: z.boolean().describe("启用语义召回：关键词命中之外，还会召回向量相似度足够高的记忆，并把相似度并入排序").optional(),
  limit: z.int().min(1).max(50).describe("最大返回条数").optional(),
  report: z
    .boolean()
    .describe("true=让记忆代理基于已授权的记忆和证据生成结构化报告，用于交叉验证多条记忆或回答复杂关系问题；此时 query 必填，只有 query、scope、limit 生效")
    .optional(),
});

const CREATE_SCHEMA = z.strictObject({
  action: z.literal("create"),
  content: z.string().min(1).describe("以后单独看也能懂的一句话：写明是谁、什么事、具体日期"),
  sources: z.array(z.string()).min(1).max(MAX_WRITE_SOURCES).describe("支持这条记忆的消息 messageId，逐字复制"),
  type: z
    .enum(MEMORY_TYPES)
    .describe(
      "fact=固定属性，preference=喜好习惯，event=改变处境的事件或决定，relationship=人际关系，knowledge=群规或共识，experience=承诺、被教的做法、踩过的坑",
    ),
  scope: z.enum(MEMORY_SCOPES).describe("channel=本会话（默认），user=某个人的事，shared=可公开的通用知识（私聊里只有主人明确要公开时可用）").optional(),
  userId: z.string().describe("scope=user 时是哪个人；证据里只有一个人说话时可省略").optional(),
  importance: z.number().min(0.6).max(1).describe("默认 0.7；核心身份、关键关系 0.85 以上").optional(),
  confidence: z.number().min(0.7).max(1).describe("默认 0.85；本人明确说的 0.9 以上，别人转述的低一些").optional(),
  tags: z.array(z.string()).max(5).describe("2-5 个检索标签").optional(),
  attachments: z
    .array(z.string())
    .max(MAX_ATTACHMENTS)
    .describe("要一起记住的图片或文件：证据消息里的 asset:// 地址（如 [图片：asset://…]），sources 要包含那条消息")
    .optional(),
});

const UPDATE_SCHEMA = z.strictObject({
  action: z.literal("update"),
  id: z.string().min(SHORT_ID_LENGTH).describe("记忆 ID，可只写前 8 位"),
  content: z.string().min(1).describe("新的完整内容（替换原内容）").optional(),
  sources: z.array(z.string()).min(1).max(MAX_WRITE_SOURCES).describe("改内容时必填：支持新内容的消息 messageId").optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  importance: z.number().min(0.6).max(1).optional(),
  confidence: z.number().min(0.7).max(1).optional(),
  tags: z.array(z.string()).max(5).optional(),
  attachments: z
    .array(z.string())
    .max(MAX_ATTACHMENTS)
    .describe("换成这些图片或文件（证据消息里的 asset:// 地址，要同时给 sources）；[] 去掉全部附件")
    .optional(),
  forget: z.boolean().describe("true=这条已经不成立（取消、过时、记错），忘掉它").optional(),
});

const REMEMBER_SCHEMA = z.discriminatedUnion("action", [CREATE_SCHEMA, UPDATE_SCHEMA]);

type RecallInput = z.infer<typeof RECALL_SCHEMA>;

type RememberToolInput = z.infer<typeof REMEMBER_SCHEMA>;

type RecallRejected = { status: "rejected"; code: "invalid_recall_input"; message: string };

type SearchInput = { query: string; scope?: MemoryScope; limit?: number };

export interface ChannelToolOptions {
  readonly clock: Clock;
  readonly evidenceCount: (memoryId: string) => Promise<number>;
  readonly readConversation: (context: ChannelContext, options: ConversationReadOptions) => Promise<MessageRecord[]>;
  readonly search: (input: SearchInput, execution: AgentToolExecuteContext) => Promise<MemorySearchReport>;
  /** Fixed participants (the pre-summary review); otherwise taken from the current turn's messages. */
  readonly participants?: () => readonly string[];
  /** This conversation's resources, for attachments. */
  readonly openResource?: (uri: string) => Promise<OpenedResource>;
  /** Whether this direct chat is the owner's (may publish shared memories). */
  readonly mayPublish?: () => Promise<boolean>;
}

export function createChannelTools(context: ChannelContext, store: MemoryStore, evidence: EvidenceStore, options: ChannelToolOptions): AgentTool[] {
  const writer: MemoryWriter = {
    clock: options.clock,
    context,
    store,
    evidence,
    readConversation: options.readConversation,
    ...(options.openResource ? { openResource: options.openResource } : {}),
    ...(options.mayPublish ? { mayPublish: options.mayPublish } : {}),
  };
  const userIds = (execution: unknown) => options.participants?.() ?? participants((execution as AgentToolExecuteContext).messages, context);
  const recall: AgentTool<RecallInput, { memories: MemoryRecall[]; semanticUsed: boolean } | MemorySearchReport | ToolFailure | RecallRejected> = {
    name: "recall",
    description:
      "检索当前会话获授权的长期记忆。主人的已认证私人入口可共享主人记忆；群聊不读取私人记忆。默认直接查：query、tags、types、scope、limit 可过滤，semantic 可按含义检索，返回记忆列表。report=true 时改为让记忆代理基于记忆和证据生成结构化报告，需要 query，只在要交叉验证多条记忆或回答复杂关系问题时使用。",

    inputSchema: RECALL_SCHEMA,
    execute: guarded(async (input, execution) => {
      const current = execution as unknown as AgentToolExecuteContext;
      if (input.report) {
        if (!input.query?.trim()) return { status: "rejected", code: "invalid_recall_input", message: "report=true 需要 query；不需要报告时去掉 report。" };
        return options.search({ query: input.query, scope: input.scope, limit: input.limit }, current);
      }
      const userIds = options.participants?.() ?? participants(current.messages, context);
      const result = await store.searchVisible(context, userIds, {
        query: input.query,
        tags: input.tags,
        types: input.types,
        scopes: input.scope ? [input.scope] : undefined,
        limit: input.limit,
        semantic: input.semantic,
      });
      await store.touch(result.memories.map((memory) => memory.id));
      return {
        memories: await Promise.all(
          result.memories.map(async (memory) => toRecall(memory, options.clock.now(), options.evidenceCount, (id) => evidence.attachments(id))),
        ),
        semanticUsed: result.semanticUsed,
      };
    }),
  };
  const remember: AgentTool<RememberToolInput, Awaited<ReturnType<typeof rememberMemory>> | Awaited<ReturnType<typeof updateMemory>> | ToolFailure> = {
    name: "remember",
    description:
      "写入或修改长期记忆，返回成功才算记住。action=create 把一条新记忆直接写进记忆库：一次只记一件事，必填 content、sources（支持它的消息 messageId）、type；图片或文件要一起记住时（比如某人的照片、立绘、要留着的文档）放进 attachments，以后在能看到这条记忆的地方用返回的 memory:// 地址读、当参考图或发出去。action=update 修改或忘掉一条已有记忆（情况变了、记错了、已取消）：必填 id；改内容时要给出新的 content 和支持它的 sources；forget=true 表示这条已不成立，忘掉它。",
    inputSchema: REMEMBER_SCHEMA,
    execute: guarded(async (input: RememberToolInput, execution: unknown) => {
      const { action, ...rest } = input;
      return action === "create" ? rememberMemory(writer, rest as RememberInput) : updateMemory(writer, userIds(execution), rest as UpdateMemoryInput);
    }),
  };
  return [remember, recall];
}

export function participants(messages: readonly AgentMessage[], context?: ChannelContext): string[] {
  const users = [...new Set(messages.filter(isMessage).map((message) => message.data.user.id))];
  if (users.length || context?.type !== "direct") return users;

  // Tool execution contains this turn's inputs/outputs, never its projected chat history. Only
  // a native schedule trigger bound to this exact private conversation can supply its absent user.
  const trigger = messages[0];
  if (!trigger || !isEvent(trigger)) return users;
  const event = trigger.data as Pick<EventBase, "eventType" | "platform" | "selfId" | "channel"> & { user?: { id?: string } };
  if (
    event?.eventType !== "schedule.due" ||
    event.platform !== context.platform ||
    event.selfId !== context.selfId ||
    event.channel?.type !== 1 ||
    event.channel.id !== context.channelId ||
    event.user?.id !== context.userId
  )
    return users;
  return [context.userId];
}

export async function toRecall(
  memory: { id: string; type: MemoryType; content: string; scope: MemoryScope; importance: number; confidence: number; updatedAt: number },
  now: number,
  evidenceCount: (memoryId: string) => Promise<number>,
  attachments?: (memoryId: string) => Promise<MemoryAttachment[]>,
): Promise<MemoryRecall> {
  const kept = (await attachments?.(memory.id)) ?? [];
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content,
    scope: memory.scope,
    importance: memory.importance,
    confidence: memory.confidence,
    updatedAt: memory.updatedAt,
    relativeTime: relativeTime(now - memory.updatedAt),
    evidenceCount: await evidenceCount(memory.id),
    ...(kept.length
      ? { attachments: kept.map((item) => ({ uri: attachmentUri(memory.id, item), ...(item.name ? { name: item.name } : {}), mediaType: item.mediaType })) }
      : {}),
  };
}

function relativeTime(age: number): string {
  const minutes = Math.max(0, Math.floor(age / 60_000));
  return minutes < 1 ? "just now" : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

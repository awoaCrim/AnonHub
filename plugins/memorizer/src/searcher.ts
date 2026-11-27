import { createAgent, createUserMessage, type AgentTool, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import type { Clock } from "@yesimbot/foundation";
import type { LanguageModel } from "ai";
import type { ChannelContext } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { guarded, refuse } from "./errors.js";
import { participants, toRecall } from "./plugin.js";
import { EvidenceStore } from "./store/evidence.js";
import { MemoryStore } from "./store/memory.js";
import type { Memory, MemoryQuery, MemorySearchReport } from "./types.js";

/** Upper bound for one memory search agent run. */
const SEARCH_TIMEOUT_MS = 60 * 1_000;

const REPORT_SCHEMA = z.strictObject({
  answer: z.string().describe("对查询的完整回答，引用相关记忆 ID"),
  memoryIds: z.array(z.string()).describe("支撑回答的记忆 ID 列表"),
  unresolved: z.array(z.string()).describe("无法确定的子问题列表（找不到相关记忆或证据矛盾）"),
});

const QUERY_SCHEMA = z.strictObject({
  query: z.string().describe("关键词搜索，匹配记忆内容和标签").optional(),
  tags: z.array(z.string()).describe("按标签交集过滤").optional(),
  scopes: z
    .array(z.enum(["channel", "user", "shared"]))
    .describe("限定记忆主体；跨平台共享仍受实例与私人权限约束")
    .optional(),
  types: z
    .array(z.enum(["fact", "preference", "event", "relationship", "knowledge", "experience"]))
    .describe("按类型过滤")
    .optional(),
  semantic: z.boolean().describe("启用语义召回：关键词未命中但向量相似度足够高的记忆也会被纳入，并按相似度加权重排").optional(),
  limit: z.int().min(1).max(50).describe("最大返回条数").optional(),
});

const READ_EVIDENCE_SCHEMA = z.strictObject({ id: z.string().describe("记忆 ID（必须先通过 query_memories 授权）") });

type SearchReport = z.infer<typeof REPORT_SCHEMA>;

export interface SearchInput {
  readonly clock: Clock;
  readonly model: LanguageModel;
  readonly context: ChannelContext;
  readonly execution: AgentToolExecuteContext;
  readonly store: MemoryStore;
  readonly evidence: EvidenceStore;
  readonly query: string;
  readonly scope?: "channel" | "user" | "shared";
  readonly limit?: number;
}

export async function runSearch(input: SearchInput): Promise<MemorySearchReport> {
  const authorized = new Map<string, Memory>();
  let report: SearchReport | undefined;

  const query = async (value: unknown) => {
    const requested = value as MemoryQuery;
    const allowedScopes: MemoryQuery["scopes"] = input.scope ? [input.scope] : ["channel", "user", "shared"];
    const resolved = {
      ...requested,
      scopes: requested.scopes ? requested.scopes.filter((scope) => allowedScopes.includes(scope)) : allowedScopes,
      limit: requested.limit ?? input.limit,
    };
    const memories = await input.store.queryVisible(input.context, participants(input.execution.messages, input.context), resolved);
    for (const memory of memories) authorized.set(memory.id, memory);
    return Promise.all(
      memories.map((memory) =>
        toRecall(
          memory,
          input.clock.now(),
          (id) => input.evidence.count(id),
          (id) => input.evidence.attachments(id),
        ),
      ),
    );
  };
  const evidence = async (value: unknown) => {
    const id = readId(value);
    if (!authorized.has(id)) throw refuse("memory_not_authorized");
    return input.store.visibleEvidence(
      authorized.get(id)!,
      input.context,
      participants(input.execution.messages, input.context),
      await input.evidence.read(id),
    );
  };
  const submit = async (value: SearchReport) => {
    if (!value.memoryIds.every((id) => authorized.has(id))) throw refuse("memory_report_unauthorized");
    report = value;
  };

  const tools: AgentTool[] = [
    {
      name: "query_memories",
      description: "查询当前可见的记忆。可多次调用，用不同关键词、语义召回和过滤条件扩展搜索范围。",
      inputSchema: QUERY_SCHEMA,
      execute: guarded(query),
    },
    {
      name: "read_evidence",
      description: "读取某条已授权记忆的原始证据消息。用于验证记忆准确性或获取更多细节。",
      inputSchema: READ_EVIDENCE_SCHEMA,
      execute: guarded(evidence),
    },
    {
      name: "submit_report",
      description: "提交最终的结构化搜索报告。必须在搜索完成后调用一次。",
      inputSchema: REPORT_SCHEMA,
      execute: guarded(async (reportInput: SearchReport) => {
        await submit(reportInput);
        return { submitted: true };
      }),
    },
  ];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(refuse("memory_search_timeout", undefined, "unknown")), SEARCH_TIMEOUT_MS);
  const systemPrompt = `你是一个记忆搜索助手。你的任务是基于已授权的记忆和证据，回答用户的查询。

## 搜索策略

1. 先用关键词 query_memories 进行初步搜索
2. 如果结果不足，尝试不同关键词、开启 semantic 语义召回、或调整 scope / type 组合扩展搜索
3. 对关键记忆使用 read_evidence 验证原始证据
4. 综合所有发现，用 submit_report 提交结构化报告

## 报告要求

- answer：直接回答查询，简洁明确。如有多条相关记忆，综合整理后给出结论
- memoryIds：列出所有支撑回答的记忆 ID
- unresolved：如果查询的某些方面找不到记忆或证据相互矛盾，列出这些无法解决的子问题

## 规则

- 只使用提供的工具，不输出对话性回复
- read_evidence 只能读取已通过 query_memories 返回的记忆
- 必须调用且只调用一次 submit_report 提交报告
- 如果完全找不到相关记忆，在 answer 中说明，unresolved 中列出原始查询`;
  const agent = createAgent({
    model: input.model,
    tools,
    systemPrompt,
  });
  try {
    await agent.init();
    for await (const _event of agent.run(createUserMessage(input.query))) {
      if (controller.signal.aborted) throw controller.signal.reason;
    }
    if (!report) throw refuse("memory_search_no_report", undefined, "unknown");
    const stillVisible = new Map(
      (await input.store.queryVisible(input.context, participants(input.execution.messages, input.context))).map((memory) => [memory.id, memory]),
    );
    if ([...authorized].some(([id, memory]) => !stillVisible.has(id) || (stillVisible.get(id)!.revision ?? 0) !== (memory.revision ?? 0)))
      throw refuse("memory_search_changed", undefined, "unknown");
    const memories = await Promise.all(
      report.memoryIds.map((id) =>
        toRecall(
          authorized.get(id)!,
          input.clock.now(),
          (memoryId) => input.evidence.count(memoryId),
          (memoryId) => input.evidence.attachments(memoryId),
        ),
      ),
    );
    await input.store.touch(report.memoryIds);
    return { answer: report.answer, memories, unresolved: report.unresolved };
  } finally {
    clearTimeout(timeout);
    await agent.stop();
  }
}

function readId(value: unknown): string {
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") throw refuse("memory_id_required");
  return (value as { id: string }).id;
}

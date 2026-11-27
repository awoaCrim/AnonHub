import type { AgentTool } from "@yesimbot/agent-runtime";
import { formatForModel } from "@yesimbot/foundation";
import type { ChannelContext, ContextRegionReview, ContextRegionReviewInput, ConversationReadOptions, MessageRecord } from "koishi-plugin-yesimbot/kernel";

import { createChannelTools, type ChannelToolOptions } from "./plugin.js";
import type { EvidenceStore } from "./store/evidence.js";
import type { MemoryStore } from "./store/memory.js";
import { messageInConversation } from "./visibility.js";
import { SHORT_ID_LENGTH } from "./writer.js";

/** Existing memories listed in the review: it is appended to an already full context. */
export const REVIEW_MEMORY_LIMIT = 30;

export const REVIEW_MEMORY_CHARS = 3000;
/** The review may only write, change or look up memories. */
const REVIEW_TOOLS = ["remember", "recall"] as const;

export interface RegionReviewDeps extends Omit<ChannelToolOptions, "participants"> {
  readonly context: ChannelContext;
  readonly store: MemoryStore;
  readonly evidence: EvidenceStore;
  readonly readConversation: (context: ChannelContext, options: ConversationReadOptions) => Promise<MessageRecord[]>;
}

/**
 * The main model's last look at a range before Magic Context summarizes it. Participants and evidence come from the
 * persisted originals of that range; the listed memories are the ones it may update without a recall first.
 */
export async function prepareRegionReview(deps: RegionReviewDeps, range: ContextRegionReviewInput): Promise<ContextRegionReview | undefined> {
  const ids = new Set(range.messageIds);
  const messages = (await deps.readConversation(deps.context, { from: range.sourceStartAt, to: range.sourceEndAt })).filter(
    (message) => ids.has(message.messageId) && messageInConversation(message, deps.context),
  );
  if (!messages.length) return undefined;
  const speakers = [...new Set(messages.map((message) => message.user.id))].filter((id) => id !== deps.context.selfId);
  const people = speakers.length || deps.context.type !== "direct" ? speakers : [deps.context.userId];
  range.signal.throwIfAborted();
  const existing = await deps.store.queryVisible(deps.context, people);
  const lines: string[] = [];
  let chars = 0;
  for (const memory of existing.slice(0, REVIEW_MEMORY_LIMIT)) {
    const kept = (await deps.evidence.attachments(memory.id)).length;
    const line = `- [${memory.id.slice(0, SHORT_ID_LENGTH)}] (${memory.type}) ${memory.content}${kept ? `（带 ${kept} 个附件）` : ""}`;
    if (chars + line.length > REVIEW_MEMORY_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  const omitted = existing.length - lines.length;
  const tools = createChannelTools(deps.context, deps.store, deps.evidence, { ...deps, participants: () => people }).filter((tool) =>
    (REVIEW_TOOLS as readonly string[]).includes(tool.name),
  );
  const first = messages[0]!;
  const last = messages.at(-1)!;
  const instructions = [
    "【长期记忆补记：这是系统指令，不是谁发来的消息】",
    `上面对话里 ${formatForModel(range.sourceStartAt, deps.clock)} 到 ${formatForModel(range.sourceEndAt, deps.clock)} 的 ${messages.length} 条消息（第一条 messageId ${first.messageId}，最后一条 ${last.messageId}）马上要被整理成摘要，以后你只能看到摘要。`,
    "现在只做一件事：按「长期记忆」一节的标准，看看这段对话里有没有还没记住、值得长期保留的内容，有就补记。",
    `- 只能调用 ${REVIEW_TOOLS.join("、")}；结束时调用 finish 或不调用工具。不要调用其他工具，不要回复任何人：这一步说的话不会发出去。`,
    "- 已经记住的不重复记；下面的已有记忆变了，就用 remember 的 action=update 改那一条（id 写方括号里的前 8 位），不成立了设 forget=true。",
    "- 消息里值得留着的图片或文件（某人的照片、你的立绘、要你留着的文档），记的时候把它的 asset:// 地址放进 attachments，摘要以后就只剩这份。",
    "- 要记的几条在同一步里一起调用；多数对话没有要补的，那就直接结束。",
    lines.length
      ? `这段对话里的人已有的记忆（${lines.length} 条${omitted > 0 ? `，另有 ${omitted} 条没列出，需要时用 recall 查` : ""}）：\n${lines.join("\n")}`
      : "这段对话里的人还没有已记住的内容。",
  ].join("\n");
  return { instructions, tools: tools.map((tool) => reviewTool(tool)) };
}

function reviewTool(tool: AgentTool) {
  return {
    name: tool.name,
    // Review executors ignore the Agent execution context: participants are fixed to the summarized range.
    execute: (input: unknown, signal: AbortSignal) => Promise.resolve(tool.execute(input as never, { abortSignal: signal } as never)),
  };
}

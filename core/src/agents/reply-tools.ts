import type { AgentTool, AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import type { Clock } from "@yesimbot/foundation";
import { z } from "zod/v4";

import type { ChatAccount } from "../accounts.js";
import type { PacingConfig } from "../config.js";
import type { ReplyJournalWriter } from "../conversations/reply-journal.js";
import type { ChannelResources } from "../resources/index.js";
import {
  ReplyCoordinator,
  replyPreflightFailure,
  type ReplyDeliveryNotice,
  type ReplyPart,
  type ReplySendFailureNotice,
  type ReplyStickerProvider,
} from "./reply.js";

export interface ReplyToolsOptions {
  /** Pacing and receipt times; the system clock when absent. */
  readonly clock?: Clock;
  readonly bot: ChatAccount;
  readonly channelId: string;
  readonly resources: ChannelResources;
  readonly pacing: PacingConfig;
  readonly journal: ReplyJournalWriter;
  readonly innerThought: boolean;
  readonly sticker?: ReplyStickerProvider;
  readonly onDelivered?: (notice: ReplyDeliveryNotice) => void;
  readonly onFailed?: (notice: ReplySendFailureNotice) => void;
  readonly onWarn?: (reason: string, detail: Record<string, unknown>) => void;
  readonly stillAllowed?: () => boolean;
}

export interface ReplyToolSet {
  readonly tools: AgentTool[];
  readonly coordinator: ReplyCoordinator;
  readonly invalidate: () => void;
  readonly finishTurn: (turnId: string) => Promise<void>;
  setTurnAllowed: (check: (turnId: string) => boolean) => void;
}

/**
 * One authored sender per runtime. The main model decides the complete ordered reply and submits it
 * as `parts`; Core owns preflight, delivery proof, FIFO and platform transport.
 */
export function createReplyTools(options: ReplyToolsOptions): ReplyToolSet {
  const coordinator = new ReplyCoordinator(options);
  let turnAllowed: (turnId: string) => boolean = () => true;
  let retired = false;
  const finishedTurns = new Set<string>();
  const allowed = (turnId: string): boolean => {
    try {
      return !retired && !finishedTurns.has(turnId) && turnAllowed(turnId) && (options.stillAllowed?.() ?? true);
    } catch {
      return false;
    }
  };
  const tools = [authoredSendTool(options, coordinator, allowed)];
  return {
    tools,
    coordinator,
    invalidate: () => {
      retired = true;
      coordinator.close();
    },
    finishTurn: async (turnId) => {
      finishedTurns.add(turnId);
      if (finishedTurns.size > 64) finishedTurns.delete(finishedTurns.values().next().value!);
      coordinator.abortTurn(turnId);
      await coordinator.settle();
    },
    setTurnAllowed: (check) => {
      turnAllowed = check;
    },
  };
}

export function authoredDescription(innerThought: boolean, stickerAvailable: boolean): string {
  return `用 parts 提交本次完整的有序回复；普通文本输出不会发送。每个 {kind:"text",text:"..."} 是一个有意义的交流单元。短而完整的回应用一个 part；包含独立回答和必要补充时，按交流意图分成不同 parts，不要把多层信息全塞进一个 part，也不要靠一个 part 内换行代替分条。通常两三条足以承载一次有层次的回复，无须凑条数。不按字数、句号或空行机械拆分；完整代码、命令与精确引用不拆散。
消息正文使用普通文本，不使用 Markdown 格式。
${stickerAvailable ? '表情单元使用 {kind:"sticker",sticker_id:"..."}，填写当前可见库的精确 ID；每轮最多一张，sticker_preview 可选。不要用 <sticker/> 或 artifact://sticker/ 链接替代。' : "当前没有表情发送能力，只提交文字。"}
parts 顺序就是发送顺序；同次调用会发完全部单元。channel 留空发当前频道；混排表情不支持跨频道。mode=element（默认）解析 <at>/<quote>/<img>/<file>，资源用真实 URI，<text>...</text> 是逐字块；普通尖括号需转义。mode=raw 原样发送纯文本。本工具只发送消息，不结束本轮：需要先简短确认再工作时，可以先发确认，再继续调用工具；确认任务完成且消息发送结果符合预期后，单独调用 finish 结束本轮。不要在同一步并行调用 send_message 和 finish。
${innerThought ? "inner_thought 是私有行为判断，不是角色台词，不会发送。" : ""}
返回 replyReceipt 和真实平台 ID。发送遇错立即停止，已发送前缀不会重发；不要通过另一个工具或后续调用重发同一份回复。`;
}

function authoredSendTool(options: ReplyToolsOptions, coordinator: ReplyCoordinator, allowed: (turnId: string) => boolean): AgentTool {
  return {
    name: "send_message",
    terminal: false,
    description: authoredDescription(options.innerThought, options.sticker !== undefined),
    inputSchema: sendSchema(options.innerThought),
    execute: async (input, execution) => {
      const value = record(input);
      if (!value || !keysOnly(value, ["parts", "channel", "mode", ...(options.innerThought ? ["inner_thought"] : [])]) || !validControls(value))
        return replyPreflightFailure("InvalidInput", "只能提交完整 parts 和有效的发送控制").output;
      return (
        await coordinator.deliver({
          parts: value.parts,
          ...executionInput(execution, allowed),
          channel: value.channel as string | undefined,
          mode: value.mode,
          // New sends allow subsequent phases; historical ledger flags remain authoritative.
          keepGoing: true,
        })
      ).output;
    },
  };
}

function executionInput(execution: AgentToolExecuteContext, allowed: (turnId: string) => boolean) {
  return {
    turnId: execution.turnId,
    toolCallId: execution.toolCallId,
    messages: execution.messages,
    signal: execution.abortSignal,
    allowed: allowed(execution.turnId),
    stillAllowed: () => allowed(execution.turnId),
  };
}

function validControls(value: Record<string, unknown>): boolean {
  return (
    (value.channel === undefined || (typeof value.channel === "string" && !!value.channel.trim())) &&
    (value.mode === undefined || value.mode === "raw" || value.mode === "element") &&
    (value.inner_thought === undefined || typeof value.inner_thought === "string")
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function keysOnly(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function sendSchema(innerThought: boolean) {
  const send = z.strictObject({
    parts: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("text"), text: z.string().min(1) }),
          z.strictObject({ kind: z.literal("sticker"), sticker_id: z.string().min(1) }),
        ]),
      )
      .min(1)
      .max(13),
    channel: z.string().min(1).optional(),
    mode: z.enum(["element", "raw"]).optional(),
  });
  return innerThought ? send.extend({ inner_thought: z.string().describe("私有行为判断，不会发送").optional() }) : send;
}

export type { ReplyPart };

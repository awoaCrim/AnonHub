import type { AgentModelRequestGuard } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";

import { estimateContextBase, estimateContextMessage } from "../runtimes/context-budget.js";
import { contextCostTokens, measureContextMessages } from "../runtimes/context-estimator.js";
import { TASK_ERRORS, taskError } from "./errors.js";

/** Fallback model window, in tokens. It is not a serialized request byte limit. */
export const DEFAULT_WORKER_CONTEXT_TOKENS = 128 * 1024;

/** Independent resource guard for accumulated text; native image bytes are excluded. */
export const WORKER_REQUEST_TEXT_BYTES = 1024 * 1024;
/**
 * Share of the budget from which older tool results are shortened in requests, so a task carries on instead of stopping
 * to report: steps no longer end a task (user, 2026-11-20: 「超时/步数超了仅提醒主bot…不强制结束」), the context does.
 */
const COMPACT_FROM = 0.5;
/** The latest tool results, which the next steps build on, are never shortened. */
const KEPT_TOOL_RESULTS = 10;
/** A tool result this small stays whole. */
const SMALL_TOOL_RESULT_BYTES = 2 * 1024;

type ToolResultPart = Extract<Extract<ModelMessage, { role: "tool" }>["content"][number], { type: "tool-result" }>;

export interface ShortenToolResultsOptions {
  /** Which tool results count and may be shortened; all by default. */
  readonly include?: (part: ToolResultPart) => boolean;
  /** The note that replaces a shortened result. */
  readonly note?: (part: ToolResultPart, bytes: number) => string;
}

export interface WorkerModelLimit {
  readonly context: number;
  readonly output: number;
}

export interface WorkerBudgetPressure {
  readonly reason: "context_tokens" | "serialized_text";
  readonly textBytes: number;
  readonly estimatedTokens: number;
  readonly inputTokenLimit: number;
}

/** Reserve room for the final report and provider framing within the selected model's window. */
export function workerInputTokenLimit(limit?: WorkerModelLimit): number {
  const context = positiveInteger(limit?.context) ? limit.context : DEFAULT_WORKER_CONTEXT_TOKENS;
  const output = Math.min(positiveInteger(limit?.output) ? limit.output : 8192, 8192, Math.floor(context / 4));
  return Math.max(1, context - output - Math.ceil(context * 0.1));
}

export function workerRequestBudget(limit?: WorkerModelLimit): {
  guard: AgentModelRequestGuard;
  observe: (inputTokens: number | undefined) => void;
  readonly finalizing: WorkerBudgetPressure | undefined;
} {
  const inputTokenLimit = workerInputTokenLimit(limit);
  let density = 0.25;
  let observedTokens = 0;
  let measuredBytes = 0;
  let measuredTools: ReadonlyMap<string, number> = new Map();
  let pending: { bytes: number; tools: ReadonlyMap<string, number>; signal: AbortSignal } | undefined;
  let finalizing: WorkerBudgetPressure | undefined;
  // How many of the oldest tool results requests show shortened. It only grows, so the start of each request stays the
  // same from one step to the next and the provider's prompt cache keeps working.
  let shortened = 0;
  return {
    get finalizing() {
      return finalizing;
    },
    observe(inputTokens) {
      const sample = pending;
      pending = undefined;
      // Missing/invalid usage must not make a large new result appear measured and cheap.
      if (!sample || sample.signal.aborted || !positiveInteger(inputTokens)) return;
      observedTokens = inputTokens;
      measuredBytes = sample.bytes;
      measuredTools = sample.tools;
      // Calibrate text estimates from the actual admitted request. Keep a floor for
      // gateways which rewrite input; the separate byte cap still bounds that traffic.
      density = Math.min(1, Math.max(0.125, inputTokens / Math.max(1, sample.bytes)));
    },
    async guard(context) {
      const base = await estimateContextBase(context);
      const size = (messages: readonly ModelMessage[]) => {
        const measured = measureContextMessages(workerTextMessages(messages), measuredTools);
        const textBytes = base + messages.reduce((sum, message) => sum + estimateContextMessage(message), 0);
        // New, unmeasured tool text keeps the same conservative floor as chat context.
        // Native media is not tokenized as base64; actual usage remains authoritative.
        return { measured, textBytes, textTokens: contextCostTokens({ bytes: textBytes, unmeasuredToolBytes: measured.unmeasuredToolBytes }, density) };
      };
      let messages = shortenToolResults(context.messages, shortened);
      let current = size(messages);
      // Carry the last actual usage (including native media) and estimate only
      // additional text. Image costs must not inflate all subsequent text density.
      let estimatedTokens = Math.ceil(observedTokens > 0 ? observedTokens + Math.max(0, current.textTokens - measuredBytes * density) : current.textTokens);
      if (estimatedTokens >= inputTokenLimit * COMPACT_FROM || current.textBytes >= WORKER_REQUEST_TEXT_BYTES * COMPACT_FROM) {
        const next = Math.max(shortened, toolResultCount(context.messages) - KEPT_TOOL_RESULTS);
        const compacted = next > shortened ? shortenToolResults(context.messages, next) : messages;
        if (compacted !== messages) {
          const smaller = size(compacted);
          // What was shortened leaves the request; the rest of the last measured usage stays.
          estimatedTokens = Math.ceil(Math.max(smaller.textTokens, estimatedTokens - Math.max(0, current.textTokens - smaller.textTokens)));
          shortened = next;
          messages = compacted;
          current = smaller;
        }
      }
      const { measured, textBytes } = current;
      const pressure: WorkerBudgetPressure = {
        reason: textBytes > WORKER_REQUEST_TEXT_BYTES * 0.85 ? "serialized_text" : "context_tokens",
        textBytes,
        estimatedTokens,
        inputTokenLimit,
      };
      if (textBytes > WORKER_REQUEST_TEXT_BYTES || estimatedTokens > inputTokenLimit) {
        finalizing = pressure;
        throw taskError(TASK_ERRORS.task_worker_budget_exceeded, {
          detail: `${pressure.reason} ${pressure.textBytes} bytes ~${pressure.estimatedTokens}/${pressure.inputTokenLimit} tokens`,
        });
      }
      pending = { bytes: textBytes, tools: measured.toolResults, signal: context.signal };
      if (finalizing || textBytes >= WORKER_REQUEST_TEXT_BYTES * 0.85 || estimatedTokens >= inputTokenLimit * 0.9) {
        finalizing ??= pressure;
        return {
          messages: [
            ...messages,
            {
              role: "user",
              content:
                "本次执行已接近内部上下文预算，只能调用 task_report 保存已完成工作、证据、资源和具体剩余步骤。已经完成可报告 succeeded；未完成报告 waiting，并明确原因是内部上下文预算。预算暂停不需要用户补充信息或接管电脑，不要填写 handoff，也不要声称执行工具原本不存在；不要重复已执行的操作。",
            },
          ],
          activeTools: ["task_report"],
        };
      }
      return messages;
    },
  };
}

/**
 * The messages with the first `count` tool results shortened to a note, when they are larger than a few KB; the same
 * array, or the same message objects, when nothing changes. Request only: the task's own history keeps every result.
 */
export function shortenToolResults(messages: readonly ModelMessage[], count: number, options: ShortenToolResultsOptions = {}): readonly ModelMessage[] {
  if (count <= 0) return messages;
  const note =
    options.note ??
    ((part: ToolResultPart, bytes: number) =>
      `[较早的 ${part.toolName} 结果（约 ${Math.ceil(bytes / 1024)} KB）已从这次请求中省略，任务的记录里还在；需要其中的信息就重新查看]`);
  let seen = 0;
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "tool" || seen >= count) return message;
    let partChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || (options.include && !options.include(part)) || seen++ >= count) return part;
      const bytes = Buffer.byteLength(JSON.stringify(part.output) ?? "");
      if (bytes <= SMALL_TOOL_RESULT_BYTES) return part;
      partChanged = true;
      return { ...part, output: { type: "text" as const, value: note(part, bytes) } };
    });
    if (!partChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? result : messages;
}

function toolResultCount(messages: readonly ModelMessage[]): number {
  return messages.reduce((count, message) => count + (message.role === "tool" ? message.content.filter((part) => part.type === "tool-result").length : 0), 0);
}

function positiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

/** Meter reusable text separately from native media; never alter the actual request. */
function workerTextMessages(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  return messages.map((message) =>
    message.role !== "tool"
      ? message
      : {
          ...message,
          content: message.content.map((part) =>
            part.type !== "tool-result" || part.output.type !== "content"
              ? part
              : {
                  ...part,
                  output: { ...part.output, value: part.output.value.filter((item) => item.type === "text") },
                },
          ),
        },
  );
}

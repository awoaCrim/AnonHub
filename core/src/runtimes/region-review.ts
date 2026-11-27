import type { AgentPlugin } from "@yesimbot/agent-runtime";
import { AppError, systemClock, type Clock, type Logger } from "@yesimbot/foundation";
import { generateText, type JSONValue, type LanguageModel, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";

import { withAbortSignal } from "../abort.js";
import type { Conversation } from "../conversations/index.js";
import { isMessage } from "../messages/index.js";
import { RUNTIME_ERRORS } from "./errors.js";

/**
 * A request already sent is left to finish: cutting it wastes the whole (paid) request and shows up as an upstream 500
 * at the gateway (newapi, 2026-11-22: reviews of ~150k-token prefixes on a thinking model were cut at 20 s). Only a
 * hung request is cut, this long after the first send.
 */
export const REGION_REVIEW_TIMEOUT_MS = 180_000;

/** A further step starts only within this long after the first send. */
export const REGION_REVIEW_STEP_WINDOW_MS = 60_000;

export const REGION_REVIEW_MAX_STEPS = 3;

const REGION_REVIEW_OUTPUT_TOKENS = 4096;

/** How long a plugin may take to prepare its pre-summary review (reading its own store), before the side request. */
const REGION_REVIEW_PREPARE_MS = 5_000;

/** Original chat messages of a Magic Context range that is about to be summarized. */
export interface ContextRegionReviewInput {
  readonly messageIds: readonly string[];
  readonly sourceStartAt: number;
  readonly sourceEndAt: number;
  readonly signal: AbortSignal;
}

/** Executes one tool the main model was already offered; the call never passes through the Agent loop. */
export interface ContextRegionReviewTool {
  readonly name: string;
  execute(input: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface ContextRegionReview {
  /** Appended after the main model's last request as its final user text. */
  readonly instructions: string;
  /** Only these names run, and only if the request offered them; any other call is refused. */
  readonly tools: readonly ContextRegionReviewTool[];
}

/**
 * Optional extension of a channel AgentPlugin: before Magic Context summarizes a range, the main model may look at
 * it once more (user decision 2026-11-20: the main model decides what to remember, right before the region is summarized).
 */
export interface ContextRegionReviewer {
  beforeContextRegion?(input: ContextRegionReviewInput): Promise<ContextRegionReview | void> | ContextRegionReview | void;
}

/** The main request exactly as the provider last received it, so the review reuses its cached prefix. */
export interface RegionReviewRequest {
  readonly model: LanguageModel;
  readonly system: string | SystemModelMessage | readonly SystemModelMessage[] | undefined;
  readonly messages: readonly ModelMessage[];
  readonly tools: ToolSet;
  readonly toolChoice?: "required";
}

export interface RegionReviewOutcome {
  readonly status: "done" | "skipped" | "timeout" | "failed";
  readonly steps: number;
  readonly executed: number;
  readonly refused: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
}

/**
 * Side request outside the Agent loop and the runtime FIFO: same system, tools and messages as the last returned main
 * request, plus one final instruction. Nothing is persisted or delivered; model text is discarded and only the
 * review's own executors run. The timeout starts when the first request is sent.
 */
export async function runRegionReview(input: {
  readonly request: RegionReviewRequest;
  readonly review: ContextRegionReview;
  /** Names that end the review when called (the main `finish`); never executed. */
  readonly terminalTools: readonly string[];
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly stepWindowMs?: number;
  readonly maxSteps?: number;
  readonly clock?: Clock;
}): Promise<RegionReviewOutcome> {
  const { request, review } = input;
  const clock = input.clock ?? systemClock();
  const executors = new Map(review.tools.filter((tool) => Object.hasOwn(request.tools, tool.name)).map((tool) => [tool.name, tool]));
  if (!executors.size || !review.instructions.trim()) return { status: "skipped", steps: 0, executed: 0, refused: 0 };
  // Same definitions keep the cached prefix; without `execute` the SDK returns calls instead of running them.
  const tools = Object.fromEntries(
    Object.entries(request.tools).map(([name, tool]) => [name, tool.type === "provider" ? tool : { ...tool, execute: undefined }]),
  ) as ToolSet;
  const allowed = [...executors.keys(), ...input.terminalTools.filter((name) => Object.hasOwn(request.tools, name))];
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  if (input.signal.aborted) abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  const startedAt = clock.now();
  const timer = setTimeout(
    () => controller.abort(new AppError(RUNTIME_ERRORS.region_review_timeout, { effect: "unknown" })),
    input.timeoutMs ?? REGION_REVIEW_TIMEOUT_MS,
  );
  let messages = appendUserText(request.messages, review.instructions);
  let steps = 0;
  let executed = 0;
  let refused = 0;
  let inputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  const add = (left: number | undefined, right: number | undefined) => (right === undefined ? left : (left ?? 0) + right);
  try {
    while (steps < (input.maxSteps ?? REGION_REVIEW_MAX_STEPS)) {
      controller.signal.throwIfAborted();
      if (steps && clock.now() - startedAt >= (input.stepWindowMs ?? REGION_REVIEW_STEP_WINDOW_MS))
        return { status: "timeout", steps, executed, refused, ...usage(inputTokens, cachedInputTokens) };
      const result = await generateText({
        model: request.model,
        ...(request.system === undefined ? {} : { system: request.system as string | SystemModelMessage | SystemModelMessage[] }),
        messages,
        tools,
        ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
        maxOutputTokens: REGION_REVIEW_OUTPUT_TOKENS,
        maxRetries: 0,
        abortSignal: controller.signal,
      });
      steps += 1;
      inputTokens = add(inputTokens, result.usage.inputTokens);
      cachedInputTokens = add(cachedInputTokens, result.usage.inputTokenDetails?.cacheReadTokens);
      messages = [...messages, ...result.response.messages];
      const calls = result.toolCalls.filter((call) => !call.providerExecuted);
      if (!calls.length) break;
      const results: Extract<ModelMessage, { role: "tool" }>["content"] = [];
      let ended = false;
      for (const call of calls) {
        let output: { type: "json"; value: JSONValue } | { type: "error-text"; value: string };
        const executor = executors.get(call.toolName);
        if (input.terminalTools.includes(call.toolName)) {
          ended = true;
          output = { type: "json", value: { ok: true } };
        } else if (!executor) {
          refused += 1;
          output = { type: "error-text", value: `这一步只能调用 ${allowed.join("、")}；${call.toolName} 没有执行，也不会有消息发出。` };
        } else if (call.invalid) {
          refused += 1;
          output = { type: "error-text", value: "参数不符合工具定义，没有执行。" };
        } else {
          try {
            output = { type: "json", value: toJson(await executor.execute(call.input, controller.signal)) };
            executed += 1;
          } catch (cause) {
            controller.signal.throwIfAborted();
            output = { type: "error-text", value: cause instanceof Error ? cause.message : String(cause) };
          }
        }
        results.push({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output });
      }
      messages = [...messages, { role: "tool", content: results }];
      if (ended) break;
    }
    return { status: "done", steps, executed, refused, ...usage(inputTokens, cachedInputTokens) };
  } catch {
    const reason = controller.signal.reason;
    const status = reason instanceof AppError && reason.code === RUNTIME_ERRORS.region_review_timeout ? "timeout" : "failed";
    return { status, steps, executed, refused, ...usage(inputTokens, cachedInputTokens) };
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
  }
}

/**
 * Adds the instruction without two adjacent user messages (Gemini rejects them, DeepSeek reasoners too): it joins a
 * trailing user message as one more text part, or follows a tool/assistant message as a new user message.
 */
export function appendUserText(messages: readonly ModelMessage[], text: string): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "user") return [...messages, { role: "user", content: text }];
  const parts = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : [...last.content];
  return [...messages.slice(0, -1), { ...last, content: [...parts, { type: "text", text }] }];
}

/**
 * Before Magic Context summarizes a range, plugins (long-term memory) may have the main model look at its original
 * messages once more. Only message IDs and the time span leave Core; the review is bounded and never rejects.
 */
export async function reviewBeforeRegion(deps: {
  readonly plugins: readonly AgentPlugin[];
  readonly conversation: Conversation;
  readonly logger: Logger;
  readonly stopped: () => boolean;
  readonly request: RegionReviewRequest;
  readonly sourceEntryIds: readonly string[];
  readonly signal: AbortSignal;
}): Promise<void> {
  const reviewers = deps.plugins.filter((plugin): plugin is AgentPlugin & Required<ContextRegionReviewer> => {
    return typeof (plugin as ContextRegionReviewer).beforeContextRegion === "function";
  });
  if (!reviewers.length || deps.stopped()) return;
  try {
    const covered = new Set(deps.sourceEntryIds);
    const records = (await deps.conversation.storage.read()).flatMap((entry) =>
      entry.type === "message" && covered.has(entry.id) && isMessage(entry.data)
        ? [{ messageId: entry.data.data.messageId, timestamp: entry.data.timestamp }]
        : [],
    );
    const messageIds = [...new Set(records.map((record) => record.messageId))];
    if (!messageIds.length) return;
    const timestamps = records.map((record) => record.timestamp);
    const range = { messageIds, sourceStartAt: Math.min(...timestamps), sourceEndAt: Math.max(...timestamps), signal: deps.signal };
    const reviews: ContextRegionReview[] = [];
    for (const plugin of reviewers) {
      try {
        const review = await withAbortSignal(plugin.beforeContextRegion(range), AbortSignal.any([deps.signal, AbortSignal.timeout(REGION_REVIEW_PREPARE_MS)]));
        if (review) reviews.push(review);
      } catch (cause) {
        deps.logger.warn("runtime.region_review_prepare_failed", { plugin: plugin.name, cause });
      }
    }
    if (!reviews.length) return;
    const outcome = await runRegionReview({
      request: deps.request,
      review: { instructions: reviews.map((review) => review.instructions).join("\n\n"), tools: reviews.flatMap((review) => review.tools) },
      terminalTools: ["finish"],
      signal: deps.signal,
    });
    deps.logger.info("runtime.region_review", { messages: messageIds.length, ...outcome });
  } catch (cause) {
    deps.logger.warn("runtime.region_review_failed", { cause });
  }
}

function toJson(value: unknown): JSONValue {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as JSONValue);
}

function usage(inputTokens: number | undefined, cachedInputTokens: number | undefined) {
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }) };
}

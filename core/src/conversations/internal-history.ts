import { createHash } from "node:crypto";

import { type AgentAssistantMessage, type AgentEntry, type AgentPlugin, type AgentToolMessage, type AgentRequestProjection } from "@yesimbot/agent-runtime";
import { isRecord } from "@yesimbot/foundation";

import type { HistoryProjectionMode } from "../models/index.js";
import { compactSourceTimestamp, type CompressionRecord } from "./compact.js";
import { excludeCurrentReplyJournal, isReplyDeliveryProof, resolveReplyHistory } from "./reply-receipt.js";

/** Keep native send calls/results; delivery journals remain durable recovery data only. */
export const INTERNAL_HISTORY_PROJECTION_PLUGIN: AgentPlugin = createInternalHistoryProjectionPlugin("default");
const HISTORICAL_OUTPUT_TOOL_NAME = "send_message";
const HISTORICAL_EPHEMERAL_TOOL_NAMES = new Set(["edit_image", "generate_image"]);
/** Upper bound for an event's history note; it labels past activity, it does not carry content. */
const HISTORY_NOTE_MAX = 200;
interface HistoricalSendResult {
  readonly ok: boolean;
  readonly sentCount: number;
  readonly failedAt?: number;
}

export function createInternalHistoryProjectionPlugin(mode: HistoryProjectionMode = "default", projection?: AgentRequestProjection): AgentPlugin {
  return {
    name: "core.internal-history-projection",
    enforce: "pre",
    transformEntries: (entries, context) => stripInternalAssistantInputs(entries, mode, projection, context?.turnId),
  };
}

export function stripInternalAssistantInputs(
  entries: readonly AgentEntry[],
  _mode: HistoryProjectionMode = "default",
  projection?: AgentRequestProjection,
  turnId?: string,
): AgentEntry[] {
  entries = excludeCurrentReplyJournal(entries, turnId);
  // Keep only uniquely paired, ordered sends. Never synthesize a missing call/result from a journal.
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    if (entry.type !== "message" || (entry.data.role !== "assistant" && entry.data.role !== "tool") || !Array.isArray(entry.data.content)) return;
    for (const part of entry.data.content) {
      if (part.type === "tool-call" && entry.data.role === "assistant" && part.toolName === HISTORICAL_OUTPUT_TOOL_NAME)
        calls.set(part.toolCallId, [...(calls.get(part.toolCallId) ?? []), index]);
      if (part.type === "tool-result" && entry.data.role === "tool" && part.toolName === HISTORICAL_OUTPUT_TOOL_NAME)
        results.set(part.toolCallId, [...(results.get(part.toolCallId) ?? []), index]);
    }
  });
  const paired = new Set([...calls].filter(([id, at]) => at.length === 1 && results.get(id)?.length === 1 && at[0]! < results.get(id)![0]!).map(([id]) => id));
  const removed = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.data.role !== "assistant" || !Array.isArray(entry.data.content)) continue;
    for (const part of entry.data.content)
      if (part.type === "tool-call" && (isHistoricalToolCall({ ...part }) || (part.toolName === HISTORICAL_OUTPUT_TOOL_NAME && !paired.has(part.toolCallId))))
        removed.add(part.toolCallId);
  }
  const projected: AgentEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      projected.push(entry);
      continue;
    }
    const message = entry.data;
    if (message.role === "custom" && message.type === "yesimbot.event") {
      // An event's text is a one-time instruction. Only its declared history note (e.g. "an earlier
      // heartbeat at 16:00") stays, so later turns can tell what that past activity was.
      const note = (message.data as { historyNote?: unknown } | undefined)?.historyNote;
      if (typeof note === "string" && note.trim()) {
        const data = { ...message, data: { ...message.data, text: note.trim().slice(0, HISTORY_NOTE_MAX) } } as typeof message;
        projection?.inherit(data, [message]);
        projected.push({ ...entry, data });
      }
      continue;
    }
    if (isReplyDeliveryProof(message)) continue;
    if (message.role !== "assistant" && message.role !== "tool") {
      projected.push(entry);
      continue;
    }
    if (typeof message.content === "string") {
      projected.push(entry);
      continue;
    }
    const content = message.content
      .filter((part) => {
        if (part.type === "tool-call" || part.type === "tool-result")
          return (
            !removed.has(part.toolCallId) &&
            !HISTORICAL_EPHEMERAL_TOOL_NAMES.has(part.toolName) &&
            (part.toolName !== HISTORICAL_OUTPUT_TOOL_NAME || paired.has(part.toolCallId))
          );
        return true;
      })
      .map((part) => {
        // Keep provider metadata/signatures and public arguments; remove private reasoning.
        if (part.type !== "tool-call" || !isRecord(part.input)) return part;
        const input = { ...part.input };
        return removePrivateToolFields(input) ? { ...part, input } : part;
      });
    if (!content.length) continue;
    const data = { ...message, content } as AgentAssistantMessage | AgentToolMessage;
    projection?.inherit(data, [message]);
    projected.push({ ...entry, data });
  }
  return [
    ...projected.filter((e) => e.type === "message" && e.data.role === "system"),
    ...projected.filter((e) => e.type !== "message" || e.data.role !== "system"),
  ];
}

/** Public-output evidence used by block loading. No internal assistant text or failed send is exposed. */
export function collectDeliveredSourceRecords(entries: readonly AgentEntry[]): ReadonlyMap<string, readonly CompressionRecord[]> {
  const results = collectHistoricalSendResults(entries);
  const records = new Map<string, readonly CompressionRecord[]>(resolveReplyHistory(entries).records);
  for (const entry of entries) {
    if (entry.type !== "message" || entry.data.role !== "assistant" || !Array.isArray(entry.data.content)) continue;
    const output: CompressionRecord[] = [];
    for (const part of entry.data.content) {
      if (part.type !== "tool-call" || part.toolName !== HISTORICAL_OUTPUT_TOOL_NAME) continue;
      const result = results.get(part.toolCallId);
      if (!result || result.sentCount <= 0 || (!result.ok && (result.failedAt ?? 0) <= 0)) continue;
      const messages = readHistoricalSendMessages(part.input);
      if (!messages) continue;
      // sent IDs count platform segments, not input messages. A partial receipt proves
      // only inputs strictly before failedAt; even partially sent failed input is excluded.
      const count = result.ok ? result.sentCount : result.failedAt!;
      if ((result.ok && count !== messages.length) || (!result.ok && count >= messages.length)) continue;
      for (const message of messages.slice(0, count)) {
        // Unbalanced control markup cannot prove where private text ends. The old
        // history projection stays unchanged; block loading fails closed for this row.
        if (/<\/?inner_thought\b/i.test(message.replace(/<inner_thought\b[^>]*>[\s\S]*?<\/inner_thought\s*>/gi, ""))) continue;
        const text = sanitizeDeliveredMessage(message);
        if (text)
          output.push({ entryId: entry.id, timestamp: compactSourceTimestamp(entry), role: "assistant", speaker: "assistant (already delivered)", text });
      }
    }
    if (output.length) records.set(entry.id, output);
  }
  return records;
}

/** Source/body/proof identity without exposing original private fields to derived prompts. */
export function collectAssistantSourceProofs(entries: readonly AgentEntry[]): ReadonlyMap<string, string> {
  const modern = resolveReplyHistory(entries);
  const receipts = new Map<string, object[]>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.data.role !== "tool" || !Array.isArray(entry.data.content)) continue;
    for (const part of entry.data.content)
      if (part.type === "tool-result" && part.toolName === HISTORICAL_OUTPUT_TOOL_NAME) {
        const list = receipts.get(part.toolCallId) ?? [];
        list.push(entry.data);
        receipts.set(part.toolCallId, list);
      }
  }
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const origins: object[] = [entry.data];
    if (entry.data.role === "assistant" && Array.isArray(entry.data.content)) {
      for (const part of entry.data.content)
        if (part.type === "tool-call" && part.toolName === HISTORICAL_OUTPUT_TOOL_NAME) origins.push(...(receipts.get(part.toolCallId) ?? []));
    }
    const group = modern.groups.get(entry.id);
    const proof = group ? entries.filter((source) => group.includes(source.id)) : origins;
    result.set(entry.id, createHash("sha256").update(JSON.stringify(proof)).digest("hex"));
  }
  return result;
}

export function sanitizeDeliveredMessage(value: string): string {
  return value
    .replace(/<inner_thought\b[^>]*\/?>[\s\S]*?<\/inner_thought\s*>/gi, "")
    .replace(/<inner_thought\b[^>]*\/?\s*>/gi, "")
    .replace(/<\/?img\b[^>]*>/gi, "[图片]")
    .replace(/<\/?image\b[^>]*>/gi, "[图片]")
    .replace(/<\/?file\b[^>]*>/gi, "[文件]")
    .replace(/<message\s*\/>/gi, "\n")
    .replace(/<\/?text\b[^>]*>/gi, "")
    .replace(/\b(?:artifact|asset|workspace):\/\/[^\s"'<>]+/gi, "[资源]")
    .trim();
}

function collectHistoricalSendResults(entries: readonly AgentEntry[]): ReadonlyMap<string, HistoricalSendResult> {
  const { maskedCalls } = resolveReplyHistory(entries);
  const calls = new Map<string, { index: number; count: number }>();
  const receiptCounts = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message" || (entry.data.role !== "assistant" && entry.data.role !== "tool") || !Array.isArray(entry.data.content)) continue;
    for (const part of entry.data.content as readonly unknown[]) {
      if (!isRecord(part) || typeof part.toolCallId !== "string") continue;
      if (entry.data.role === "assistant" && part.type === "tool-call")
        calls.set(part.toolCallId, { index, count: (calls.get(part.toolCallId)?.count ?? 0) + 1 });
      if (entry.data.role === "tool" && part.type === "tool-result") receiptCounts.set(part.toolCallId, (receiptCounts.get(part.toolCallId) ?? 0) + 1);
    }
  }
  const results = new Map<string, HistoricalSendResult>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message" || entry.data.role !== "tool" || !Array.isArray(entry.data.content)) continue;
    for (const sourcePart of entry.data.content as readonly unknown[]) {
      if (!isRecord(sourcePart) || sourcePart.type !== "tool-result" || sourcePart.toolName !== HISTORICAL_OUTPUT_TOOL_NAME) continue;
      if (typeof sourcePart.toolCallId !== "string" || maskedCalls.has(sourcePart.toolCallId)) continue;
      const result = decodeHistoricalSendResult(sourcePart);
      const call = calls.get(sourcePart.toolCallId);
      // A receipt needs unambiguous ordered proof: exactly one call before exactly one result.
      const ambiguousProof = call?.count !== 1 || call.index >= index || receiptCounts.get(sourcePart.toolCallId) !== 1;
      results.set(sourcePart.toolCallId, ambiguousProof ? { ok: false, sentCount: 0 } : result);
    }
  }
  return results;
}

function decodeHistoricalSendResult(part: Record<string, unknown>): HistoricalSendResult {
  const rawOutput = part.output;
  const rawValue = isRecord(rawOutput) && "value" in rawOutput ? rawOutput.value : rawOutput;
  const value = parseJsonValue(rawValue);
  if (!isRecord(value)) return { ok: false, sentCount: 0 };
  const ids = value.ok === true ? value.messageIds : value.sent;
  const invalidIds = ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0));
  const invalidCount = value.count !== undefined && (typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 0);
  const explicitNoDelivery = Array.isArray(ids) && ids.length === 0;
  const completeCount = value.ok === true ? value.count : value.failedAt;
  const insufficientIds = !Array.isArray(ids) || (typeof completeCount === "number" && ids.length < completeCount);
  if (invalidIds || invalidCount || explicitNoDelivery || insufficientIds || (value.ok !== true && value.ok !== false)) return { ok: false, sentCount: 0 };
  if (value.ok === true) {
    const count = typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0 ? value.count : undefined;
    const messageIds = Array.isArray(value.messageIds) ? value.messageIds.length : undefined;
    return { ok: true, sentCount: count ?? messageIds ?? 0 };
  }
  const sentCount = Array.isArray(value.sent) ? value.sent.length : 0;
  const failedAt = typeof value.failedAt === "number" && Number.isInteger(value.failedAt) && value.failedAt >= 0 ? value.failedAt : undefined;
  return { ok: false, sentCount, ...(failedAt === undefined ? {} : { failedAt }) };
}

function readHistoricalSendMessages(input: unknown): readonly string[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.messages)) return undefined;
  if (!input.messages.every((message): message is string => typeof message === "string" && message.length > 0)) return undefined;
  return input.messages;
}

function removePrivateToolFields(input: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of ["inner_thought", "reason"] as const) {
    if (!(key in input)) continue;
    delete input[key];
    changed = true;
  }
  return changed;
}

function isHistoricalToolCall(part: Record<string, unknown>): boolean {
  if (typeof part.toolName === "string" && HISTORICAL_EPHEMERAL_TOOL_NAMES.has(part.toolName)) return true;
  if (part.toolName !== "read" || !isRecord(part.input)) return false;
  return typeof part.input.uri === "string" && part.input.uri.startsWith("artifact://");
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

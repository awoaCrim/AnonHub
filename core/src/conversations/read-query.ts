import { canonicalMessageKey, type MessageRecord } from "../messages/index.js";
import { CONVERSATION_ERRORS, conversationError } from "./errors.js";

export interface ConversationReadOptions {
  messageIds?: string[];
  before?: number;
  after?: number;
  from?: number;
  to?: number;
  userIds?: string[];
  limit?: number;
}

export interface ReadMessage {
  readonly record: MessageRecord;
  readonly session: string;
  readonly index: number;
}

export interface ReadSession {
  readonly filename: string;
  readonly messages: ReadMessage[];
}

export function validateReadOptions(options: ConversationReadOptions): void {
  for (const name of ["before", "after"] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isInteger(value) || value < 0))
      throw conversationError(CONVERSATION_ERRORS.conversation_read_range_invalid, { detail: name });
  }
  if (options.from !== undefined && !Number.isFinite(options.from))
    throw conversationError(CONVERSATION_ERRORS.conversation_read_range_invalid, { detail: "from" });
  if (options.to !== undefined && !Number.isFinite(options.to)) throw conversationError(CONVERSATION_ERRORS.conversation_read_range_invalid, { detail: "to" });
  if (options.from !== undefined && options.to !== undefined && options.from > options.to)
    throw conversationError(CONVERSATION_ERRORS.conversation_read_range_invalid, { detail: "from after to" });
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0))
    throw conversationError(CONVERSATION_ERRORS.conversation_read_range_invalid, { detail: "limit" });
}

export function selectSourceWindows(
  sessions: readonly ReadSession[],
  matches: ReadonlyMap<string, readonly ReadMessage[]>,
  options: ConversationReadOptions,
): ReadMessage[] {
  const selected = new Map<string, ReadMessage>();
  const before = options.before ?? 0;
  const after = options.after ?? 0;
  for (const source of matches.values()) {
    const message = source[0]!;
    const session = sessions.find(({ filename }) => filename === message.session)!;
    const start = Math.max(0, message.index - before);
    const end = Math.min(session.messages.length, message.index + after + 1);
    for (const nearby of session.messages.slice(start, end)) selected.set(readMessageKey(nearby), nearby);
  }
  return [...selected.values()];
}

export function matchesReadFilter(record: MessageRecord, options: ConversationReadOptions): boolean {
  return (
    (options.from === undefined || record.timestamp >= options.from) &&
    (options.to === undefined || record.timestamp <= options.to) &&
    (options.userIds === undefined || options.userIds.includes(record.user.id))
  );
}

export function limitSourceMessages(
  messages: readonly ReadMessage[],
  matches: ReadonlyMap<string, readonly ReadMessage[]>,
  limit: number | undefined,
): ReadMessage[] {
  if (limit === undefined) return [...messages];
  const sourceKeys = new Set([...matches.values()].map(([message]) => readMessageKey(message!)));
  const sources = messages.filter((message) => sourceKeys.has(readMessageKey(message)));
  if (sources.length >= limit) return sources;
  const distance = (message: ReadMessage) =>
    Math.min(...sources.filter((source) => source.session === message.session).map((source) => Math.abs(source.index - message.index)));
  return [
    ...sources,
    ...messages
      .filter((message) => !sourceKeys.has(readMessageKey(message)))
      .sort((left, right) => distance(left) - distance(right) || left.record.timestamp - right.record.timestamp)
      .slice(0, limit - sources.length),
  ];
}

export function limitNewestMessages(messages: readonly ReadMessage[], limit: number | undefined): ReadMessage[] {
  if (limit === undefined) return [...messages];
  return [...messages].sort((left, right) => right.record.timestamp - left.record.timestamp).slice(0, limit);
}

export function readMessageKey(message: ReadMessage): string {
  return canonicalMessageKey(message.record) ?? JSON.stringify([message.session, message.index]);
}

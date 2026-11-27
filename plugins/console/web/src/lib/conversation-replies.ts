import type { ConversationEntryView } from "../state/history-types";

export type Delivery = "已发送" | "发送失败" | "等待发送结果" | "发送结果未知";

export interface ReadableReply extends ConversationEntryView {
  delivery?: Delivery;
  unsupportedParts?: boolean;
}

/** Only stored text parts are projected; unknown parts and original payloads remain in runtime details. */
export function readableReplies(entries: ConversationEntryView[]): ReadableReply[] {
  const results = new Map(entries.filter((e) => e.kind === "tool-result" && e.toolCallId).map((e) => [e.toolCallId, e]));
  let turn = 0;
  const turns = entries.map((entry) => {
    if (entry.kind === "event" || entry.kind === "user") turn++;
    return turn;
  });
  const sends = entries.flatMap((entry, index) => {
    if (entry.kind !== "tool-call" || entry.toolName !== "send_message") return [];
    // The web chat sends `messages`, one Markdown bubble each; QQ and WeChat send `parts`.
    if (object(entry.args) && Array.isArray(entry.args.messages)) {
      const messages = entry.args.messages;
      const text = messages.filter((message): message is string => typeof message === "string").join("\n\n");
      return [{ entry, index, text, unsupported: !messages.length || messages.some((message) => typeof message !== "string") }];
    }
    const parts = object(entry.args) && Array.isArray(entry.args.parts) ? entry.args.parts : [];
    const text = parts
      .filter((part) => object(part) && part.kind === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    return [{ entry, index, text, unsupported: !parts.length || parts.some((part) => !object(part) || part.kind !== "text" || typeof part.text !== "string") }];
  });
  // Platform copies of a send (e.g. the web chat's recorded messages, one per part or attachment) are
  // matched exactly by the message IDs in the send's result; text matching covers older records.
  const delivered = new Set(sends.flatMap(({ entry }) => (entry.toolCallId ? sentMessageIds(results.get(entry.toolCallId)) : [])));
  const matchedSends = new Set<number>();
  const replies: ReadableReply[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === "user" || entry.kind === "thought") replies.push(entry);
    if (entry.kind === "assistant" && !(entry.messageId && delivered.has(entry.messageId))) {
      const matching =
        !entry.assets?.length &&
        sends.find(
          (send) =>
            !matchedSends.has(send.index) &&
            turns[send.index] === turns[index] &&
            !(entry.turnId && send.entry.turnId && entry.turnId !== send.entry.turnId) &&
            !(entry.sourceSession && send.entry.sourceSession && entry.sourceSession !== send.entry.sourceSession) &&
            send.text &&
            send.text === entry.text,
        );
      if (matching) matchedSends.add(matching.index);
      else replies.push(entry);
    }
    // The bot's private answer to the account holder: shown like a reply, marked private.
    if (entry.kind === "tool-call" && entry.toolName === "reply_owner") {
      const text = object(entry.args) && typeof entry.args.text === "string" ? entry.args.text : "";
      replies.push({ ...entry, kind: "assistant", whisper: true, text: text || "此回复没有可显示的文字" });
    }
    const send = sends.find((candidate) => candidate.index === index);
    if (send)
      replies.push({
        ...entry,
        kind: "assistant",
        text: send.text || "此回复没有可显示的文字",
        delivery: delivery(entry.toolCallId ? results.get(entry.toolCallId) : undefined),
        unsupportedParts: send.unsupported,
      });
    if (entry.kind === "event" && (entry.error || entry.eventType?.includes("failed"))) replies.push(entry);
  });
  return replies;
}

/** Full-page history keeps tool traces alongside readable sends, including in the chat filter. */
export function readableTimeline(entries: ConversationEntryView[]): ConversationEntryView[] {
  const projected = new Map(readableReplies(entries).map((entry) => [entry.id, entry]));
  return entries.flatMap((entry) => {
    const reply = projected.get(entry.id);
    if (["user", "assistant", "thought"].includes(entry.kind)) return reply ? [reply] : [];
    if (entry.kind === "tool-call" && reply?.kind === "assistant") return [{ ...reply, id: `reply:${entry.id}` }, entry];
    return [entry];
  });
}

/**
 * For a chat read as bubbles with its thoughts and tools: a delivered send is its bubble, so its call and result
 * rows are dropped; a send that did not go through keeps them, to open the details (user, 2026-11-17).
 */
export function withoutDeliveredSends(timeline: ReadableReply[]): ReadableReply[] {
  const delivered = new Set(
    timeline.filter((entry) => entry.kind === "assistant" && entry.delivery === "已发送" && entry.toolCallId).map((entry) => entry.toolCallId),
  );
  return timeline.filter((entry) => !((entry.kind === "tool-call" || entry.kind === "tool-result") && entry.toolCallId && delivered.has(entry.toolCallId)));
}

function delivery(result: ConversationEntryView | undefined): Delivery {
  if (!result) return "等待发送结果";
  if (result.error) return "发送失败";
  const value = resultValue(result);
  if (!object(value)) return "发送结果未知";
  return value.ok === true ? "已发送" : value.ok === false ? "发送失败" : "发送结果未知";
}

function sentMessageIds(result: ConversationEntryView | undefined): string[] {
  const value = result && !result.error ? resultValue(result) : undefined;
  return object(value) && value.ok === true && Array.isArray(value.messageIds)
    ? value.messageIds.filter((id): id is string => typeof id === "string" && !!id)
    : [];
}

function resultValue(result: ConversationEntryView): unknown {
  let value = result.result;
  if (object(value) && value.type === "json") value = value.value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

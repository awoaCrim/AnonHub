import type { AgentEntry, AgentMessage, AgentPlugin, ModelMessageContext } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";

import { compactSourceTimestamp } from "../conversations/compact.js";
import type { ContextBlockDescriptor } from "../conversations/context-blocks.js";
import {
  formatCurrentInput,
  formatCurrentInputWithImages,
  formatInput,
  formatInputWithImages,
  isEvent,
  isMessage,
  type InputImageResolution,
  type Message,
  type QuotedHistory,
} from "../messages/index.js";
import type { HistoryProjectionMode } from "../models/index.js";

/** Finds the original record of a quoted message among history blocks: the block and the entry itself. */
export type QuotedMessageLocator = (match: (entry: AgentEntry) => boolean) => Promise<{ block: ContextBlockDescriptor; entry: AgentEntry } | undefined>;

export interface DirectImageInputOptions {
  readonly resolveImage: (assetId: string, signal?: AbortSignal) => Promise<InputImageResolution>;
}

/**
 * Finds the message a current input quotes in this conversation's own history: when it was seen and,
 * once summarized, the history block holding it, so an old message is not taken as new. Archived
 * sessions are reached through the history blocks; without them only the live history is searched.
 */
export async function findQuotedHistory(
  message: Message,
  context: Pick<ModelMessageContext, "history">,
  locate?: QuotedMessageLocator,
): Promise<QuotedHistory | undefined> {
  const quote = message.data.quote;
  if (!quote) return undefined;
  const same = (candidate: AgentMessage): candidate is Message =>
    candidate !== message &&
    isMessage(candidate) &&
    candidate.data.messageId === quote.messageId &&
    candidate.data.platform === message.data.platform &&
    candidate.data.channel.id === message.data.channel.id;
  if (locate) {
    try {
      const found = await locate((entry) => entry.type === "message" && same(entry.data));
      if (found?.entry.type === "message")
        return { timestamp: compactSourceTimestamp(found.entry), ...(found.block.kind === "raw" ? {} : { blockId: found.block.id }) };
    } catch {
      /* Fall back to the live history below. */
    }
  }
  const original = context.history.find(same);
  return original ? { timestamp: original.timestamp } : undefined;
}

export function createModelInputPlugin(
  mode: HistoryProjectionMode = "default",
  deferMerge = false,
  directImageInput?: DirectImageInputOptions,
  quotedHistory?: (message: Message, context: ModelMessageContext) => Promise<QuotedHistory | undefined>,
): AgentPlugin {
  // One lookup per current input object across the turn's steps; history inputs are never annotated,
  // so their request prefix stays byte-identical.
  const quoted = new WeakMap<object, Promise<QuotedHistory | undefined>>();
  return {
    name: "core.model-input",
    enforce: "pre",
    toModelMessages: async (message, context) => {
      if (!isMessage(message) && !isEvent(message)) return [];
      const isCurrent = (context.activeInputs ?? context.current).some((current) => current.id === message.id);
      const isLive = directImageInput !== undefined && context.live?.some((live) => live.id === message.id) === true;
      let origin: QuotedHistory | undefined;
      if (isCurrent && quotedHistory && isMessage(message) && message.data.quote) {
        let pending = quoted.get(message);
        if (!pending) quoted.set(message, (pending = quotedHistory(message, context).catch(() => undefined)));
        origin = await pending;
      }
      if (directImageInput && (isCurrent || isLive)) {
        const resolve = (assetId: string) => directImageInput.resolveImage(assetId, context.signal);
        return [isCurrent ? await formatCurrentInputWithImages(message, resolve, origin) : await formatInputWithImages(message, resolve)];
      }
      return [isCurrent ? formatCurrentInput(message, origin) : formatInput(message)];
    },
    ...(mode === "gemini-native" && !deferMerge ? { prepareStep: (messages: readonly ModelMessage[]) => mergeAdjacentUserMessages(messages) } : {}),
  };
}

export function mergeAdjacentUserMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (previous?.role === "user" && message.role === "user") {
      result[result.length - 1] = mergeUserMessages(previous, message);
    } else {
      result.push(message);
    }
  }
  return result;
}

function mergeUserMessages(
  first: Extract<ModelMessage, { role: "user" }>,
  second: Extract<ModelMessage, { role: "user" }>,
): Extract<ModelMessage, { role: "user" }> {
  const providerOptions =
    first.providerOptions && second.providerOptions
      ? { ...first.providerOptions, ...second.providerOptions }
      : (first.providerOptions ?? second.providerOptions);
  return {
    ...first,
    content: mergeUserContent(first.content, second.content),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
}

function mergeUserContent(first: Extract<ModelMessage, { role: "user" }>["content"], second: Extract<ModelMessage, { role: "user" }>["content"]) {
  if (typeof first === "string" && typeof second === "string") return `${first}\n${second}`;
  const firstParts = typeof first === "string" ? [{ type: "text" as const, text: first }] : [...first];
  const secondParts = typeof second === "string" ? [{ type: "text" as const, text: second }] : [...second];
  return [...firstParts, { type: "text" as const, text: "\n" }, ...secondParts];
}

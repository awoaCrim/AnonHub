import type { Delivery } from "../lib/conversation-replies";
import { readableMessageText, senderNames } from "../lib/message-text";
import type { ConversationAssetView, ConversationDetail, ConversationEntryView } from "../state/history-types";

export type RecordFilter = "all" | "chat" | "thought" | "tool" | "event";

export interface MainNode {
  id: string;
  delivery?: Delivery;
  unsupportedParts?: boolean;
  groupKey?: string;
  kind: ConversationEntryView["kind"];
  timestamp: number;
  text?: string;
  thought?: string;
  reply?: string;
  sender?: string;
  whisper?: boolean;
  assets?: ConversationAssetView[];
  eventType?: string;
  decision?: string;
  willDebug?: unknown;
  /** Consecutive identical policy decisions shown as one line in the 全部 view. */
  repeats?: { timestamp: number; willDebug?: unknown }[];
  error?: { name?: string; message?: string };
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
}

export interface TurnGroup {
  id: string;
  start: number;
  mainNodes: MainNode[];
}

/**
 * One turn starts at each user message or runtime event. A thought and the reply of the same
 * stored group share a node, so the thought stays a disclosure beside its reply.
 */
export function buildTurnGroups(entries: ConversationEntryView[]): TurnGroup[] {
  const names = senderNames(entries.map((entry) => entry.sender));
  const groups: TurnGroup[] = [];
  let group: TurnGroup | undefined;
  let main: MainNode | undefined;
  const createGroup = (entry: ConversationEntryView): TurnGroup => ({ id: entry.id, start: entry.timestamp, mainNodes: [] });
  const createMain = (entry: ConversationEntryView): MainNode => ({
    delivery: "delivery" in entry ? (entry.delivery as Delivery) : undefined,
    unsupportedParts: "unsupportedParts" in entry ? Boolean(entry.unsupportedParts) : undefined,
    id: entry.id,
    groupKey: entry.groupKey,
    kind: entry.kind,
    timestamp: entry.timestamp,
    text: entry.kind === "user" && entry.text ? readableMessageText(entry.text, names) : entry.text,
    thought: entry.kind === "thought" ? entry.text : undefined,
    reply: entry.kind === "assistant" ? entry.text : undefined,
    sender: entry.sender,
    whisper: entry.whisper,
    assets: entry.assets,
    eventType: entry.eventType,
    decision: entry.decision,
    willDebug: entry.willDebug,
    error: entry.error,
    toolName: entry.toolName,
    toolCallId: entry.toolCallId,
    args: entry.args,
    result: entry.result,
  });
  for (const entry of entries) {
    if (entry.kind === "user" || entry.kind === "event") {
      group = createGroup(entry);
      groups.push(group);
      main = createMain(entry);
      group.mainNodes.push(main);
      continue;
    }
    if (!group) {
      group = createGroup(entry);
      groups.push(group);
    }
    if (entry.kind === "thought" || entry.kind === "assistant") {
      const sameTurn =
        main &&
        (main.kind === "thought" || main.kind === "assistant") &&
        main.groupKey &&
        main.groupKey === entry.groupKey &&
        !(main.reply && entry.kind === "assistant");
      if (main && sameTurn) {
        if (entry.kind === "thought" && entry.text && !main.thought) main.thought = entry.text;
        if (entry.kind === "assistant" && entry.text && !main.reply) main.reply = entry.text;
        if (main.reply) main.kind = "assistant";
      } else {
        main = createMain(entry);
        group.mainNodes.push(main);
      }
      continue;
    }
    group.mainNodes.push(createMain(entry));
    main = undefined;
  }
  return groups;
}

export interface NodeView {
  filter: RecordFilter;
  keyword: string;
  /** The embedded reader's default: only readable conversation and failures. */
  readableOnly: boolean;
}

/** Nodes of one turn for the current filter and search; the 全部 view folds repeated policy decisions. */
export function visibleNodes(group: TurnGroup, view: NodeView): MainNode[] {
  const keyword = view.keyword.trim().toLowerCase();
  const nodes = group.mainNodes.filter((node) => {
    if (view.readableOnly) {
      if (node.kind !== "user" && node.kind !== "assistant" && !node.error && !node.eventType?.includes("failed")) return false;
    } else if (!matchesFilter(node, view.filter)) return false;
    return !keyword || searchable(node, view.readableOnly).toLowerCase().includes(keyword);
  });
  return view.filter === "all" && !view.readableOnly ? foldDecisions(nodes) : nodes;
}

function matchesFilter(node: MainNode, filter: RecordFilter): boolean {
  if (filter === "chat") return node.kind === "user" || node.kind === "assistant";
  if (filter === "thought") return !!node.thought || node.kind === "thought";
  if (filter === "tool") return node.kind === "tool-call" || node.kind === "tool-result";
  if (filter === "event") return node.kind === "event" || node.kind === "will";
  return true;
}

function foldDecisions(nodes: MainNode[]): MainNode[] {
  const result: MainNode[] = [];
  for (const node of nodes) {
    const previous = result.at(-1);
    if (node.kind === "will" && previous?.kind === "will" && previous.decision === node.decision) {
      previous.repeats = [
        ...(previous.repeats ?? [{ timestamp: previous.timestamp, willDebug: previous.willDebug }]),
        { timestamp: node.timestamp, willDebug: node.willDebug },
      ];
      continue;
    }
    result.push(node.kind === "will" ? { ...node } : node);
  }
  return result;
}

function searchable(node: MainNode, readableOnly: boolean): string {
  if (readableOnly) return [node.text, node.reply, node.sender, node.error?.message, node.delivery].filter(Boolean).join(" ");
  return [
    node.text,
    node.thought,
    node.reply,
    node.sender,
    node.eventType,
    node.decision,
    prettyJson(node.willDebug),
    node.toolName,
    node.toolCallId,
    prettyJson(node.args),
    prettyJson(node.result),
    node.assets?.map((asset) => asset.title || asset.id).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

export function mergeEntries(first: ConversationEntryView[], second: ConversationEntryView[]): ConversationEntryView[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

export function summarizeEntries(entries: ConversationEntryView[], sizeBytes: number): ConversationDetail["summary"] {
  return {
    messageCount: entries.filter((entry) => entry.kind === "user" || entry.kind === "assistant").length,
    thoughtCount: entries.filter((entry) => entry.kind === "thought").length,
    toolCallCount: entries.filter((entry) => entry.kind === "tool-call").length,
    errorCount: entries.filter((entry) => entry.kind === "event" && entry.eventType?.includes("failed")).length,
    sizeBytes,
  };
}

export function eventTitle(node: MainNode): string {
  return node.eventType ?? "运行事件";
}

export const decisionLabel = (decision?: string) => (decision === "trigger" ? "决定回复" : "继续等待");

export function inlineJson(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text === undefined ? "" : text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return "";
  }
}

export function prettyJson(value: unknown): string {
  if (value === undefined || value === null) return "无";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * A tool call and its result read as one row: each result that answers a shown call is taken out of the
 * list and handed back keyed by that call. A result whose call is not on screen stays a row of its own.
 */
export function foldToolResults(nodes: readonly MainNode[]): { nodes: MainNode[]; resultOf: (call: MainNode) => MainNode | undefined } {
  const calls = new Set(nodes.filter((node) => node.kind === "tool-call" && node.toolCallId).map((node) => node.toolCallId));
  const results = new Map<string, MainNode>();
  for (const node of nodes) if (node.kind === "tool-result" && node.toolCallId && calls.has(node.toolCallId)) results.set(node.toolCallId, node);
  return {
    nodes: nodes.filter((node) => !(node.kind === "tool-result" && node.toolCallId && results.get(node.toolCallId) === node)),
    resultOf: (call) => (call.kind === "tool-call" && call.toolCallId ? results.get(call.toolCallId) : undefined),
  };
}

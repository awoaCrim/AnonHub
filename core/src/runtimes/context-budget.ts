import type { AgentModelRequestContext, AgentRequestOrigin } from "@yesimbot/agent-runtime";
import { AppError } from "@yesimbot/foundation";
import { asSchema, type ModelMessage, type ToolSet } from "ai";

import type { MagicContextConfig } from "../config.js";
import { RUNTIME_ERRORS } from "./errors.js";

/** Default `session.magicContext.triggerTokens`: actual main-model input that starts background summaries. */
export const CONTEXT_TRIGGER_TOKENS = 100_000;

/** Main request output cap and output reserve; a smaller model output limit still wins. */
export const OUTPUT_RESERVE_TOKENS = 8192;

/** Input capacity as a multiple of the trigger when no model limit is known: ordinary summaries fire before emergency. */
export const DERIVED_INPUT_CAPACITY_FACTOR = 1.25;

/** Internal planning controls, separate from the public Magic Context configuration. */
export interface ContextBudgetOptions extends Partial<Pick<MagicContextConfig, "triggerTokens">> {
  readonly historyBudgetPercentage?: number;
  readonly recentMessages?: number;
  readonly maxLoadedBlocks?: number;
  readonly pageTokenBudget?: number;
  readonly retainTurns?: number;
}

export interface ContextBudget {
  readonly contextWindow: number;
  readonly outputTokens: number;
  readonly marginTokens: number;
  readonly inputTokens: number;
  readonly historyTokens: number;
  readonly recentMessages: number;
  readonly maxLoadedBlocks: number;
  readonly pageTokens: number;
  readonly retainTurns: number;
}

export interface ContextBudgetRemovedUnit {
  readonly indices: readonly number[];
  readonly kind: AgentRequestOrigin["kind"];
  readonly sourceEntryIds: readonly string[];
  readonly blockIds: readonly string[];
}

export interface ContextBudgetPlan {
  readonly messages: readonly ModelMessage[];
  readonly estimatedInputTokens: number;
  readonly optionalTokens: number;
  readonly mandatoryInputTokens: number;
  readonly mandatoryHistoryTokens: number;
  readonly estimatedHistoryTokens: number;
  readonly evictedBlockIds: readonly string[];
  readonly removedSourceEntryIds: readonly string[];
  readonly removedHistorySourceEntryIds: readonly string[];
  readonly removedUnits: readonly ContextBudgetRemovedUnit[];
  readonly removedMessages: number;
}

export interface ContextBudgetPlanOptions {
  /**
   * Enforce the local estimate as a hard pre-provider limit. Core's Magic Context path leaves
   * this disabled because provider-reported usage is authoritative for completed requests.
   */
  readonly enforceBudget?: boolean;
  /** Keep units covering these proven source IDs when constructing a bounded raw fallback. */
  readonly preserveSourceEntryIds?: ReadonlySet<string>;
}

export interface RequestUnit {
  readonly indices: number[];
  mandatory: boolean;
  kind: AgentRequestOrigin["kind"];
  timestamp: number;
  readonly blockIds: Set<string>;
  readonly sourceEntryIds: Set<string>;
}

export function resolveContextBudget(config: ContextBudgetOptions, limit?: { context: number; output: number }): ContextBudget {
  if (limit) {
    positiveInteger(limit.context);
    positiveInteger(limit.output);
  }
  // A known model limit is authoritative. Otherwise the only configured length is the trigger,
  // and capacity is derived from it.
  const contextWindow = limit ? limit.context : derivedContextWindow(config.triggerTokens ?? CONTEXT_TRIGGER_TOKENS);
  positiveInteger(contextWindow);
  const outputTokens = limit ? Math.min(OUTPUT_RESERVE_TOKENS, limit.output) : OUTPUT_RESERVE_TOKENS;
  const marginTokens = Math.max(1024, Math.ceil(contextWindow * 0.1));
  const inputTokens = contextWindow - outputTokens - marginTokens;
  positiveInteger(inputTokens);
  const percentage = config.historyBudgetPercentage ?? 25;
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) throw new AppError(RUNTIME_ERRORS.context_budget_invalid, { effect: "none" });
  const historyTokens = Math.min(20_000, Math.floor((inputTokens * percentage) / 100));
  positiveInteger(historyTokens);
  const pageTokens = config.pageTokenBudget ?? 4096;
  positiveInteger(pageTokens, 4096);
  if (pageTokens < 128 || pageTokens > historyTokens) throw new AppError(RUNTIME_ERRORS.context_budget_invalid, { effect: "none" });
  const recentMessages = config.recentMessages ?? 20;
  const maxLoadedBlocks = config.maxLoadedBlocks ?? 4;
  const retainTurns = config.retainTurns ?? 2;
  positiveInteger(recentMessages, 200);
  positiveInteger(maxLoadedBlocks, 4);
  if (!Number.isSafeInteger(retainTurns) || retainTurns < 0 || retainTurns > 2) throw new AppError(RUNTIME_ERRORS.context_budget_invalid, { effect: "none" });
  return {
    contextWindow,
    outputTokens,
    marginTokens,
    inputTokens,
    historyTokens,
    recentMessages,
    maxLoadedBlocks,
    pageTokens,
    retainTurns,
  };
}

/**
 * Smallest window whose input capacity (window - output reserve - margin) reaches
 * `ceil(1.25 * trigger)`. Both closed-form bounds below are lower bounds of the answer (the margin
 * is at least 1024 and at least 10% of the window), so the final loop only closes a rounding gap.
 */
export function derivedContextWindow(triggerTokens: number): number {
  positiveInteger(triggerTokens);
  const input = Math.ceil(triggerTokens * DERIVED_INPUT_CAPACITY_FACTOR);
  let window = Math.max(input + OUTPUT_RESERVE_TOKENS + 1024, Math.ceil((input + OUTPUT_RESERVE_TOKENS) / 0.9));
  while (window - OUTPUT_RESERVE_TOKENS - windowMargin(window) < input) window += 1;
  return window;
}

/** UTF-8/framing estimate, not provider tokenization. Media payload bytes are never counted as text. */
export function estimateContextValue(value: unknown): number {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return 0;
  if (value === null) return 4;
  if (typeof value === "string") return Buffer.byteLength(JSON.stringify(value), "utf8");
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return 2 + value.reduce((sum, entry) => sum + estimateContextValue(entry) + 1, 0);
  if (typeof value !== "object") throw new AppError(RUNTIME_ERRORS.context_budget_media_unsupported, { effect: "none" });
  const record = value as Record<string, unknown>;
  const media = typeof record.type === "string" && ["image", "file", "image-data", "image-url", "file-data", "file-url", "media"].includes(record.type);
  if (media) {
    // Media payloads are provider-specific and must not be treated as UTF-8 text or
    // rejected because no local token estimate is available. Count only framing and
    // non-payload metadata; the provider remains authoritative for actual usage.
    return (
      64 +
      Object.entries(record).reduce(
        (sum, [key, entry]) => (["image", "file", "data", "url"].includes(key) ? sum : sum + estimateContextValue(key) + estimateContextValue(entry) + 2),
        0,
      )
    );
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new AppError(RUNTIME_ERRORS.context_budget_media_unsupported, { effect: "none" });
  if (value instanceof URL) return estimateContextValue(value.href);
  return 2 + Object.entries(record).reduce((sum, [key, entry]) => sum + estimateContextValue(key) + estimateContextValue(entry) + 2, 0);
}

export function estimateContextMessage(message: ModelMessage): number {
  return 32 + estimateContextValue(message);
}

export async function estimateContextBase(context: Pick<AgentModelRequestContext, "system" | "tools" | "toolChoice">): Promise<number> {
  const tools = await contextToolDefinitions(context.tools);
  return 128 + estimateContextValue(context.system) + estimateContextValue(tools) + estimateContextValue(context.toolChoice);
}

/** Loaded-page replacement must use the same atomic units as budget eviction. */
export function deduplicateContextHistory(
  context: Pick<AgentModelRequestContext, "messages" | "projection">,
  coveredSourceEntryIds: ReadonlySet<string>,
): ModelMessage[] {
  if (coveredSourceEntryIds.size === 0) return [...context.messages];
  const units = requestUnits(context.messages, context.projection?.describe(context.messages) ?? context.messages.map(() => undefined));
  const removed = new Set<number>();
  for (const unit of units) {
    if (unit.mandatory || unit.kind !== "history" || ![...unit.sourceEntryIds].some((id) => coveredSourceEntryIds.has(id))) continue;
    for (const index of unit.indices) removed.add(index);
  }
  return context.messages.filter((_, index) => !removed.has(index));
}

/** Operates only on proven optional history. Protocol-linked messages form one removal unit. */
export function planContextRequest(
  context: Pick<AgentModelRequestContext, "messages" | "projection">,
  budget: ContextBudget,
  baseTokens: number,
  multiplier = 1,
  options: ContextBudgetPlanOptions = {},
): ContextBudgetPlan {
  const messages = context.messages;
  const enforceBudget = options.enforceBudget ?? true;
  const units = requestUnits(messages, context.projection?.describe(messages) ?? messages.map(() => undefined));
  const costs = messages.map((message) => estimateContextMessage(message));
  const removed = new Set<number>();
  const evicted = new Set<string>();
  const removedUnits: RequestUnit[] = [];
  const cost = (unit: RequestUnit) => unit.indices.reduce((sum, index) => sum + costs[index]!, 0);
  const drop = (unit: RequestUnit) => {
    for (const index of unit.indices) removed.add(index);
    for (const id of unit.blockIds) evicted.add(id);
    if (!removedUnits.includes(unit)) removedUnits.push(unit);
  };
  const preserved = (unit: RequestUnit) =>
    options.preserveSourceEntryIds !== undefined && [...unit.sourceEntryIds].some((id) => options.preserveSourceEntryIds!.has(id));
  const history = units.filter((unit) => !unit.mandatory && unit.kind === "history").sort((a, b) => b.timestamp - a.timestamp);
  // Current context-tool receipts are protected, but their historical material
  // still shares H with summaries/pages (and already counts once in mandatory I).
  const mandatoryHistoryCost = units
    .filter((unit) => unit.mandatory)
    .reduce((sum, unit) => sum + unit.indices.reduce((total, index) => total + contextToolHistoryCost(messages[index]!), 0), 0);
  const measuredMandatoryHistory = Math.ceil(mandatoryHistoryCost * multiplier);
  if (enforceBudget && measuredMandatoryHistory > budget.historyTokens) throw new AppError(RUNTIME_ERRORS.context_budget_exceeded, { effect: "none" });
  const optionalHistoryBudget = Math.max(0, budget.historyTokens - measuredMandatoryHistory);
  // The recent-history ring is a soft working set, not an unbounded claimant on H.
  // Reserve space for explicitly loaded pages/summaries before selecting the ring;
  // otherwise a large ring would immediately evict every successful ctx_expand.
  const nonHistoryCost = units.filter((unit) => !unit.mandatory && unit.kind !== "history").reduce((sum, unit) => sum + cost(unit), 0);
  const ringAllowance = Math.max(0, Math.floor(optionalHistoryBudget / multiplier) - nonHistoryCost);
  let kept = 0;
  let ringCost = 0;
  for (const unit of history) {
    const unitCost = cost(unit);
    if (!preserved(unit) && (kept >= budget.recentMessages || ringCost + unitCost > ringAllowance)) drop(unit);
    else {
      kept += unit.indices.length;
      ringCost += unitCost;
    }
  }
  const mandatoryCost = units.filter((unit) => unit.mandatory).reduce((sum, unit) => sum + cost(unit), 0);
  const measuredMandatoryInput = Math.ceil((baseTokens + mandatoryCost) * multiplier);
  if (enforceBudget && measuredMandatoryInput > budget.inputTokens) throw new AppError(RUNTIME_ERRORS.context_budget_exceeded, { effect: "none" });
  const optional = units.filter((unit) => !unit.mandatory).sort((a, b) => rank(a.kind) - rank(b.kind) || a.timestamp - b.timestamp);
  let optionalCost = optional.filter((unit) => !removed.has(unit.indices[0]!)).reduce((sum, unit) => sum + cost(unit), 0);
  for (const unit of optional) {
    if (
      Math.ceil(optionalCost * multiplier) <= optionalHistoryBudget &&
      Math.ceil((baseTokens + mandatoryCost + optionalCost) * multiplier) <= budget.inputTokens
    )
      break;
    if (removed.has(unit.indices[0]!) || preserved(unit)) continue;
    drop(unit);
    optionalCost -= cost(unit);
  }
  const estimatedInputTokens = Math.ceil((baseTokens + mandatoryCost + optionalCost) * multiplier);
  if (enforceBudget && (estimatedInputTokens > budget.inputTokens || Math.ceil(optionalCost * multiplier) > optionalHistoryBudget))
    throw new AppError(RUNTIME_ERRORS.context_budget_exceeded, { effect: "none" });
  const removedSourceEntryIds = new Set<string>();
  const removedHistorySourceEntryIds = new Set<string>();
  for (const unit of removedUnits) {
    for (const id of unit.sourceEntryIds) {
      removedSourceEntryIds.add(id);
      if (unit.kind === "history") removedHistorySourceEntryIds.add(id);
    }
  }
  return {
    messages: messages.filter((_, index) => !removed.has(index)),
    estimatedInputTokens,
    optionalTokens: Math.ceil(optionalCost * multiplier),
    mandatoryInputTokens: Math.ceil((baseTokens + mandatoryCost) * multiplier),
    mandatoryHistoryTokens: Math.ceil(mandatoryHistoryCost * multiplier),
    estimatedHistoryTokens: Math.ceil(mandatoryHistoryCost * multiplier) + Math.ceil(optionalCost * multiplier),
    evictedBlockIds: [...evicted],
    removedSourceEntryIds: [...removedSourceEntryIds],
    removedHistorySourceEntryIds: [...removedHistorySourceEntryIds],
    removedUnits: removedUnits.map((unit) => ({
      indices: [...unit.indices],
      kind: unit.kind,
      sourceEntryIds: [...unit.sourceEntryIds],
      blockIds: [...unit.blockIds],
    })),
    removedMessages: removed.size,
  };
}

export function requestUnits(messages: readonly { readonly content: unknown }[], origins: readonly (AgentRequestOrigin | undefined)[]): RequestUnit[] {
  const parents = messages.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) index = parents[index]!;
    return index;
  };
  const union = (a: number, b: number) => {
    parents[find(b)] = find(a);
  };
  const sourceGroups = new Map<string, number>();
  origins.forEach((origin, index) => {
    if (!origin || origin.kind === "loaded") return;
    for (const id of origin.sourceEntryIds) {
      const previous = sourceGroups.get(id);
      if (previous === undefined) sourceGroups.set(id, index);
      else union(previous, index);
    }
  });
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (part.type !== "tool-call" && part.type !== "tool-result") continue;
      const map = part.type === "tool-call" ? calls : results;
      const indices = map.get(part.toolCallId) ?? [];
      indices.push(index);
      map.set(part.toolCallId, indices);
    }
  });
  const unresolved = new Set<number>();
  for (const id of new Set([...calls.keys(), ...results.keys()])) {
    const call = calls.get(id) ?? [];
    const result = results.get(id) ?? [];
    const all = [...call, ...result];
    if (call.length !== 1 || result.length !== 1) for (const index of all) unresolved.add(index);
    for (const index of all.slice(1)) union(all[0]!, index);
  }
  const byRoot = new Map<number, RequestUnit>();
  messages.forEach((_, index) => {
    const origin = origins[index];
    const mandatory = !origin || !["history", "summary", "loaded"].includes(origin.kind) || unresolved.has(index);
    const root = find(index);
    const unit = byRoot.get(root) ?? {
      indices: [],
      mandatory: false,
      kind: origin?.kind ?? "mandatory",
      timestamp: origin?.timestamp ?? 0,
      blockIds: new Set<string>(),
      sourceEntryIds: new Set<string>(),
    };
    unit.indices.push(index);
    unit.mandatory ||= mandatory;
    if (origin && rank(origin.kind) > rank(unit.kind)) unit.kind = origin.kind;
    unit.timestamp = Math.min(unit.timestamp, origin?.timestamp ?? unit.timestamp);
    if (origin?.blockId) unit.blockIds.add(origin.blockId);
    for (const id of origin?.sourceEntryIds ?? []) unit.sourceEntryIds.add(id);
    byRoot.set(root, unit);
  });
  return [...byRoot.values()];
}

function contextToolHistoryCost(message: ModelMessage): number {
  if (message.role !== "tool") return 0;
  return message.content.reduce(
    (sum, part) =>
      sum + (part.type === "tool-result" && ["ctx_search", "ctx_expand", "ctx_reduce"].includes(part.toolName) ? 32 + estimateContextValue(part) : 0),
    0,
  );
}

async function contextToolDefinitions(tools: ToolSet): Promise<unknown[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]) => ({
      name,
      description: tool.description,
      type: tool.type,
      ...("id" in tool ? { id: tool.id } : {}),
      ...("args" in tool ? { args: tool.args } : {}),
      parameters: await asSchema(tool.inputSchema).jsonSchema,
    })),
  );
}

function rank(kind: AgentRequestOrigin["kind"]): number {
  switch (kind) {
    case "loaded":
      return 0;
    case "history":
      return 1;
    case "summary":
      return 2;
    default:
      return 3;
  }
}

function windowMargin(contextWindow: number): number {
  return Math.max(1024, Math.ceil(contextWindow * 0.1));
}

function positiveInteger(value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new AppError(RUNTIME_ERRORS.context_budget_invalid, { effect: "none" });
}

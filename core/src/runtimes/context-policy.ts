import type { AgentModelRequestContext } from "@yesimbot/agent-runtime";
import { AppError } from "@yesimbot/foundation";

import { CONTEXT_TRIGGER_TOKENS, estimateContextMessage, requestUnits } from "./context-budget.js";
import { RUNTIME_ERRORS } from "./errors.js";

export const CONTEXT_TARGET_TOKENS = 80_000;

/** Smallest configurable trigger: below this the system prompt and tools alone would keep it firing. */
export const MIN_CONTEXT_TRIGGER_TOKENS = 8_000;

export const CONTEXT_SAFETY_WAIT_MS = 60_000;

export const CONTEXT_REGION_SOURCE_BYTES = 48_000;

export const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholds = { trigger: CONTEXT_TRIGGER_TOKENS, target: CONTEXT_TARGET_TOKENS };

const tiers: readonly ContextTier[] = ["P1", "P2", "P3", "P4"];

export type ContextTier = "P1" | "P2" | "P3" | "P4";

export interface TierRegion {
  readonly id: string;
  readonly data: { readonly importance: number; readonly tiers: Readonly<Record<ContextTier, string>> };
}

/** When summaries start (`trigger`) and the soft size they work toward (`target`, 80% of the trigger). */
export interface ContextThresholds {
  readonly trigger: number;
  readonly target: number;
}

/** The configured trigger, or the default 100k; an unusable value never silently becomes a tiny trigger. */
export function contextThresholds(triggerTokens: number | undefined): ContextThresholds {
  if (triggerTokens === undefined) return DEFAULT_CONTEXT_THRESHOLDS;
  if (!Number.isSafeInteger(triggerTokens) || triggerTokens < MIN_CONTEXT_TRIGGER_TOKENS)
    throw new AppError(RUNTIME_ERRORS.context_trigger_invalid, { effect: "none" });
  return { trigger: triggerTokens, target: Math.floor(triggerTokens * 0.8) };
}

export function contextPressure(actual: number | undefined, estimate: number, capacity: number, thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS) {
  const valid = typeof actual === "number" && Number.isFinite(actual) && actual > 0;
  return {
    ordinary: valid && actual >= thresholds.trigger,
    emergency: (valid && actual >= capacity * 0.95) || estimate > capacity,
    unsafe: estimate > capacity,
    target: Math.min(thresholds.target, Math.floor(capacity * 0.8)),
  };
}

/** Recent protection is token-based. Every source fanout and call/result pair stays atomic. */
export function contextCandidates(
  context: Pick<AgentModelRequestContext, "messages" | "projection" | "currentMessageIds">,
  covered: ReadonlySet<string>,
  capacity: number,
  multiplier: number,
  baseTokens = 0,
  sourceCosts?: ReadonlyMap<string, number>,
  messageTokenCosts?: readonly number[],
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): string[][] {
  const current = new Set(context.currentMessageIds);
  const units = requestUnits(context.messages, context.projection?.describe(context.messages) ?? context.messages.map(() => undefined));
  const historical = units
    .filter(
      (unit) =>
        !unit.mandatory &&
        unit.kind === "history" &&
        unit.sourceEntryIds.size > 0 &&
        ![...unit.sourceEntryIds].some((id) => current.has(id) || covered.has(id)),
    )
    .sort((a, b) => a.timestamp - b.timestamp || a.indices[0]! - b.indices[0]!);
  const tokenCost = (index: number) => messageTokenCosts?.[index] ?? estimateContextMessage(context.messages[index]!) * multiplier;
  const mandatoryTokens =
    baseTokens * multiplier +
    units
      .filter((unit) => unit.mandatory || [...unit.sourceEntryIds].some((id) => current.has(id)))
      .reduce((sum, unit) => sum + unit.indices.reduce((total, index) => total + tokenCost(index), 0), 0);
  const protectedTokens = Math.max(0, Math.floor(Math.min(Math.min(thresholds.target, capacity * 0.8) * 0.2, capacity * 0.9 - mandatoryTokens)));
  let tailTokens = 0;
  const eligible = new Set<(typeof historical)[number]>();
  for (const unit of [...historical].reverse()) {
    const cost = unit.indices.reduce((sum, index) => sum + tokenCost(index), 0);
    if (tailTokens + cost > protectedTokens) {
      eligible.add(unit);
      tailTokens = protectedTokens;
    } else tailTokens += cost;
  }
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const unit of historical) {
    if (!eligible.has(unit)) continue;
    // The historian reads public source records, not the full projected tool transcript.
    // Size that input when it is available: complete private tool pairs have zero public
    // body cost and can accompany nearby dialogue without producing empty-only jobs.
    // Manifest overhead still bounds large groups of otherwise zero-cost source IDs.
    const cost = sourceCosts
      ? [...unit.sourceEntryIds].reduce((sum, id) => sum + (sourceCosts.get(id) ?? Infinity), 0) +
        Buffer.byteLength(JSON.stringify([...unit.sourceEntryIds]), "utf8")
      : unit.indices.reduce((sum, index) => sum + estimateContextMessage(context.messages[index]!), 0);
    // Oversized indivisible public sources remain raw; never split a protocol chain.
    if (!Number.isFinite(cost) || cost > CONTEXT_REGION_SOURCE_BYTES) continue;
    if (bytes + cost > CONTEXT_REGION_SOURCE_BYTES && batch.length) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(...unit.sourceEntryIds);
    bytes += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Age counts newer partitions, never wall-clock time. Pressure applies only to summaries. */
export function selectContextTiers(regions: readonly TierRegion[], budget: number, multiplier: number): Map<string, ContextTier | null> {
  const selected = new Map<string, ContextTier | null>();
  const cost = (region: TierRegion, tier: ContextTier) => (Buffer.byteLength(region.data.tiers[tier], "utf8") + 256) * multiplier;
  for (const [index, region] of regions.entries()) {
    const age = regions.length - index - 1;
    const decay = Math.floor(Math.log2(age + 1) / (1 + 2 * region.data.importance));
    selected.set(region.id, decay >= 5 ? null : tiers[Math.min(3, decay)]!);
  }
  let total = regions.reduce((sum, region) => {
    const tier = selected.get(region.id);
    return sum + (tier ? cost(region, tier) : 0);
  }, 0);
  // Low-importance/older regions yield first; latest P1 is a delta until pressure requires less.
  const order = regions.map((region, index) => ({ region, index })).sort((a, b) => a.region.data.importance - b.region.data.importance || a.index - b.index);
  for (let pass = 0; pass < 4 && total > budget; pass++) {
    for (const { region } of order) {
      if (total <= budget) break;
      const tier = selected.get(region.id);
      if (!tier) continue;
      const next = tiers[tiers.indexOf(tier) + 1] ?? null;
      total -= cost(region, tier) - (next ? cost(region, next) : 0);
      selected.set(region.id, next);
    }
  }
  return selected;
}

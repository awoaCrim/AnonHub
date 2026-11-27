import type { NormalizedUsage, TokenCounts, UsageRow } from "./types.js";

/** Days before today included in the snapshot (the `recent` series has this many days plus today). */
export const RECENT_DAY_COUNT = 30;

export function emptyTokenCounts(): TokenCounts {
  return { calls: 0, inputTokens: 0, outputTokens: 0, noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function getLocalDateNumber(date: Date = new Date()): number {
  return Math.floor((date.valueOf() / 60_000 - date.getTimezoneOffset()) / 1440);
}

export function addRow(target: TokenCounts, row: UsageRow): void {
  target.calls += row.calls;
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.noCacheTokens += row.noCacheTokens;
  target.cacheReadTokens += row.cacheReadTokens;
  target.cacheWriteTokens += row.cacheWriteTokens;
}

export function addUsage(target: TokenCounts, usage: NormalizedUsage): void {
  target.calls += 1;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.noCacheTokens += usage.noCacheTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
}

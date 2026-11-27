import type { TokenCounts, UsagePayload } from "@yesimbot/contracts";

export function compact(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

export function cacheHitRate(counts: Pick<TokenCounts, "cacheReadTokens" | "noCacheTokens">): string {
  const total = counts.cacheReadTokens + counts.noCacheTokens;
  return total > 0 ? `${((counts.cacheReadTokens / total) * 100).toFixed(1)}%` : "—";
}

/** `date` counts local calendar days since the epoch: `10/25`. */
const dayLabel = (date: number) => new Date(date * 86_400_000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", timeZone: "UTC" });

/** Oldest first. The payload lists today first. */
export function dailySeries(payload: UsagePayload) {
  const days = payload.recent.slice().reverse();
  return {
    labels: days.map((day) => dayLabel(day.date)),
    input: days.map((day) => [day.cacheReadTokens, day.noCacheTokens]),
    output: days.map((day) => [day.outputTokens]),
  };
}

export function hourlySeries(payload: UsagePayload) {
  return {
    labels: payload.byHour.map((entry) => `${entry.hour}:00`),
    input: payload.byHour.map((hour) => [hour.cacheReadTokens, hour.noCacheTokens]),
    output: payload.byHour.map((hour) => [hour.outputTokens]),
  };
}

export function modelRows(payload: UsagePayload) {
  return payload.byModel
    .slice()
    .sort((a, b) => b.counts.inputTokens + b.counts.outputTokens - (a.counts.inputTokens + a.counts.outputTokens))
    .map((row) => ({ ...row, total: row.counts.inputTokens + row.counts.outputTokens, hit: cacheHitRate(row.counts) }));
}

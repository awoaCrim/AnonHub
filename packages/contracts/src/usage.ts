export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TokenCounts extends NormalizedUsage {
  calls: number;
}

export interface RateSnapshot {
  inputPerMinute: number;
  outputPerMinute: number;
  totalPerMinute: number;
  noCachePerMinute: number;
  cacheReadPerMinute: number;
}

export interface UsageByModel {
  model: string;
  kind: "chat" | "embedding";
  counts: TokenCounts;
}

export interface UsagePayload {
  today: TokenCounts;
  recent: Array<TokenCounts & { date: number }>;
  byHour: Array<TokenCounts & { hour: number }>;
  byModel: UsageByModel[];
  rate: RateSnapshot;
}

import type { NormalizedUsage, TokenCounts } from "@yesimbot/contracts";

export interface UsageHistorySnapshot {
  recent: Array<TokenCounts & { date: number }>;
  byHour: Array<TokenCounts & { hour: number }>;
}

export interface UsageHistorySource {
  scan(): Promise<UsageHistorySnapshot>;
}

export interface UsageRow {
  date: number;
  hour: number;
  provider: string;
  model: string;
  kind: "chat" | "embedding";
  calls: number;
  inputTokens: number;
  outputTokens: number;
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageRecordInput {
  providerId: string;
  modelId: string;
  timestamp: number;
  kind: "chat" | "embedding";
  usage: NormalizedUsage;
}

export type { NormalizedUsage, TokenCounts, RateSnapshot, UsageByModel, UsagePayload } from "@yesimbot/contracts";

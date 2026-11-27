import { systemClock, type Clock } from "@yesimbot/foundation";

import { addRow, emptyTokenCounts, getLocalDateNumber, RECENT_DAY_COUNT } from "./aggregate.js";
import type { NormalizedUsage, RateSnapshot, UsageByModel, UsageHistorySource, UsagePayload, UsageRecordInput, UsageRow } from "./types.js";

/** The snapshot sums the whole window and labels it per minute, so the window must be 60 one-second slots. */
const RATE_WINDOW_SECONDS = 60;

/** The hourly aggregate table: rows from a day on, and adding one call's counters onto the row with the same key. */
export interface UsageTable {
  rowsSince(date: number): Promise<UsageRow[]>;
  add(row: UsageRow): Promise<void>;
}

export class RateWindow {
  private readonly input: number[];
  private readonly output: number[];
  private readonly noCache: number[];
  private readonly cacheRead: number[];

  public constructor() {
    this.input = new Array(RATE_WINDOW_SECONDS).fill(0);
    this.output = new Array(RATE_WINDOW_SECONDS).fill(0);
    this.noCache = new Array(RATE_WINDOW_SECONDS).fill(0);
    this.cacheRead = new Array(RATE_WINDOW_SECONDS).fill(0);
  }

  public tick(): void {
    this.input.unshift(0);
    this.output.unshift(0);
    this.noCache.unshift(0);
    this.cacheRead.unshift(0);
    this.input.pop();
    this.output.pop();
    this.noCache.pop();
    this.cacheRead.pop();
  }

  public add(usage: NormalizedUsage): void {
    this.input[0] += usage.inputTokens;
    this.output[0] += usage.outputTokens;
    this.noCache[0] += usage.noCacheTokens;
    this.cacheRead[0] += usage.cacheReadTokens;
  }

  public snapshot(): RateSnapshot {
    const inputPerMinute = this.sum(this.input);
    const outputPerMinute = this.sum(this.output);
    return {
      inputPerMinute,
      outputPerMinute,
      totalPerMinute: inputPerMinute + outputPerMinute,
      noCachePerMinute: this.sum(this.noCache),
      cacheReadPerMinute: this.sum(this.cacheRead),
    };
  }

  private sum(values: readonly number[]): number {
    return values.reduce((total, value) => total + value, 0);
  }
}

export class UsageStore {
  private readonly rate = new RateWindow();
  private tail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly table: UsageTable,
    private readonly history: UsageHistorySource,
    private readonly clock: Clock = systemClock(),
  ) {}

  public record(input: UsageRecordInput): void {
    // Day and hour buckets stay in the process time zone, as the stored rows were written.
    const now = new Date(this.clock.now());
    this.rate.add(input.usage);
    const row: UsageRow = {
      date: getLocalDateNumber(now),
      hour: now.getHours(),
      provider: input.providerId,
      model: input.modelId,
      kind: input.kind,
      calls: 1,
      ...input.usage,
    };
    void this.enqueueUpsert(row).catch(() => undefined);
  }

  public tickRate(): void {
    this.rate.tick();
  }

  public async snapshot(): Promise<UsagePayload> {
    const today = getLocalDateNumber(new Date(this.clock.now()));
    const rows = await this.table.rowsSince(today - RECENT_DAY_COUNT);

    const todayCounts = emptyTokenCounts();
    const byModel = new Map<string, UsageByModel>();

    for (const row of rows) {
      if (row.date > today) continue;
      if (row.date === today) addRow(todayCounts, row);

      const key = `${row.kind}:${row.provider}:${row.model}`;
      const modelEntry = byModel.get(key) ?? { model: `${row.provider}:${row.model}`, kind: row.kind, counts: emptyTokenCounts() };
      addRow(modelEntry.counts, row);
      byModel.set(key, modelEntry);
    }

    const history = await this.history.scan();
    return {
      today: todayCounts,
      recent: history.recent,
      byHour: history.byHour,
      byModel: [...byModel.values()]
        .sort((left, right) => left.counts.inputTokens + left.counts.outputTokens - (right.counts.inputTokens + right.counts.outputTokens))
        .reverse(),
      rate: this.rate.snapshot(),
    };
  }

  private enqueueUpsert(row: UsageRow): Promise<void> {
    const task = this.tail.then(() => this.table.add(row));
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

export { emptyTokenCounts, getLocalDateNumber } from "./aggregate.js";

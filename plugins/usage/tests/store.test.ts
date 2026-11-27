import { describe, expect, it, vi } from "vitest";

import { emptyTokenCounts, getLocalDateNumber, RateWindow, UsageStore } from "../src/store.js";
import type { UsageHistorySnapshot, UsageRow } from "../src/types.js";

function usageRow(overrides: Partial<UsageRow>): UsageRow {
  return {
    date: getLocalDateNumber(),
    hour: 0,
    provider: "openai",
    model: "gpt-4o",
    kind: "chat",
    calls: 1,
    inputTokens: 10,
    outputTokens: 5,
    noCacheTokens: 6,
    cacheReadTokens: 4,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

describe("UsageStore", () => {
  it("only counts today rows in the today aggregate and takes the series from the history source", async () => {
    const today = getLocalDateNumber();
    const rows = [usageRow({ calls: 2, inputTokens: 20, outputTokens: 10 }), usageRow({ date: today - 1, calls: 5, inputTokens: 50, outputTokens: 25 })];
    const rowsSince = vi.fn(async () => rows);
    const table = { rowsSince, add: vi.fn() };
    const series: UsageHistorySnapshot = { recent: [{ date: today, ...emptyTokenCounts(), calls: 3 }], byHour: [{ hour: 0, ...emptyTokenCounts(), calls: 3 }] };
    const history = { scan: vi.fn(async () => series) };
    const store = new UsageStore(table, history);

    const payload = await store.snapshot();

    expect(rowsSince).toHaveBeenCalledWith(today - 30);
    expect(payload.today.calls).toBe(2);
    expect(payload.today.inputTokens).toBe(20);
    expect(payload.byModel).toEqual([{ model: "openai:gpt-4o", kind: "chat", counts: expect.objectContaining({ calls: 7, inputTokens: 70 }) }]);
    expect(payload.recent).toBe(series.recent);
    expect(payload.byHour).toBe(series.byHour);
  });
});

describe("RateWindow", () => {
  it("keeps a rolling 60-second per-minute sum", () => {
    const rate = new RateWindow();
    rate.add({ inputTokens: 10, outputTokens: 5, noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    rate.tick();
    rate.add({ inputTokens: 2, outputTokens: 1, noCacheTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 0 });

    expect(rate.snapshot()).toMatchObject({ inputPerMinute: 12, outputPerMinute: 6, noCachePerMinute: 10, cacheReadPerMinute: 2 });

    for (let second = 0; second < 59; second += 1) rate.tick();
    expect(rate.snapshot()).toMatchObject({ inputPerMinute: 2, outputPerMinute: 1, noCachePerMinute: 0, cacheReadPerMinute: 2 });

    rate.tick();
    expect(rate.snapshot()).toMatchObject({ inputPerMinute: 0, outputPerMinute: 0, totalPerMinute: 0 });
  });
});

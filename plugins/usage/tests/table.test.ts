import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDb, configureStorage } from "@yesimbot/foundation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sqliteUsageTable } from "../src/table.js";
import type { UsageRow } from "../src/types.js";

let root: string;

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    date: 20_000,
    hour: 3,
    provider: "openai",
    model: "gpt",
    kind: "chat",
    calls: 1,
    inputTokens: 10,
    outputTokens: 5,
    noCacheTokens: 6,
    cacheReadTokens: 4,
    cacheWriteTokens: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "usage-table-"));
  configureStorage({ dataRoot: root });
});

afterEach(async () => {
  closeStateDb();
  await rm(root, { recursive: true, force: true });
});

describe("sqliteUsageTable", () => {
  it("adds a call's counters onto the row with the same key and reads rows from a day on", async () => {
    const table = sqliteUsageTable();
    await table.add(row());
    await table.add(row({ inputTokens: 7, outputTokens: 2, noCacheTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 }));
    await table.add(row({ date: 19_990 }));
    await table.add(row({ kind: "embedding" }));

    const rows = await table.rowsSince(19_995);
    expect(rows).toHaveLength(2);
    expect(rows.find((item) => item.kind === "chat")).toEqual(
      row({ calls: 2, inputTokens: 17, outputTokens: 7, noCacheTokens: 13, cacheReadTokens: 4, cacheWriteTokens: 1 }),
    );
    expect(await table.rowsSince(0)).toHaveLength(3);
  });
});

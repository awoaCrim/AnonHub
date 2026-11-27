import { ensureTables, stateDb } from "@yesimbot/foundation";

import type { UsageTable } from "./store.js";
import type { UsageRow } from "./types.js";

/** Hourly aggregates per provider, model and kind, in the shared SQLite database (convention 08). */
export const USAGE_TABLE = "usage_hourly";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${USAGE_TABLE} (
    date INTEGER NOT NULL,
    hour INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    kind TEXT NOT NULL,
    calls INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    no_cache_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    PRIMARY KEY (date, hour, provider, model, kind)
  )`,
] as const;

const COLUMNS = `date, hour, provider, model, kind, calls, input_tokens AS inputTokens, output_tokens AS outputTokens,
  no_cache_tokens AS noCacheTokens, cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens`;

const ADD = `INSERT INTO ${USAGE_TABLE}
  (date, hour, provider, model, kind, calls, input_tokens, output_tokens, no_cache_tokens, cache_read_tokens, cache_write_tokens)
  VALUES (:date, :hour, :provider, :model, :kind, :calls, :inputTokens, :outputTokens, :noCacheTokens, :cacheReadTokens, :cacheWriteTokens)
  ON CONFLICT (date, hour, provider, model, kind) DO UPDATE SET
    calls = calls + excluded.calls, input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens, no_cache_tokens = no_cache_tokens + excluded.no_cache_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`;

/** The aggregate table; created on first use. */
export function sqliteUsageTable(): UsageTable {
  let ready = false;
  const db = () => {
    if (!ready) {
      ensureTables("usage", DDL);
      ready = true;
    }
    return stateDb();
  };
  return {
    rowsSince: async (date) => db().prepare(`SELECT ${COLUMNS} FROM ${USAGE_TABLE} WHERE date >= ?`).all(date) as unknown as UsageRow[],
    add: async (row) => {
      db()
        .prepare(ADD)
        .run({ ...row });
    },
  };
}

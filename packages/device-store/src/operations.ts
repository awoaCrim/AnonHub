import type { DatabaseSync } from "node:sqlite";

import { type Clock, digestJson, systemClock } from "@yesimbot/foundation";

import { ensureSchema, openDeviceDatabase, transaction } from "./database.js";

/**
 * How long a succeeded operation keeps its full result. Replays come within minutes (a deadline is at most ten minutes
 * away), and the outputs, screenshots most of all, grew the gateway's ledger to 8 GB in two weeks (user, 2026-11-20:
 * 「操作日志也允许清理」). The row itself, with its fingerprint, stays: a replay still never runs again.
 */
export const OPERATION_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** What a succeeded result older than the retention reads as. */
export const EXPIRED_OPERATION_RESULT = { status: "succeeded", output: { resultExpired: true } } as const;

/** A result this small stays whole: it costs nothing and keeps a late status query exact. */
const KEPT_RESULT_BYTES = 1024;

/** How often an open store clears results past the retention. */
const MAINTENANCE_MS = 60 * 60 * 1000;

/** Free space (bytes) after which the file is compacted; below it the space is simply reused. */
const VACUUM_FREE_BYTES = 64 * 1024 * 1024;

export interface StoredOperation {
  fingerprint: string;
  result?: unknown;
}

/**
 * A durable tombstone is retained even when execution crashes. IDs are never recycled. Succeeded results older than
 * `OPERATION_RESULT_RETENTION_MS` keep only their status (`maintain`, run at open and hourly).
 */
export class OperationStore {
  private readonly timer: ReturnType<typeof setInterval>;
  private constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {
    this.timer = setInterval(() => {
      try {
        this.maintain();
      } catch {
        // A busy or failing maintenance pass changes nothing; the next one tries again.
      }
    }, MAINTENANCE_MS);
    this.timer.unref?.();
  }
  static async open(directory: string, clock: Clock = systemClock()): Promise<OperationStore> {
    const db = await openDeviceDatabase(directory, "operations");
    try {
      ensureSchema(
        db,
        `CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT, created INTEGER NOT NULL
      );`,
      );
      const store = new OperationStore(db, clock);
      try {
        store.maintain();
      } catch {
        // Cleanup never keeps the ledger from opening; the hourly pass tries again.
      }
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  claim(id: string, input: unknown): { created: boolean; operation: StoredOperation } {
    const fingerprint = fingerprintValue(input);
    return transaction(this.db, () => {
      const existing = this.get(id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("operation_id_conflict");
        return { created: false, operation: existing };
      }
      // Never prune tombstones automatically: a replay must not become a new side effect.
      if (Number(this.db.prepare("SELECT COUNT(*) n FROM operations").get()?.n) >= 1_000_000) throw new Error("operation_capacity");
      this.db.prepare("INSERT INTO operations VALUES (?, ?, NULL, ?)").run(id, fingerprint, this.clock.now());
      return { created: true, operation: { fingerprint } };
    });
  }

  get(id: string): StoredOperation | undefined {
    const row = this.db.prepare("SELECT fingerprint, result FROM operations WHERE id = ?").get(id);
    return row ? { fingerprint: String(row.fingerprint), ...(row.result === null ? {} : { result: JSON.parse(String(row.result)) }) } : undefined;
  }

  finish(id: string, result: unknown): void {
    transaction(this.db, () => {
      const existing = this.get(id);
      if (!existing) throw new Error("unknown_operation");
      if (existing.result !== undefined && fingerprintValue(existing.result) !== fingerprintValue(result)) throw new Error("operation_result_conflict");
      this.db.prepare("UPDATE operations SET result = ? WHERE id = ?").run(JSON.stringify(result), id);
    });
  }

  /**
   * Replaces the results of succeeded operations past the retention with `EXPIRED_OPERATION_RESULT`, then compacts the
   * file when much of it is free. Rows, fingerprints and other results stay. Returns how many results were cleared.
   */
  maintain(now = this.clock.now()): number {
    const cleared = Number(
      this.db
        .prepare(
          // Results are stored as parsed, `status` first; anything else is left as it is.
          `UPDATE operations SET result = ? WHERE created < ? AND result IS NOT NULL AND length(CAST(result AS BLOB)) > ? AND substr(result, 1, 21) = '{"status":"succeeded"'`,
        )
        .run(JSON.stringify(EXPIRED_OPERATION_RESULT), now - OPERATION_RESULT_RETENTION_MS, KEPT_RESULT_BYTES).changes,
    );
    const free = Number(this.db.prepare("PRAGMA freelist_count").get()?.freelist_count) * Number(this.db.prepare("PRAGMA page_size").get()?.page_size);
    if (free > VACUUM_FREE_BYTES) {
      // The copy VACUUM builds stays in memory: a sandboxed service (the gateway's systemd unit) cannot write /tmp, and
      // what remains after clearing results is small.
      this.db.exec("PRAGMA temp_store=MEMORY");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.exec("VACUUM");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    return cleared;
  }

  close(): void {
    clearInterval(this.timer);
    this.db.close();
  }
}

/** SHA-256 of the value as canonical JSON (keys sorted); stored, so it must stay stable. */
export function fingerprintValue(value: unknown): string {
  return digestJson(value);
}

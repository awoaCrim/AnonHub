import { ensureTables, stateDb } from "@yesimbot/foundation";

import type { ScheduleQuery, ScheduleTable } from "./store.js";
import type { ScheduleRow } from "./types.js";

/** Scheduled tasks in the shared SQLite database (convention 08). */
export const SCHEDULE_TABLE = "schedule_tasks";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${SCHEDULE_TABLE} (
    id TEXT NOT NULL PRIMARY KEY,
    type TEXT NOT NULL,
    platform TEXT NOT NULL,
    self_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    notes TEXT,
    purpose TEXT NOT NULL DEFAULT 'task',
    delivery TEXT NOT NULL DEFAULT 'channel',
    kind TEXT NOT NULL,
    at TEXT,
    cron TEXT,
    state TEXT NOT NULL,
    next_run_at TEXT,
    last_result TEXT,
    runs TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
] as const;

/** Row field to column; `lastResult` and `runs` hold JSON text. */
const COLUMNS = {
  id: "id",
  type: "type",
  platform: "platform",
  selfId: "self_id",
  channelId: "channel_id",
  userId: "user_id",
  title: "title",
  prompt: "prompt",
  notes: "notes",
  purpose: "purpose",
  delivery: "delivery",
  kind: "kind",
  at: "at",
  cron: "cron",
  state: "state",
  nextRunAt: "next_run_at",
  lastResult: "last_result",
  runs: "runs",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const satisfies Record<Field, string>;

const FIELDS = Object.keys(COLUMNS) as Field[];
const JSON_FIELDS: ReadonlySet<Field> = new Set(["lastResult", "runs"]);
const DEFAULTS: Partial<Record<Field, string>> = { purpose: "task", delivery: "channel" };
const SELECT = FIELDS.map((field) => (COLUMNS[field] === field ? field : `${COLUMNS[field]} AS ${field}`)).join(", ");

type Field = keyof ScheduleRow;

type Stored = Record<string, string | null>;

/** The schedule table; created on first use. `set` and `remove` on a missing row change nothing. */
export function sqliteScheduleTable(): ScheduleTable {
  let ready = false;
  const db = () => {
    if (!ready) {
      ensureTables("schedule", DDL);
      ready = true;
    }
    return stateDb();
  };
  return {
    get: async (query) => {
      const { where, params } = filter(query);
      return (db().prepare(`SELECT ${SELECT} FROM ${SCHEDULE_TABLE}${where} ORDER BY rowid`).all(params) as Stored[]).map(fromStored);
    },
    create: async (row) => {
      const columns = FIELDS.map((field) => COLUMNS[field]);
      db()
        .prepare(`INSERT INTO ${SCHEDULE_TABLE} (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`)
        .run(toStored(row, true));
    },
    set: async (query, patch) => {
      const fields = (Object.keys(patch) as Field[]).filter((field) => patch[field] !== undefined);
      if (fields.length === 0) return;
      const { where, params } = filter(query);
      const stored = toStored(patch);
      db()
        .prepare(`UPDATE ${SCHEDULE_TABLE} SET ${fields.map((field) => `${COLUMNS[field]} = :set_${COLUMNS[field]}`).join(", ")}${where}`)
        .run({ ...Object.fromEntries(fields.map((field) => [`set_${COLUMNS[field]}`, stored[COLUMNS[field]] ?? null])), ...params });
    },
    remove: async (query) => {
      const { where, params } = filter(query);
      db().prepare(`DELETE FROM ${SCHEDULE_TABLE}${where}`).run(params);
    },
  };
}

/** Equality on every given field; an empty query selects every row. */
function filter(query: ScheduleQuery): { where: string; params: Record<string, string> } {
  const fields = (Object.keys(query) as Array<keyof ScheduleQuery>).filter((field) => query[field] !== undefined);
  return {
    where: fields.length ? ` WHERE ${fields.map((field) => `${COLUMNS[field]} = :${COLUMNS[field]}`).join(" AND ")}` : "",
    params: Object.fromEntries(fields.map((field) => [COLUMNS[field], query[field] as string])),
  };
}

function toStored(row: Partial<ScheduleRow>, defaults = false): Stored {
  const stored: Stored = {};
  for (const field of FIELDS) {
    const value = row[field] ?? (defaults ? DEFAULTS[field] : undefined);
    stored[COLUMNS[field]] = value === undefined || value === null ? null : JSON_FIELDS.has(field) ? JSON.stringify(value) : (value as string);
  }
  return stored;
}

function fromStored(stored: Stored): ScheduleRow {
  return {
    ...stored,
    lastResult: stored.lastResult === null ? null : JSON.parse(stored.lastResult),
    runs: stored.runs === null ? null : JSON.parse(stored.runs),
  } as unknown as ScheduleRow;
}

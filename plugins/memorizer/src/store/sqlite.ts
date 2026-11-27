import { ensureTables, stateDb } from "@yesimbot/foundation";

import type { MemoryRow } from "../types.js";
import type { MemoryPatch, MemoryTable } from "./table.js";

/** Long-term memory rows in the shared SQLite database (convention 08). */
export const MEMORY_TABLE = "memorizer_items";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${MEMORY_TABLE} (
    id TEXT NOT NULL PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    scope TEXT NOT NULL,
    tenant_id TEXT,
    visibility TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    channel_type TEXT,
    platform TEXT,
    guild_id TEXT,
    channel_id TEXT,
    self_id TEXT,
    user_id TEXT,
    importance REAL NOT NULL,
    confidence REAL NOT NULL,
    tags TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    access_count INTEGER NOT NULL,
    forgotten_at INTEGER,
    embedding TEXT,
    embedding_model TEXT
  )`,
] as const;

/** Row field to column; `tags` and `embedding` hold JSON text. */
const COLUMNS = {
  id: "id",
  type: "type",
  content: "content",
  scope: "scope",
  tenantId: "tenant_id",
  visibility: "visibility",
  revision: "revision",
  channelType: "channel_type",
  platform: "platform",
  guildId: "guild_id",
  channelId: "channel_id",
  selfId: "self_id",
  userId: "user_id",
  importance: "importance",
  confidence: "confidence",
  tags: "tags",
  status: "status",
  createdAt: "created_at",
  updatedAt: "updated_at",
  lastAccessedAt: "last_accessed_at",
  accessCount: "access_count",
  forgottenAt: "forgotten_at",
  embedding: "embedding",
  embeddingModel: "embedding_model",
} as const satisfies Record<keyof MemoryRow, string>;

const FIELDS = Object.keys(COLUMNS) as Field[];
const SELECT = FIELDS.map((field) => (COLUMNS[field] === field ? field : `${COLUMNS[field]} AS ${field}`)).join(", ");

type Field = keyof MemoryRow;

type Stored = Record<string, string | number | null>;

/** The memory table; created on first use. Missing rows are left alone by `set` and `remove`. */
export function sqliteMemoryTable(): MemoryTable {
  let ready = false;
  const db = () => {
    if (!ready) {
      ensureTables("memorizer", DDL);
      ready = true;
    }
    return stateDb();
  };
  return {
    all: async () => (db().prepare(`SELECT ${SELECT} FROM ${MEMORY_TABLE} ORDER BY rowid`).all() as Stored[]).map(fromStored),
    byId: async (id) => {
      const stored = db().prepare(`SELECT ${SELECT} FROM ${MEMORY_TABLE} WHERE id = ?`).get(id) as Stored | undefined;
      return stored ? fromStored(stored) : undefined;
    },
    create: async (row) => {
      const columns = FIELDS.map((field) => COLUMNS[field]);
      db()
        .prepare(`INSERT INTO ${MEMORY_TABLE} (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`)
        .run(toStored(row));
    },
    set: async (id, patch: MemoryPatch) => {
      const fields = (Object.keys(patch) as Array<keyof MemoryPatch>).filter((field) => patch[field] !== undefined);
      if (fields.length === 0) return;
      const stored = toStored(patch as Partial<MemoryRow>);
      db()
        .prepare(`UPDATE ${MEMORY_TABLE} SET ${fields.map((field) => `${COLUMNS[field]} = :${COLUMNS[field]}`).join(", ")} WHERE id = :id`)
        .run({ ...Object.fromEntries(fields.map((field) => [COLUMNS[field], stored[COLUMNS[field]] ?? null])), id });
    },
    remove: async (id) => {
      db().prepare(`DELETE FROM ${MEMORY_TABLE} WHERE id = ?`).run(id);
    },
  };
}

function toStored(row: Partial<MemoryRow>): Stored {
  const stored: Stored = {};
  for (const field of FIELDS) {
    const value = row[field];
    stored[COLUMNS[field]] =
      value === undefined || value === null ? null : field === "tags" || field === "embedding" ? JSON.stringify(value) : (value as string | number);
  }
  return stored;
}

function fromStored(stored: Stored): MemoryRow {
  return {
    ...stored,
    tags: JSON.parse(String(stored.tags)) as string[],
    embedding: stored.embedding === null ? null : (JSON.parse(String(stored.embedding)) as number[]),
  } as unknown as MemoryRow;
}

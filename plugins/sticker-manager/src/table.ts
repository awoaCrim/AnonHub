import { ensureTables, stateDb } from "@yesimbot/foundation";

import type { StickerRowQuery, StickerTable } from "./store.js";
import type { StickerRow } from "./types.js";

/** Sticker rows in the shared SQLite database (convention 08). */
export const STICKER_TABLE = "sticker_manager_items";

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${STICKER_TABLE} (
    id TEXT NOT NULL PRIMARY KEY,
    content_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    category TEXT NOT NULL,
    tags TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    source TEXT NOT NULL,
    usage_count INTEGER NOT NULL,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sticker_manager_items_scope ON ${STICKER_TABLE} (scope_key, content_id)`,
] as const;

/** Row field to column; `tags` and `source` hold JSON text. */
const COLUMNS = {
  id: "id",
  contentId: "content_id",
  scopeKey: "scope_key",
  category: "category",
  tags: "tags",
  mime: "mime",
  size: "size",
  source: "source",
  usageCount: "usage_count",
  lastUsedAt: "last_used_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const satisfies Record<Field, string>;

const FIELDS = Object.keys(COLUMNS) as Field[];
const JSON_FIELDS: ReadonlySet<Field> = new Set(["tags", "source"]);
const SELECT = FIELDS.map((field) => (COLUMNS[field] === field ? field : `${COLUMNS[field]} AS ${field}`)).join(", ");

type Field = keyof StickerRow;

type Stored = Record<string, string | number | null>;

/** The sticker table; created on first use. */
export class SqliteStickerTable implements StickerTable {
  private ready = false;

  public async find(query: StickerRowQuery): Promise<StickerRow[]> {
    const { where, params } = filter(query);
    return (this.db().prepare(`SELECT ${SELECT} FROM ${STICKER_TABLE}${where} ORDER BY rowid`).all(params) as Stored[]).map(fromStored);
  }

  /** A second row with the same `id` throws. */
  public async insert(row: StickerRow): Promise<void> {
    const columns = FIELDS.map((field) => COLUMNS[field]);
    this.db()
      .prepare(`INSERT INTO ${STICKER_TABLE} (${columns.join(", ")}) VALUES (${columns.map((column) => `:${column}`).join(", ")})`)
      .run(toStored(row));
  }

  public async update(query: StickerRowQuery & { id?: string }, patch: Partial<StickerRow>): Promise<number> {
    const fields = (Object.keys(patch) as Field[]).filter((field) => patch[field] !== undefined);
    if (fields.length === 0) return (await this.find(query)).length;
    const { where, params } = filter(query);
    const stored = toStored(patch);
    const result = this.db()
      .prepare(`UPDATE ${STICKER_TABLE} SET ${fields.map((field) => `${COLUMNS[field]} = :set_${COLUMNS[field]}`).join(", ")}${where}`)
      .run({ ...Object.fromEntries(fields.map((field) => [`set_${COLUMNS[field]}`, stored[COLUMNS[field]] ?? null])), ...params });
    return Number(result.changes);
  }

  public async remove(query: StickerRowQuery): Promise<number> {
    const { where, params } = filter(query);
    return Number(this.db().prepare(`DELETE FROM ${STICKER_TABLE}${where}`).run(params).changes);
  }

  private db() {
    if (!this.ready) {
      ensureTables("sticker-manager", DDL);
      this.ready = true;
    }
    return stateDb();
  }
}

/** Equality on every given field; an empty query selects every row. */
function filter(query: StickerRowQuery & { id?: string }): { where: string; params: Record<string, string> } {
  const fields = (Object.keys(query) as Array<keyof typeof query>).filter((field) => query[field] !== undefined);
  return {
    where: fields.length ? ` WHERE ${fields.map((field) => `${COLUMNS[field]} = :${COLUMNS[field]}`).join(" AND ")}` : "",
    params: Object.fromEntries(fields.map((field) => [COLUMNS[field], query[field] as string])),
  };
}

function toStored(row: Partial<StickerRow>): Stored {
  const stored: Stored = {};
  for (const field of FIELDS) {
    const value = row[field];
    stored[COLUMNS[field]] = value === undefined || value === null ? null : JSON_FIELDS.has(field) ? JSON.stringify(value) : (value as string | number);
  }
  return stored;
}

function fromStored(stored: Stored): StickerRow {
  return {
    ...stored,
    tags: JSON.parse(String(stored.tags)) as string[],
    source: JSON.parse(String(stored.source)) as StickerRow["source"],
  } as unknown as StickerRow;
}

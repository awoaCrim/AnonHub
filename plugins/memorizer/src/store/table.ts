import type { MemoryRow } from "../types.js";

/** The changed columns of one memory row (the primary key never changes). */
export type MemoryPatch = { readonly [Key in keyof Omit<MemoryRow, "id">]?: Omit<MemoryRow, "id">[Key] | undefined };

/** The memory table as the store sees it; `sqliteMemoryTable` backs it. */
export interface MemoryTable {
  all(): Promise<MemoryRow[]>;
  byId(id: string): Promise<MemoryRow | undefined>;
  create(row: MemoryRow): Promise<void>;
  set(id: string, patch: MemoryPatch): Promise<void>;
  remove(id: string): Promise<void>;
}

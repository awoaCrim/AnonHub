import { systemClock } from "@yesimbot/foundation";

import { MemoryStore, type MemoryStoreOptions } from "../src/store/memory.js";
import type { MemoryTable } from "../src/store/table.js";
import type { MemoryRow } from "../src/types.js";

/** The row-store shape the tests' in-memory fakes expose: they keep plain rows and filter them by equality. */
export interface RowModel {
  get(table: string, query: Record<string, unknown>): Promise<unknown[]>;
  create?(table: string, row: Record<string, unknown>): Promise<unknown>;
  set?(table: string, query: Record<string, unknown>, patch: Record<string, unknown>): Promise<unknown>;
  remove?(table: string, query: Record<string, unknown>): Promise<unknown>;
}

const TABLE = "memory";

/** The tenant a test store belongs to unless the test names another. */
export const TEST_TENANT = "11111111-1111-4111-8111-111111111111";

/** A `MemoryTable` over a fake row store, so a test can inspect or seed the rows directly. */
export function fakeMemoryTable(model: RowModel): MemoryTable {
  return {
    all: async () => (await model.get(TABLE, {})) as MemoryRow[],
    byId: async (id) => ((await model.get(TABLE, { id })) as MemoryRow[])[0],
    create: async (row) => void (await model.create!(TABLE, { ...row })),
    set: async (id, patch) => void (await model.set!(TABLE, { id }, { ...patch })),
    remove: async (id) => void (await model.remove!(TABLE, { id })),
  };
}

/** A store on a fake row store (or, when given a table, on that table). */
export function memoryStore(model: unknown, options: Partial<MemoryStoreOptions> = {}): MemoryStore {
  return new MemoryStore(fakeMemoryTable(model as RowModel), { clock: systemClock(), tenantId: TEST_TENANT, ...options });
}

/** A store on the real SQLite table; the test configures a storage root first. */
export function sqliteStore(table: MemoryTable, options: Partial<MemoryStoreOptions> = {}): MemoryStore {
  return new MemoryStore(table, { clock: systemClock(), tenantId: TEST_TENANT, ...options });
}

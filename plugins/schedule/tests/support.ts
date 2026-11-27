import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDb, configureStorage } from "@yesimbot/foundation";

import type { ScheduleQuery, ScheduleTable } from "../src/store.js";
import { sqliteScheduleTable } from "../src/table.js";
import type { ScheduleRow } from "../src/types.js";

/**
 * The table as a plain object whose methods tests can spy on or wrap (the table itself is only an interface).
 * The first argument of each method names a table and is ignored: there is one.
 */
export interface ScheduleModel {
  get(table: string, query: ScheduleQuery): Promise<ScheduleRow[]>;
  create(table: string, row: ScheduleRow): Promise<void>;
  set(table: string, query: ScheduleQuery, patch: Partial<ScheduleRow>): Promise<void>;
  remove(table: string, query: ScheduleQuery): Promise<void>;
}

const roots: string[] = [];

/** A model on the real SQLite table, in a fresh storage root. Call `disposeScheduleModels` after each test. */
export async function scheduleModel(): Promise<ScheduleModel> {
  const root = await mkdtemp(join(tmpdir(), "schedule-table-"));
  roots.push(root);
  configureStorage({ dataRoot: root });
  const table = sqliteScheduleTable();
  return {
    get: (_table, query) => table.get(query),
    create: (_table, row) => table.create(row),
    set: (_table, query, patch) => table.set(query, patch),
    remove: (_table, query) => table.remove(query),
  };
}

export async function disposeScheduleModels(): Promise<void> {
  closeStateDb();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/** The table over a model's methods, looked up at each call so a spy or replacement on the model is seen. */
export function tableOf(model: ScheduleModel): ScheduleTable {
  return {
    get: (query) => model.get("schedule", query),
    create: (row) => model.create("schedule", row),
    set: (query, patch) => model.set("schedule", query, patch),
    remove: (query) => model.remove("schedule", query),
  };
}

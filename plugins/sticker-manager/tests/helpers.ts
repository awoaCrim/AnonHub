import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDb, configureStorage, systemClock } from "@yesimbot/foundation";
import { vi } from "vitest";

import type { StickerFileStore } from "../src/files.js";
import { StickerStore, type StickerTable } from "../src/store.js";
import { SqliteStickerTable } from "../src/table.js";

const roots: string[] = [];

/** Points the shared SQLite at a fresh directory; `disposeStickerStorage` closes and removes it. */
export async function useStickerStorage(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sticker-state-"));
  roots.push(root);
  configureStorage({ dataRoot: root });
}

export async function disposeStickerStorage(): Promise<void> {
  closeStateDb();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

/** The real SQLite table with every method a spy, so a test can count reads and writes or interleave one. */
export function createTableSpy() {
  const real = new SqliteStickerTable();
  const find = vi.fn<StickerTable["find"]>((query) => real.find(query));
  const insert = vi.fn<StickerTable["insert"]>((row) => real.insert(row));
  const update = vi.fn<StickerTable["update"]>((query, patch) => real.update(query, patch));
  const remove = vi.fn<StickerTable["remove"]>((query) => real.remove(query));
  return { find, insert, update, remove } satisfies StickerTable;
}

/** A store on a spied SQLite table; the test configures a storage root first (`useStickerStorage`). */
export function createStickerStore(table: StickerTable, files: StickerFileStore): StickerStore {
  return new StickerStore(table, files, systemClock());
}

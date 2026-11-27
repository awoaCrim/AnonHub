import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDb, configureStorage, stateDb } from "@yesimbot/foundation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MEMORY_TABLE, sqliteMemoryTable } from "../src/store/sqlite.js";
import type { MemoryRow } from "../src/types.js";

let root: string;

function row(id: string, overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id,
    type: "fact",
    content: `memory ${id}`,
    scope: "channel",
    tenantId: "11111111-1111-4111-8111-111111111111",
    visibility: "owner",
    revision: 1,
    channelType: "guild",
    platform: "onebot",
    guildId: "room",
    channelId: "room",
    selfId: "bot",
    userId: null,
    importance: 0.75,
    confidence: 0.5,
    tags: ["猫猫", "a,b"],
    status: "active",
    createdAt: 10,
    updatedAt: 11,
    lastAccessedAt: 12,
    accessCount: 3,
    forgottenAt: null,
    embedding: [0.25, -1, 0],
    embeddingModel: "embed",
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "memorizer-table-"));
  configureStorage({ dataRoot: root });
});

afterEach(async () => {
  closeStateDb();
  await rm(root, { recursive: true, force: true });
});

describe("sqliteMemoryTable", () => {
  it("round-trips a row, with tags, embedding and nulls as they were written", async () => {
    const table = sqliteMemoryTable();
    await table.create(row("a"));
    await table.create(row("b", { embedding: null, embeddingModel: null, tags: [], channelType: null, platform: null }));
    expect(await table.byId("a")).toEqual(row("a"));
    expect(await table.byId("b")).toEqual(row("b", { embedding: null, embeddingModel: null, tags: [], channelType: null, platform: null }));
    expect(await table.byId("missing")).toBeUndefined();
  });

  it("lists rows in insertion order, also after updates", async () => {
    const table = sqliteMemoryTable();
    for (const id of ["z", "a", "m"]) await table.create(row(id));
    await table.set("z", { content: "changed" });
    expect((await table.all()).map((value) => value.id)).toEqual(["z", "a", "m"]);
  });

  it("rejects a duplicate id", async () => {
    const table = sqliteMemoryTable();
    await table.create(row("a"));
    await expect(table.create(row("a"))).rejects.toThrow();
    expect(await table.all()).toHaveLength(1);
  });

  it("changes only the given columns; null clears and undefined is ignored; a missing row stays missing", async () => {
    const table = sqliteMemoryTable();
    await table.create(row("a"));
    await table.set("a", { status: "forgotten", forgottenAt: 99, embedding: null, tags: ["x"], content: undefined });
    expect(await table.byId("a")).toEqual(row("a", { status: "forgotten", forgottenAt: 99, embedding: null, tags: ["x"] }));
    await table.set("nobody", { content: "x" });
    await table.set("a", {});
    expect(await table.all()).toHaveLength(1);
  });

  it("removes one row and ignores a missing one", async () => {
    const table = sqliteMemoryTable();
    await table.create(row("a"));
    await table.create(row("b"));
    await table.remove("a");
    await table.remove("nobody");
    expect((await table.all()).map((value) => value.id)).toEqual(["b"]);
  });

  it("keeps rows across a reopened database", async () => {
    await sqliteMemoryTable().create(row("a"));
    closeStateDb();
    expect(await sqliteMemoryTable().byId("a")).toEqual(row("a"));
    expect(stateDb().prepare(`SELECT COUNT(*) AS n FROM ${MEMORY_TABLE}`).get()).toEqual({ n: 1 });
  });
});

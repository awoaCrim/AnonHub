import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteStickerTable } from "../src/table.js";
import type { StickerRow } from "../src/types.js";
import { disposeStickerStorage, useStickerStorage } from "./helpers.js";

function row(contentId: string, overrides: Partial<StickerRow> = {}): StickerRow {
  return {
    id: `global:${contentId}`,
    contentId,
    scopeKey: "global",
    category: "meme",
    tags: ["猫猫", "a,b"],
    mime: "image/png",
    size: 12,
    source: { kind: "steal", platform: "onebot", channelId: "room", userId: "u", messageId: "m" },
    usageCount: 2,
    lastUsedAt: "2026-01-02T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(useStickerStorage);
afterEach(disposeStickerStorage);

describe("SqliteStickerTable", () => {
  it("round-trips a row; empty tags and a null last use stay as they were", async () => {
    const table = new SqliteStickerTable();
    await table.insert(row("a"));
    const bare = row("b", { tags: [], lastUsedAt: null, source: { kind: "import" } });
    await table.insert(bare);
    expect(await table.find({ contentId: "a" })).toEqual([row("a")]);
    expect(await table.find({ contentId: "b" })).toEqual([bare]);
  });

  it("finds by equality on the given fields, in insertion order, and everything for an empty query", async () => {
    const table = new SqliteStickerTable();
    await table.insert(row("z"));
    await table.insert(row("a", { category: "other" }));
    await table.insert(row("m", { scopeKey: "group", id: "group:m" }));
    expect((await table.find({})).map((value) => value.contentId)).toEqual(["z", "a", "m"]);
    expect((await table.find({ scopeKey: "global" })).map((value) => value.contentId)).toEqual(["z", "a"]);
    expect((await table.find({ scopeKey: "global", category: "other" })).map((value) => value.contentId)).toEqual(["a"]);
    expect(await table.find({ scopeKey: "global", contentId: "m" })).toEqual([]);
  });

  it("rejects a second row with the same id", async () => {
    const table = new SqliteStickerTable();
    await table.insert(row("a"));
    await expect(table.insert(row("a"))).rejects.toThrow();
    expect(await table.find({})).toHaveLength(1);
  });

  it("updates every matching row and returns how many matched; a miss returns 0", async () => {
    const table = new SqliteStickerTable();
    await table.insert(row("a"));
    await table.insert(row("b"));
    await table.insert(row("c", { scopeKey: "group", id: "group:c" }));
    expect(await table.update({ scopeKey: "global", category: "meme" }, { category: "new", updatedAt: "later" })).toBe(2);
    expect((await table.find({ scopeKey: "global" })).map((value) => [value.category, value.updatedAt])).toEqual([
      ["new", "later"],
      ["new", "later"],
    ]);
    expect((await table.find({ scopeKey: "group" }))[0]!.category).toBe("meme");
    expect(await table.update({ id: "global:a" }, { tags: ["x"], usageCount: 3, lastUsedAt: null })).toBe(1);
    expect((await table.find({ contentId: "a" }))[0]).toMatchObject({ tags: ["x"], usageCount: 3, lastUsedAt: null });
    expect(await table.update({ id: "nobody" }, { category: "x" })).toBe(0);
  });

  it("removes the matching rows and returns how many", async () => {
    const table = new SqliteStickerTable();
    await table.insert(row("a"));
    await table.insert(row("b", { category: "other" }));
    expect(await table.remove({ scopeKey: "global", category: "other" })).toBe(1);
    expect(await table.remove({ contentId: "nobody" })).toBe(0);
    expect((await table.find({})).map((value) => value.contentId)).toEqual(["a"]);
  });
});

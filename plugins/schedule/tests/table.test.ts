import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeStateDb, configureStorage } from "@yesimbot/foundation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sqliteScheduleTable } from "../src/table.js";
import type { ScheduleRow } from "../src/types.js";

let root: string;

function row(id: string, overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id,
    type: "direct",
    platform: "onebot",
    selfId: "bot",
    channelId: "private:1",
    userId: "1",
    title: `task ${id}`,
    prompt: "do it",
    notes: "how it went",
    purpose: "heartbeat",
    delivery: "silent",
    kind: "cron",
    at: null,
    cron: "*/30 * * * *",
    state: "enabled",
    nextRunAt: "2030-01-01T00:00:00.000Z",
    lastResult: { occurrenceAt: "2029-12-31T23:30:00.000Z", status: "completed", notified: true },
    runs: [
      {
        id: "run-1",
        scheduleId: id,
        occurrenceAt: "2029-12-31T23:30:00.000Z",
        recordedAt: "2029-12-31T23:30:01.000Z",
        status: "completed",
        purpose: "heartbeat",
        delivery: "silent",
        sequence: 1,
      },
    ],
    createdAt: "2029-01-01T00:00:00.000Z",
    updatedAt: "2029-01-02T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "schedule-table-"));
  configureStorage({ dataRoot: root });
});

afterEach(async () => {
  closeStateDb();
  await rm(root, { recursive: true, force: true });
});

describe("sqliteScheduleTable", () => {
  it("round-trips a row, JSON columns included, and reads nulls back as null", async () => {
    const table = sqliteScheduleTable();
    await table.create(row("a"));
    const bare = row("b", { type: "guild", userId: null, notes: null, kind: "once", at: "2030-01-01T00:00:00.000Z", cron: null, lastResult: null, runs: null });
    await table.create(bare);
    expect(await table.get({ id: "a" })).toEqual([row("a")]);
    expect(await table.get({ id: "b" })).toEqual([bare]);
    expect(await table.get({ id: "missing" })).toEqual([]);
  });

  it("fills the column defaults for a row without purpose or delivery", async () => {
    const table = sqliteScheduleTable();
    const { purpose: _purpose, delivery: _delivery, ...legacy } = row("a");
    await table.create(legacy as ScheduleRow);
    expect((await table.get({ id: "a" }))[0]).toMatchObject({ purpose: "task", delivery: "channel" });
  });

  it("selects by equality on every given field, in insertion order", async () => {
    const table = sqliteScheduleTable();
    await table.create(row("z"));
    await table.create(row("a", { channelId: "other" }));
    await table.create(row("m", { state: "paused" }));
    expect((await table.get({})).map((value) => value.id)).toEqual(["z", "a", "m"]);
    expect((await table.get({ type: "direct", platform: "onebot", selfId: "bot", channelId: "private:1" })).map((value) => value.id)).toEqual(["z", "m"]);
    expect((await table.get({ channelId: "private:1", state: "enabled" })).map((value) => value.id)).toEqual(["z"]);
  });

  it("rejects a duplicate id", async () => {
    const table = sqliteScheduleTable();
    await table.create(row("a"));
    await expect(table.create(row("a"))).rejects.toThrow();
  });

  it("changes the given columns of every matching row only; null clears; undefined is ignored", async () => {
    const table = sqliteScheduleTable();
    await table.create(row("a"));
    await table.create(row("b"));
    await table.set({ id: "a" }, { state: "paused", nextRunAt: null, lastResult: null, runs: [], title: undefined });
    expect((await table.get({ id: "a" }))[0]).toEqual(row("a", { state: "paused", nextRunAt: null, lastResult: null, runs: [] }));
    expect((await table.get({ id: "b" }))[0]).toEqual(row("b"));
    await table.set({ channelId: "private:1" }, { notes: "all" });
    expect((await table.get({})).map((value) => value.notes)).toEqual(["all", "all"]);
    await table.set({ id: "nobody" }, { notes: "x" });
    await table.set({ id: "a" }, {});
    expect(await table.get({})).toHaveLength(2);
  });

  it("removes the matching rows and ignores a missing one", async () => {
    const table = sqliteScheduleTable();
    await table.create(row("a"));
    await table.create(row("b"));
    await table.remove({ id: "a" });
    await table.remove({ id: "nobody" });
    expect((await table.get({})).map((value) => value.id)).toEqual(["b"]);
  });
});

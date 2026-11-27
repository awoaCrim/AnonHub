import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AppError,
  appendJsonl,
  closeStateDb,
  configureStorage,
  dataPath,
  ensureTables,
  ownerLock,
  readJson,
  readJsonl,
  serialize,
  stateDb,
  transaction,
} from "../src/index.js";

let root: string;
const shape = {
  parse: (value: unknown) => {
    if (!value || typeof value !== "object" || typeof (value as { name?: unknown }).name !== "string") throw new Error("expected { name }");
    return value as { name: string };
  },
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "foundation-storage-"));
  configureStorage({ dataRoot: root });
});

afterAll(async () => {
  closeStateDb();
  await rm(root, { recursive: true, force: true });
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof AppError ? error.code : String(error)),
  );

describe("dataPath", () => {
  it("puts each module under the data root and refuses escapes", () => {
    expect(dataPath("memory", "items", "a.json")).toBe(join(root, "memory", "items", "a.json"));
    expect(() => dataPath("Memory")).toThrow();
    expect(() => dataPath("memory", "..")).toThrow();
    expect(() => dataPath("memory", "a/b")).toThrow();
  });
});

describe("readJson", () => {
  it("returns undefined when missing and refuses other formats without touching the file", async () => {
    const path = join(root, "config.json");
    expect(await readJson(path, shape)).toBeUndefined();
    await writeFile(path, '{"name":"bot"}');
    expect(await readJson(path, shape)).toEqual({ name: "bot" });
    await writeFile(path, '{"version":1,"title":"old"}');
    expect(await code(readJson(path, shape))).toBe("data_invalid");
    await writeFile(path, "{broken");
    expect(await code(readJson(path, shape))).toBe("data_invalid");
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
});

describe("JSONL", () => {
  it("appends in order, skips an interrupted last line and removes it before the next append", async () => {
    const path = join(root, "log.jsonl");
    await Promise.all(Array.from({ length: 20 }, (_, index) => appendJsonl(path, { index })));
    expect((await readJsonl<{ index: number }>(path)).map((record) => record.index)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    const second = join(root, "crashed.jsonl");
    await writeFile(second, '{"a":1}\n{"a":2}\n{"a":');
    expect(await readJsonl(second)).toEqual([{ a: 1 }, { a: 2 }]);
    await appendJsonl(second, { a: 3 });
    expect(await readFile(second, "utf8")).toBe('{"a":1}\n{"a":2}\n{"a":3}\n');
    const third = join(root, "all-partial.jsonl");
    await writeFile(third, '{"a":');
    await appendJsonl(third, { a: 1 });
    expect(await readFile(third, "utf8")).toBe('{"a":1}\n');
  });

  it("treats a malformed complete line as data_invalid and refuses non-object records", async () => {
    const path = join(root, "bad.jsonl");
    await writeFile(path, '{"a":1}\nnot json\n');
    expect(await code(readJsonl(path))).toBe("data_invalid");
    expect(await code(appendJsonl(join(root, "x.jsonl"), [1] as unknown as object))).toBe("input_invalid");
    expect(await readJsonl(join(root, "missing.jsonl"))).toEqual([]);
    await appendFile(path, "");
  });
});

describe("stateDb", () => {
  it("is one WAL database where each module creates only its own prefixed tables", () => {
    const db = stateDb();
    expect(stateDb()).toBe(db);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    ensureTables("sticker-manager", [
      "CREATE TABLE IF NOT EXISTS sticker_manager_items (id TEXT PRIMARY KEY, label TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS sticker_manager_items_label ON sticker_manager_items (label)",
    ]);
    ensureTables("sticker-manager", ["CREATE TABLE IF NOT EXISTS sticker_manager_items (id TEXT PRIMARY KEY, label TEXT NOT NULL)"]);
    expect(() => ensureTables("memory", ["CREATE TABLE IF NOT EXISTS sticker_manager_other (id TEXT)"])).toThrow(/memory_/);
    expect(() => ensureTables("memory", ["CREATE TABLE memory_items (id TEXT)"])).toThrow(/IF NOT EXISTS/);
    expect(() => ensureTables("memory", ["DROP TABLE sticker_manager_items"])).toThrow();
    expect(() => ensureTables("memory", ["CREATE TABLE IF NOT EXISTS memory_a (id TEXT); DROP TABLE sticker_manager_items"])).toThrow(/one statement/);
    expect(() => ensureTables("memory", ["CREATE INDEX IF NOT EXISTS memory_label ON sticker_manager_items (label)"])).toThrow();
    transaction(db, () => db.prepare("INSERT INTO sticker_manager_items VALUES (?, ?)").run("1", "猫"));
    expect(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO sticker_manager_items VALUES (?, ?)").run("2", "狗");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(db.prepare("SELECT count(*) AS n FROM sticker_manager_items").get()).toEqual({ n: 1 });
  });

  it("accepts the same data root again while open, but not another one", () => {
    const db = stateDb();
    configureStorage({ dataRoot: root });
    expect(stateDb()).toBe(db);
    expect(() => configureStorage({ dataRoot: join(root, "elsewhere") })).toThrow("storage already in use");
    expect(dataPath("memory")).toBe(join(root, "memory"));
  });
});

describe("serialize and ownerLock", () => {
  it("runs one key at a time and survives a failing task", async () => {
    const order: number[] = [];
    const tasks = [3, 1, 2].map((delay, index) =>
      serialize("k", async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(index);
        if (index === 1) throw new Error("x");
        return index;
      }).catch(() => -1),
    );
    expect(await Promise.all(tasks)).toEqual([0, -1, 2]);
    expect(order).toEqual([0, 1, 2]);
  });

  it("holds the lock against a second owner, reclaims a dead owner's lock and refuses an unreadable one", async () => {
    const dir = join(root, "account");
    const lock = await ownerLock(dir);
    expect(await code(ownerLock(dir))).toBe("lock_held");
    await lock.release();
    await lock.release();
    const again = await ownerLock(dir);
    await again.release();
    await writeFile(join(dir, "owner.lock"), JSON.stringify({ pid: 2147483646 }));
    const reclaimed = await ownerLock(dir);
    expect(JSON.parse(await readFile(join(dir, "owner.lock"), "utf8")).pid).toBe(process.pid);
    await reclaimed.release();
    await writeFile(join(dir, "owner.lock"), "garbage");
    expect(await code(ownerLock(dir))).toBe("lock_held");
  });
});

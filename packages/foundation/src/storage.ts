import type { BigIntStats } from "node:fs";
import { appendFile, chmod, lstat, mkdir, open, readFile, stat, truncate, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { AppError } from "./errors.js";

const OWNER = /^[a-z][a-z0-9-]*$/;
const PART = /^[^/\\\0]+$/;
const MAX_JSON_BYTES = 1024 * 1024;
const BOOT_IDENTITY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/;
const queues = new Map<string, Promise<unknown>>();
const checkedJsonl = new Set<string>();
let dataRoot: string | undefined;
let database: DatabaseSync | undefined;

/** Anything with zod's `parse`: the one format a data file may have. */
export interface Parser<T> {
  parse(value: unknown): T;
}

export interface OwnerLock {
  release(): Promise<void>;
}

/**
 * The data root; the host sets it at startup. Nothing falls back to the working directory. Setting the same root again is
 * fine (a host reloading in-process); another root while the database is open is refused.
 */
export function configureStorage(options: { dataRoot: string }): void {
  if (database && options.dataRoot !== dataRoot) throw new Error("storage already in use");
  dataRoot = options.dataRoot;
}

/** Where a module keeps its data: `<data root>/<owner>/<parts…>`. */
export function dataPath(owner: string, ...parts: string[]): string {
  if (!dataRoot) throw new Error("storage not configured");
  if (!OWNER.test(owner)) throw new Error(`data owner must be lowercase: ${owner}`);
  for (const part of parts) if (!PART.test(part) || part === "." || part === "..") throw new Error(`invalid data path part: ${part}`);
  return join(dataRoot, owner, ...parts);
}

/**
 * Reads a JSON data file in its one current format. Missing: undefined. Unreadable or in another format: `data_invalid`,
 * and the file is left as it is (no silent reset).
 */
export async function readJson<T>(path: string, schema: Parser<T>): Promise<T | undefined> {
  let text: string;
  try {
    const info = await stat(path);
    if (info.size > MAX_JSON_BYTES) throw new AppError("data_invalid", { effect: "none", detail: `${path}: larger than ${MAX_JSON_BYTES} bytes` });
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new AppError("data_invalid", { effect: "none", detail: `${path}: not JSON`, cause: error });
  }
  try {
    return schema.parse(value);
  } catch (error) {
    throw new AppError("data_invalid", { effect: "none", detail: `${path}: unexpected format`, cause: error });
  }
}

/**
 * Appends one record as a JSON line. Writers for one path queue up. A line without its newline is an interrupted
 * write: readers skip it and the next append removes it first.
 */
export async function appendJsonl(path: string, record: object): Promise<void> {
  const line = JSON.stringify(record);
  if (typeof line !== "string" || !line.startsWith("{")) throw new AppError("input_invalid", { effect: "none", detail: "a JSONL record is an object" });
  await serialize(`jsonl:${path}`, async () => {
    if (!checkedJsonl.has(path)) {
      await dropPartialLine(path);
      checkedJsonl.add(path);
    }
    await appendFile(path, line + "\n", { mode: 0o600 });
  });
}

/** All complete records of a JSONL file; a malformed complete line is `data_invalid`. */
export async function readJsonl<T>(path: string, schema?: Parser<T>): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const end = text.lastIndexOf("\n");
  const records: T[] = [];
  let number = 0;
  for (const line of end < 0 ? [] : text.slice(0, end).split("\n")) {
    number++;
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      records.push(schema ? schema.parse(value) : (value as T));
    } catch (error) {
      throw new AppError("data_invalid", { effect: "none", detail: `${path}:${number}`, cause: error });
    }
  }
  return records;
}

/** The one SQLite database (`<data root>/state.sqlite`), WAL, shared by all modules. */
export function stateDb(): DatabaseSync {
  if (database) return database;
  if (!dataRoot) throw new Error("storage not configured");
  const path = join(dataRoot, "state.sqlite");
  // Loaded on first use: importing node:sqlite prints an experimental-feature warning on Node 22.
  const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite");
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  } catch (error) {
    db.close();
    throw error;
  }
  if (process.platform !== "win32") void chmod(path, 0o600).catch(() => undefined);
  database = db;
  return db;
}

export function closeStateDb(): void {
  database?.close();
  database = undefined;
}

/**
 * Creates a module's tables and indexes if missing. Every name starts with the owner (`memory` → `memory_items`); only
 * `CREATE TABLE/INDEX IF NOT EXISTS` statements are accepted, one per string. Layout changes are one-time scripts.
 */
export function ensureTables(owner: string, ddl: readonly string[]): void {
  if (!OWNER.test(owner)) throw new Error(`table owner must be lowercase: ${owner}`);
  const prefix = owner.replace(/-/g, "_") + "_";
  for (const statement of ddl) {
    const body = statement.trim().replace(/;\s*$/, "");
    if (body.includes(";")) throw new Error("one statement per DDL string");
    const table = /^CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+"?(\w+)"?/i.exec(body);
    const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"?(\w+)"?\s+ON\s+"?(\w+)"?/i.exec(body);
    const names = table ? [table[1]!] : index ? [index[1]!, index[2]!] : undefined;
    if (!names) throw new Error(`only CREATE TABLE/INDEX IF NOT EXISTS: ${body.slice(0, 60)}`);
    for (const name of names) if (!name.startsWith(prefix)) throw new Error(`table and index names start with ${prefix}: ${name}`);
  }
  const db = stateDb();
  transaction(db, () => {
    for (const statement of ddl) db.exec(statement);
  });
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Runs `fn` after every earlier `fn` with the same key has settled; one writer per key inside this process. */
export async function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/**
 * Takes `<dir>/owner.lock` for this process, across processes. A lock left by a dead process (by PID, and on Linux by
 * boot ID and process start time) is reclaimed; a live owner is `lock_held`. Based on the Xiaoheihe account store.
 */
export async function ownerLock(dir: string): Promise<OwnerLock> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "owner.lock");
  const handle = await acquire(dir, path);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, identity: await processIdentity(process.pid) }));
  } catch (error) {
    await removeMatchingLock(path, handle);
    await handle.close();
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await removeMatchingLock(path, handle);
      await handle.close();
    },
  };
}

async function acquire(dir: string, path: string): Promise<FileHandle> {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Reclaimers serialize through a second exclusive file. A crashed reclaim fails closed.
  const recoveryPath = join(dir, "owner.recovery.lock");
  let recovery: FileHandle;
  try {
    recovery = await open(recoveryPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AppError("lock_held", { effect: "none", detail: recoveryPath, cause: error });
    throw error;
  }
  try {
    let previous: FileHandle;
    try {
      previous = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return await open(path, "wx", 0o600);
      throw error;
    }
    try {
      const before = await previous.stat({ bigint: true });
      const owner = parseOwner(await previous.readFile("utf8"));
      if (!owner) throw new AppError("lock_held", { effect: "none", detail: `${path}: unreadable owner` });
      let dead = false;
      try {
        process.kill(owner.pid, 0);
        const identity = owner.identity && (await processIdentity(owner.pid));
        dead = !!identity && identity !== owner.identity;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") dead = true;
      }
      if (!dead) throw new AppError("lock_held", { effect: "none", detail: path });
      const after = await previous.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        throw new AppError("lock_held", { effect: "none", detail: `${path}: changed during reclaim` });
      await removeMatchingLock(path, previous, before);
      return await open(path, "wx", 0o600);
    } finally {
      await previous.close();
    }
  } finally {
    await removeMatchingLock(recoveryPath, recovery);
    await recovery.close();
  }
}

function parseOwner(text: string): { pid: number; identity?: string } | undefined {
  try {
    const value = JSON.parse(text) as { pid?: unknown; identity?: unknown };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || (value.pid as number) > 2147483647) return undefined;
    if (value.identity !== undefined && (typeof value.identity !== "string" || !BOOT_IDENTITY.test(value.identity))) return undefined;
    return { pid: value.pid as number, ...(value.identity ? { identity: value.identity as string } : {}) };
  } catch {
    return undefined;
  }
}

async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return;
  try {
    const [boot, stat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    if (BOOT_IDENTITY.test(`${boot.trim()}:${start}`)) return `${boot.trim()}:${start}`;
  } catch {
    // PID-only liveness applies when Linux process identity cannot be read.
  }
}

async function removeMatchingLock(path: string, handle: FileHandle, expected?: BigIntStats): Promise<void> {
  const owned = expected ?? (await handle.stat({ bigint: true }));
  try {
    const current = await lstat(path, { bigint: true });
    if (
      current.isFile() &&
      current.dev === owned.dev &&
      current.ino === owned.ino &&
      current.size === owned.size &&
      current.mtimeNs === owned.mtimeNs &&
      current.ctimeNs === owned.ctimeNs
    )
      await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function dropPartialLine(path: string): Promise<void> {
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let keep: number | undefined;
  try {
    const { size } = await file.stat();
    if (size === 0) return;
    const chunk = Buffer.alloc(64 * 1024);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const { bytesRead } = await file.read(chunk, 0, end - start, start);
      const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) {
        keep = start + newline + 1;
        break;
      }
      end = start;
    }
    if (keep === size) return;
    keep ??= 0;
  } finally {
    await file.close();
  }
  if (keep !== undefined) await truncate(path, keep);
}

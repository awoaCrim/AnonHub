import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { AppError } from "./errors.js";
import { contentHash, newId } from "./ids.js";

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const queues = new Map<string, Promise<unknown>>();
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type WriteExpectation = Uint8Array | { readonly sha256: string } | "absent";

export interface WriteFileOptions {
  /** Mode of the written file, exactly (not reduced by the umask; the old file's mode is not kept); default 0600. */
  readonly mode?: number;
  /** Fsync the file and its directory; default true. */
  readonly durable?: boolean;
  /** What the file must hold right before the write; otherwise `file_changed`. */
  readonly expect?: WriteExpectation;
  readonly signal?: AbortSignal;
}

export interface ResolveInsideOptions {
  /** `reject`: no component may be a symbolic link. `within`: links are followed but must stay inside the root. */
  readonly links: "reject" | "within";
  /** The final components may not exist yet. */
  readonly allowMissing?: boolean;
  /** Refuse a file with more than one hard link. */
  readonly rejectHardlinks?: boolean;
}

/**
 * Replaces a file in one step: a private temporary file in the same directory, fsynced, renamed over the target, then
 * the directory fsynced. With `expect`, the current content is checked under the file's lock first.
 */
export async function writeFileAtomic(path: string, data: Uint8Array | string, options: WriteFileOptions = {}): Promise<void> {
  const target = resolve(path);
  await withPathLock(target, async () => {
    options.signal?.throwIfAborted();
    if (options.expect !== undefined) await checkExpectation(target, options.expect);
    const temporary = join(dirname(target), `.${basename(target)}.${newId()}.tmp`);
    const mode = options.mode ?? 0o600;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, mode);
    try {
      try {
        // Exactly `mode`, whatever the umask took away (Windows keeps only a read-only flag).
        if (process.platform !== "win32") await file.chmod(mode);
        await file.writeFile(data);
        if (options.durable !== false) await file.sync();
      } finally {
        await file.close();
      }
      options.signal?.throwIfAborted();
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    if (options.durable !== false) await syncDirectory(dirname(target));
  });
}

/** `writeFileAtomic` of pretty-printed JSON with a trailing newline. */
export async function writeJsonAtomic(path: string, value: unknown, options: WriteFileOptions = {}): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new AppError("input_invalid", { effect: "none", detail: "value has no JSON form" });
  await writeFileAtomic(path, text + "\n", options);
}

/**
 * Runs `fn` while holding the one in-process lock of a path. The key is the real path (the parent's real path for a
 * missing file), so two spellings of one file share a lock. Re-entrant inside the same async flow.
 */
export async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await lockKey(path);
  const current = held.getStore();
  if (current?.has(key)) return await fn();
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  queues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await held.run(new Set([...(current ?? []), key]), fn);
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/**
 * Builds a directory in a staging sibling, then swaps it into place. A failure leaves the old directory as it was.
 * The swap is two renames, so a crash between them can leave only the `.old` sibling; the next publish clears it.
 */
export async function publishDirectory(target: string, fill: (staging: string) => Promise<void>): Promise<void> {
  const destination = resolve(target);
  await withPathLock(destination, async () => {
    const id = newId();
    const staging = join(dirname(destination), `.${basename(destination)}.${id}.staging`);
    const old = join(dirname(destination), `.${basename(destination)}.${id}.old`);
    await mkdir(staging, { mode: 0o700 });
    try {
      await fill(staging);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    let moved = false;
    try {
      await rename(destination, old);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (moved) await rename(old, destination);
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await syncDirectory(dirname(destination));
    if (moved) await rm(old, { recursive: true, force: true });
  });
}

/**
 * Builds a new directory in a staging sibling and moves it into place; it never replaces a directory that already has
 * content (that fails, and the staging copy is removed). Readers never see it half filled.
 */
export async function createDirectory(target: string, fill: (staging: string) => Promise<void>): Promise<void> {
  const destination = resolve(target);
  await withPathLock(destination, async () => {
    const staging = join(dirname(destination), `.${basename(destination)}.${newId()}.staging`);
    await mkdir(staging, { mode: 0o700 });
    try {
      await fill(staging);
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    await syncDirectory(dirname(destination));
  });
}

/** Number of paths with a lock held or waited for; for tests. */
export function pendingPathLocks(): number {
  return queues.size;
}

/** Lexical containment: `path` is `root` or below it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolves a path given by a user, a model or a web page against `root` and proves it stays inside, component by
 * component on disk. Returns the real path.
 */
export async function resolveInside(root: string, input: string, options: ResolveInsideOptions): Promise<string> {
  if (input.includes("\0")) throw new AppError("path_outside_root", { effect: "none" });
  const realRoot = await realpath(root);
  // An absolute input spelled through the root as given (not its real path) is rebased onto the real root.
  const base = resolve(root);
  const lexical = resolve(realRoot, isAbsolute(input) && isInside(base, input) ? relative(base, input) : input);
  if (!isInside(realRoot, lexical)) throw new AppError("path_outside_root", { effect: "none" });
  let current = realRoot;
  const parts = relative(realRoot, lexical).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const next = join(current, parts[index]!);
    let info;
    try {
      info = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!options.allowMissing) throw new AppError("path_missing", { effect: "none", cause: error });
      return join(next, ...parts.slice(index + 1));
    }
    if (info.isSymbolicLink()) {
      if (options.links === "reject") throw new AppError("path_is_link", { effect: "none" });
      let target: string;
      try {
        target = await realpath(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new AppError("path_missing", { effect: "none", cause: error });
      }
      if (!isInside(realRoot, target)) throw new AppError("path_outside_root", { effect: "none" });
      current = target;
    } else current = next;
  }
  if (options.rejectHardlinks) {
    const info = await stat(current);
    if (info.isFile() && info.nlink > 1) throw new AppError("path_hardlinked", { effect: "none" });
  }
  return current;
}

/**
 * Reads a regular file without following a final symbolic link, refusing it above `maxBytes`. With `mode0600`, the
 * file must belong to this user and be closed to group and others.
 */
export async function readPrivateFile(path: string, options: { maxBytes: number; mode0600?: boolean }): Promise<Buffer> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new AppError("path_is_link", { effect: "none", cause: error });
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new AppError("path_missing", { effect: "none", detail: "not a regular file" });
    if (options.mode0600 && process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      throw new AppError("file_not_private", { effect: "none" });
    if (info.size > options.maxBytes) throw new AppError("file_too_large", { effect: "none" });
    const buffer = Buffer.alloc(Math.min(info.size, options.maxBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > options.maxBytes) throw new AppError("file_too_large", { effect: "none" });
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function checkExpectation(path: string, expect: WriteExpectation): Promise<void> {
  let current: Buffer | undefined;
  try {
    current = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const matches =
    expect === "absent"
      ? current === undefined
      : current !== undefined && (expect instanceof Uint8Array ? Buffer.from(expect).equals(current) : contentHash(current) === expect.sha256.toLowerCase());
  if (!matches) throw new AppError("file_changed", { effect: "none" });
}

async function lockKey(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return join(await realpath(dirname(absolute)), basename(absolute));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return absolute;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

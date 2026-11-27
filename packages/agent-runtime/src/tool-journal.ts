import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { resolve, join } from "node:path";

import { errorFields, logger, systemClock, contentHash } from "@yesimbot/foundation";

const MAX_RESULT_BYTES = 128 * 1024;

const MAX_INTENT_BYTES = 1024;

// Share only in-flight operations across journal objects for the same scope in this process.
// Separate processes instead see the durable intent and conservatively return UNKNOWN.
const active = new Map<string, { fingerprint: string; done: Promise<unknown> }>();

/** Default time for callers that pass none; Core passes its own. */
const clock = systemClock();

const journalLog = logger("yesimbot.tool-journal");

export type ToolJournalDurability = "file-and-directory-sync" | "file-sync-only";

export type ToolJournalNoticeCode = "execution_unknown" | "call_conflict" | "completed_result_unavailable" | "journal_unavailable";

/** A journal belongs to exactly one durable conversation session or worker task. */
export interface ToolJournalCall {
  turnId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolJournal {
  /** File journals on Windows cannot fsync a parent directory through Node's read-only handle. */
  readonly durability?: ToolJournalDurability;
  execute(call: ToolJournalCall, execute: () => Promise<unknown>, options?: { signal?: AbortSignal; replayable?: boolean }): Promise<unknown>;
}

/** Deliberately distinct from an arbitrary tool's result shape; custom projections must not consume it. */
export class ToolJournalNotice {
  readonly automaticReplayBlocked = true;
  readonly executionStatus: "unknown" | "completed" | "not_started";
  readonly message: string;
  constructor(readonly code: ToolJournalNoticeCode) {
    this.executionStatus = code === "completed_result_unavailable" ? "completed" : code === "journal_unavailable" ? "not_started" : "unknown";
    this.message =
      code === "completed_result_unavailable"
        ? "This tool call already completed, but its result cannot be recovered. Do not repeat the operation; inspect the current state or request a fresh read if needed."
        : code === "journal_unavailable"
          ? "The tool was not started because its execution record could not be stored. Fix storage before attempting a new operation."
          : code === "call_conflict"
            ? "This tool-call identity was already used with different arguments or another tool. It was not executed again. Inspect the earlier operation before taking any action."
            : "The outcome of this tool call is unknown. It may already have changed external state and was not automatically repeated. Inspect the current state before deciding what to do; do not retry merely because the result is unknown.";
  }
}

/**
 * Durable at-most-once admission for one call identity, not semantic deduplication across turns.
 * Intent is fsynced before effects; completed results are fsynced before later reuse. Neither
 * record is pruned or cleared with chat history: deleting an intent would allow an old call
 * to execute again. Failed result persistence leaves later recovery conservative.
 * Windows uses file-only sync: records survive process interruption, but directory entries
 * (including an intent) are not guaranteed to survive power loss. The mode is recorded on disk.
 */
export function createFileToolJournal(directory: string): ToolJournal {
  const root = resolve(directory);
  const durability: ToolJournalDurability = process.platform === "win32" ? "file-sync-only" : "file-and-directory-sync";
  return {
    durability,
    async execute(call, execute, options = {}) {
      options.signal?.throwIfAborted();
      for (const id of [call.turnId, call.toolCallId, call.toolName]) {
        if (typeof id !== "string" || !id || id.length > 4096) throw new TypeError("Invalid tool journal identity");
      }
      const key = contentHash(JSON.stringify([call.turnId, call.toolCallId]));
      const fingerprint = contentHash(canonical({ tool: call.toolName, input: call.input }));
      const scopeKey = join(root, key);
      const pending = active.get(scopeKey);
      if (pending) return pending.fingerprint === fingerprint ? pending.done : new ToolJournalNotice("call_conflict");
      const done = run(root, key, fingerprint, execute, options, durability);
      active.set(scopeKey, { fingerprint, done });
      try {
        return await done;
      } finally {
        if (active.get(scopeKey)?.done === done) active.delete(scopeKey);
      }
    },
  };
}

async function run(
  root: string,
  key: string,
  fingerprint: string,
  execute: () => Promise<unknown>,
  options: { signal?: AbortSignal; replayable?: boolean },
  durability: ToolJournalDurability,
): Promise<unknown> {
  const intentPath = join(root, `${key}.intent.json`);
  const resultPath = join(root, `${key}.result.json`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return new ToolJournalNotice("journal_unavailable");
    options.signal?.throwIfAborted();
    try {
      await writeExclusive(intentPath, JSON.stringify({ version: 1, fingerprint, startedAt: clock.now(), durability }));
      await syncDirectory(root, durability);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return await recover(intentPath, resultPath, fingerprint, options.replayable !== false);
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    journalLog.warn("tool_journal.unavailable", { key, ...errorFields(error) });
    return new ToolJournalNotice("journal_unavailable");
  }

  // Cancellation after admission leaves a durable unknown record. Never remove that record.
  options.signal?.throwIfAborted();
  let result: unknown;
  try {
    result = await execute();
  } catch (error) {
    options.signal?.throwIfAborted();
    journalLog.warn("tool_journal.execution_unknown", { key, ...errorFields(error) });
    return new ToolJournalNotice("execution_unknown");
  }
  const serialized = options.replayable === false ? undefined : persistableResult(result);
  const record = JSON.stringify({
    version: 1,
    fingerprint,
    durability,
    status: "completed",
    ...(serialized === undefined ? { replayable: false } : { replayable: true, result: JSON.parse(serialized) }),
  });
  try {
    await writeExclusive(resultPath, record);
    await syncDirectory(root, durability);
  } catch {
    // The current caller still has the real completed result. A later recovery must remain
    // conservative if the durable result is absent/torn; never turn persistence failure into retry.
  }
  return result;
}

async function recover(intentPath: string, resultPath: string, fingerprint: string, replayable: boolean): Promise<unknown> {
  try {
    const intent = JSON.parse(await readBounded(intentPath, MAX_INTENT_BYTES));
    if (intent.version !== 1 || typeof intent.fingerprint !== "string") return new ToolJournalNotice("execution_unknown");
    if (intent.fingerprint !== fingerprint) return new ToolJournalNotice("call_conflict");
    const record = JSON.parse(await readBounded(resultPath, MAX_RESULT_BYTES + MAX_INTENT_BYTES));
    if (record.version !== 1 || record.fingerprint !== fingerprint || record.status !== "completed") return new ToolJournalNotice("execution_unknown");
    if (!replayable || record.replayable !== true || !Object.hasOwn(record, "result") || persistableResult(record.result) === undefined) {
      return new ToolJournalNotice("completed_result_unavailable");
    }
    return record.result;
  } catch {
    return new ToolJournalNotice("execution_unknown");
  }
}

async function writeExclusive(path: string, text: string) {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string, durability: ToolJournalDurability) {
  // libuv maps Windows fsync to FlushFileBuffers, which requires a writable handle; Node's
  // O_RDONLY directory handle does not provide that. Do not suppress other platforms' I/O
  // failures, or any record file fsync failure, as a supposed compatibility fallback.
  if (durability === "file-sync-only") return;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readBounded(path: string, maxBytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || stat.nlink !== 1) throw new Error("Invalid tool journal record");
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new Error("Oversized tool journal record");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

/** JSON model arguments: stable key order, no class instances, cycles, or non-JSON values. */
function canonical(value: unknown): string {
  const seen = new Set<object>();
  function visit(item: unknown): unknown {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item)) throw new TypeError("Tool arguments must be JSON values");
    seen.add(item);
    let output: unknown;
    if (Array.isArray(item)) output = item.map(visit);
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError("Tool arguments must be JSON values");
      output = Object.fromEntries(
        Object.keys(item)
          .sort()
          .filter((key) => (item as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, visit((item as Record<string, unknown>)[key])]),
      );
    }
    seen.delete(item);
    return output;
  }
  return JSON.stringify(visit(value));
}

function persistableResult(value: unknown): string | undefined {
  // Media/binary payloads are ephemeral. A completion-only record preserves at-most-once
  // semantics without adding a second durable media store or corrupting a custom projection.
  // Build bounded JSON directly: never invoke getters/toJSON or first stringify an unbounded
  // result. The live output is untouched, including values that cannot be durably replayed.
  const seen = new Set<object>();
  const chunks: string[] = [];
  let bytes = 0;
  function add(chunk: string) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_RESULT_BYTES) throw new Error("Tool result is too large to replay");
    chunks.push(chunk);
  }

  function visit(item: unknown, depth: number): void {
    if (typeof item === "string") {
      if (item.length > MAX_RESULT_BYTES || /data:(?:image|video|audio)\//i.test(item)) throw new Error("Ephemeral tool result");
      add(JSON.stringify(item));
      return;
    }
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      add(JSON.stringify(item));
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item) || depth >= 64) throw new Error("Tool result is not plain JSON");
    seen.add(item);
    if (Object.hasOwn(item, "toJSON")) throw new Error("Tool result has custom JSON serialization");
    if (Array.isArray(item)) {
      add("[");
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Tool result is not plain JSON");
        if (index > 0) add(",");
        visit(descriptor.value, depth + 1);
      }
      add("]");
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Tool result is not plain JSON");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const type = descriptors.type?.value;
      if (
        typeof type === "string" &&
        /^(?:image(?:-data|-url|_url)?|input_image|video(?:-data|-url|_url)?|input_video|audio(?:-data|-url|_url)?|input_audio|file(?:-data|-url)?|media)$/.test(
          type,
        )
      ) {
        throw new Error("Ephemeral tool result");
      }
      for (const name of ["mediaType", "mimeType", "contentType"]) {
        const mediaType = descriptors[name]?.value;
        if (typeof mediaType === "string" && /^(image|video|audio)\//i.test(mediaType)) throw new Error("Ephemeral tool result");
      }
      add("{");
      let fields = 0;
      for (const name of Object.keys(descriptors)) {
        const descriptor = descriptors[name]!;
        if (!descriptor.enumerable) continue;
        if (!Object.hasOwn(descriptor, "value")) throw new Error("Tool result is not plain JSON");
        if (descriptor.value === undefined) continue;
        if (fields++ > 0) add(",");
        if (name.length > MAX_RESULT_BYTES) throw new Error("Tool result is too large to replay");
        add(JSON.stringify(name));
        add(":");
        visit(descriptor.value, depth + 1);
      }
      add("}");
    }
    seen.delete(item);
  }
  try {
    visit(value, 0);
    return chunks.join("");
  } catch {
    return undefined;
  }
}

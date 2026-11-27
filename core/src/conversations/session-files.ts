import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE_LINES = 600;
/** A page that never meets a turn opener still ends at this many pages' worth of shown records. */
const PAGE_WITHOUT_OPENER = 5;
const LINE_BATCH = 64;
const READ_CHUNK_BYTES = 64 * 1024;
const CURSOR_VERSION = 1;
const SESSION_FILE = /^[0-9A-Za-zTZ_-]+\.jsonl$/;

export interface SessionFileInfo {
  readonly filename: string;
  readonly isActive: boolean;
  readonly size: number;
  readonly createdAt: string;
  readonly lastActivityAt: number;
}

/** What a channel's `channel.json` names, as the history views read it; they list whatever is on disk, so only the type, platform and time are required. */
export interface ChannelManifestSummary {
  readonly type: "channel" | "guild" | "direct";
  readonly platform: string;
  readonly channelId?: string;
  readonly guildId?: string;
  readonly userId?: string;
  readonly selfId?: string;
  readonly createdAt: string;
}

export interface JsonlLine {
  /** Byte offset of the line in the file. */
  readonly start: number;
  readonly text: string;
}

export interface SessionPageRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SessionPage<T> {
  readonly entries: T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

/** What a page reader needs of the caller: the shown items of one line, and whether that line opens a turn. */
export interface SessionPageProjection<T> {
  project(raw: unknown, line: JsonlLine): Promise<readonly T[]>;
  opensTurn(items: readonly T[], raw: unknown): boolean;
}

/** undefined when the manifest is missing or not one. `strict` throws on any other read failure. */
export async function readChannelManifestFile(filePath: string, strict = false): Promise<ChannelManifestSummary | undefined> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return undefined;
    const value = raw as Record<string, unknown>;
    if (value.type !== "channel" && value.type !== "guild" && value.type !== "direct") return undefined;
    if (typeof value.platform !== "string" || typeof value.createdAt !== "string") return undefined;
    const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
    return {
      type: value.type,
      platform: value.platform,
      channelId: text("channelId"),
      guildId: text("guildId"),
      userId: text("userId"),
      selfId: text("selfId"),
      createdAt: value.createdAt,
    };
  } catch (cause) {
    if (strict && (cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Channel manifest unavailable", { cause });
    return undefined;
  }
}

/** The session files of one channel, oldest first; the newest is the active one. `strict` throws on anything but a missing directory or file. */
export async function listSessionFiles(sessionsPath: string, strict = false): Promise<SessionFileInfo[]> {
  const filenames = (
    await readdir(sessionsPath).catch((cause: NodeJS.ErrnoException) => {
      if (strict && cause.code !== "ENOENT") throw new Error("Session index unavailable", { cause });
      return [];
    })
  )
    .filter((name) => SESSION_FILE.test(name))
    .sort();
  const sessions: SessionFileInfo[] = [];
  for (const filename of filenames) {
    try {
      const info = await stat(join(sessionsPath, filename));
      sessions.push({ filename, isActive: false, size: info.size, createdAt: basename(filename, ".jsonl"), lastActivityAt: info.mtimeMs });
    } catch (cause) {
      if (strict && (cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Session index unavailable", { cause });
    }
  }
  const active = sessions.at(-1);
  if (active) sessions[sessions.length - 1] = { ...active, isActive: true };
  return sessions;
}

/**
 * One page of a session file, newest first: at least `limit` shown items, extended back to the line that opened the
 * earliest turn, so a page never starts in the middle of a turn. Lines that show nothing do not count toward the page
 * size. The file is read backward in chunks, never whole.
 */
export async function readSessionPage<T>(filePath: string, request: SessionPageRequest, projection: SessionPageProjection<T>): Promise<SessionPage<T>> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("Session file not found");
  const limit = normalizePageSize(request.limit);
  let end = decodeCursor(request.cursor, info.size);
  const pages: T[][] = [];
  let shown = 0,
    read = 0,
    done = false;
  while (!done && end > 0) {
    const lines = await readBackwardJsonlLines(filePath, end, LINE_BATCH);
    if (!lines.length) {
      end = 0;
      break;
    }
    for (const line of lines) {
      let raw: unknown;
      try {
        raw = JSON.parse(line.text) as unknown;
      } catch {
        raw = undefined;
      }
      const items = raw === undefined ? [] : await projection.project(raw, line);
      pages.push([...items]);
      shown += items.length;
      read += 1;
      end = line.start;
      if ((shown >= limit && projection.opensTurn(items, raw)) || shown >= limit * PAGE_WITHOUT_OPENER || read >= MAX_PAGE_LINES) {
        done = true;
        break;
      }
    }
  }
  const hasMore = end > 0;
  return { entries: pages.reverse().flat(), hasMore, nextCursor: hasMore ? encodeCursor(end) : undefined };
}

/** The last `maxBytes` of a file as whole lines (a cut first line is dropped), oldest first. */
export async function readFileTailLines(filePath: string, size: number, maxBytes: number): Promise<string[]> {
  const start = Math.max(0, size - maxBytes);
  const handle = await open(filePath, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = text.split("\n");
  if (start > 0) lines.shift();
  return lines;
}

async function readBackwardJsonlLines(filePath: string, endOffset: number, maxLines: number): Promise<JsonlLine[]> {
  const handle = await open(filePath, "r");
  try {
    const lines: JsonlLine[] = [];
    let scanEnd = endOffset;
    let buffer = Buffer.alloc(0);

    while (scanEnd > 0 && lines.length < maxLines) {
      const start = Math.max(0, scanEnd - READ_CHUNK_BYTES);
      const chunk = Buffer.alloc(scanEnd - start);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
      if (!bytesRead) break;
      buffer = Buffer.concat([chunk.subarray(0, bytesRead), buffer]);

      let cursor = buffer.length;
      while (lines.length < maxLines) {
        while (cursor > 0 && buffer[cursor - 1] === 0x0a) cursor -= 1;
        if (cursor === 0) break;

        const lineEnd = cursor;
        const delimiter = buffer.lastIndexOf(0x0a, lineEnd - 1);
        if (delimiter < 0) {
          if (start === 0 && !isBlank(buffer.subarray(0, lineEnd))) {
            lines.push({ start, text: buffer.subarray(0, lineEnd).toString("utf8") });
            cursor = 0;
          }
          break;
        }

        const lineStart = delimiter + 1;
        const line = buffer.subarray(lineStart, lineEnd);
        if (!isBlank(line)) lines.push({ start: start + lineStart, text: line.toString("utf8") });
        cursor = delimiter;
      }

      if (lines.length >= maxLines) break;
      buffer = buffer.subarray(0, cursor);
      scanEnd = start;
    }

    return lines;
  } finally {
    await handle.close();
  }
}

function isBlank(line: Uint8Array): boolean {
  return Buffer.from(line).toString("utf8").trim().length === 0;
}

function normalizePageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid conversation limit");
  return Math.min(value, MAX_PAGE_SIZE);
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ version: CURSOR_VERSION, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, fileSize: number): number {
  if (cursor === undefined) return fileSize;
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512) throw new Error("Invalid conversation cursor");
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { version?: unknown; offset?: unknown } | null;
    const offset = payload?.offset;
    if (payload?.version !== CURSOR_VERSION || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > fileSize)
      throw new Error("Invalid conversation cursor");
    return offset;
  } catch {
    throw new Error("Invalid conversation cursor");
  }
}

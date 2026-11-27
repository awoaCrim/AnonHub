import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { AppError, contentHash, resolveInside, writeFileAtomic } from "@yesimbot/foundation";

import type { AdminAuth } from "../admin-auth.js";
import type { Host, HttpContext } from "../host.js";
import type { FileEntry, FileListing, FileStat, UploadResult } from "../shared/files.js";
import { authorizeOwner } from "./plugins.js";

/** Uploaded files land here, relative to the Koishi base directory that plugin paths resolve against. */
export const UPLOAD_ROOT = "data/yesimbot/uploads";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const MAX_ENTRIES = 500;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

class FileError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(code, options);
  }
}

/**
 * Owner-only file access for `Schema.path` fields: browse and stat inside the base directory,
 * preview images, and upload new files (e.g. PNG character cards) under {@link UPLOAD_ROOT}.
 */
export function installFiles(ctx: Host, auth: AdminAuth) {
  const base = resolve(ctx.baseDir);

  /** Resolves a config-style path (relative to the base dir) and refuses anything outside it. */
  async function locate(input: string): Promise<{ absolute: string; path: string }> {
    const absolute = resolve(base, input || ".");
    if (!inside(base, absolute)) throw new FileError(403, "outside_base");
    // Existing targets must also stay inside after following links; missing ones are judged lexically.
    try {
      await resolveInside(base, absolute, { links: "within", allowMissing: true });
    } catch (error) {
      if (error instanceof AppError && error.code === "path_outside_root") throw new FileError(403, "outside_base", { cause: error });
      throw error;
    }
    return { absolute, path: display(base, absolute) };
  }

  const route = (method: "get" | "post", name: string, handler: (http: HttpContext) => Promise<void>) =>
    ctx.server[method](`/yesimbot/api/v1/files/${name}`, async (http) => {
      if (!authorizeOwner(http, auth, method === "post")) return;
      try {
        await handler(http);
      } catch (error) {
        http.set("Content-Type", "application/json");
        http.status = error instanceof FileError ? error.status : 500;
        http.body = { message: error instanceof FileError ? error.code : "file_error" };
      }
    });

  route("get", "list", async (http) => {
    const { absolute, path } = await locate(text(http.query.dir, true));
    let names: string[];
    try {
      names = await readdir(absolute);
    } catch {
      throw new FileError(404, "not_found");
    }
    const entries: FileEntry[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (entries.length >= MAX_ENTRIES) break;
      try {
        const info = await stat(join(absolute, name));
        entries.push({
          name,
          path: display(base, join(absolute, name)),
          type: info.isDirectory() ? "directory" : "file",
          size: info.isDirectory() ? 0 : info.size,
          mtime: info.mtimeMs,
        });
      } catch {
        // Broken links and unreadable entries are skipped.
      }
    }
    entries.sort((a, b) => (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1));
    const body: FileListing = {
      dir: path,
      parent: path === "." ? null : display(base, resolve(absolute, "..")),
      entries,
      truncated: names.length > entries.length,
    };
    http.body = body;
  });

  route("get", "stat", async (http) => {
    const raw = text(http.query.path);
    let body: FileStat;
    try {
      const { absolute, path } = await locate(raw);
      const info = await stat(absolute).catch(() => undefined);
      body = info ? { path, exists: true, type: info.isDirectory() ? "directory" : "file", size: info.size, mtime: info.mtimeMs } : { path, exists: false };
    } catch (error) {
      if (!(error instanceof FileError)) throw error;
      body = { path: raw, exists: false, outside: true };
    }
    http.body = body;
  });

  route("get", "preview", async (http) => {
    const { absolute } = await locate(text(http.query.path));
    const type = IMAGE_TYPES[extname(absolute).toLowerCase()];
    if (!type) throw new FileError(415, "not_image");
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isFile()) throw new FileError(404, "not_found");
    if (info.size > MAX_UPLOAD_BYTES) throw new FileError(413, "too_large");
    http.set("Content-Type", type);
    http.set("X-Content-Type-Options", "nosniff");
    http.body = await readFile(absolute);
  });

  route("post", "upload", async (http) => {
    if (http.get("content-type").split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") throw new FileError(415, "invalid_upload");
    const name = safeName(text(http.query.name));
    const scope = /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(http.query.scope ?? "")) ? String(http.query.scope) : "misc";
    const content = await readRaw(http, MAX_UPLOAD_BYTES);
    if (!content.length) throw new FileError(400, "empty_upload");
    const hash = contentHash(content, { hexLength: 16 }).slice(0, 10);
    const ext = extname(name);
    const file = `${basename(name, ext)}-${hash}${ext}`;
    const dir = join(base, UPLOAD_ROOT, scope);
    await mkdir(dir, { recursive: true });
    const target = join(dir, file);
    // Same content keeps the same name, so repeat uploads are idempotent.
    if (!(await stat(target).catch(() => undefined))) {
      await writeFileAtomic(target, content, { mode: 0o640 });
    }
    const body: UploadResult = { path: display(base, target), name: file, size: content.length };
    http.body = body;
  });
}

export function safeName(input: string): string {
  const name = basename(input.replace(/\\/g, "/"))
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  const ext = extname(name).slice(0, 12);
  const stem = basename(name, extname(name)).slice(0, 80) || "file";
  return stem + ext.toLowerCase();
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Paths are shown and stored the way plugin configs expect: relative to the base dir, `/`-separated. */
function display(base: string, absolute: string): string {
  return relative(base, absolute).split(sep).join("/") || ".";
}

function text(value: unknown, empty = false): string {
  if (value === undefined && empty) return "";
  if (typeof value !== "string" || (!empty && !value) || value.length > 1024 || [...value].some((char) => char.charCodeAt(0) < 32))
    throw new FileError(400, "invalid_path");
  return value;
}

async function readRaw(http: HttpContext, limit: number): Promise<Buffer> {
  const length = http.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new FileError(413, "too_large");
  const req = http.req;
  return new Promise<Buffer>((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        fail(new FileError(413, "too_large"));
      } else chunks.push(chunk);
    });
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", () => fail(new FileError(400, "invalid_upload")));
  });
}

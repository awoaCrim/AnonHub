import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { AppError, detectImageType, writeFileAtomic } from "@yesimbot/foundation";

import { STICKER_ERRORS } from "./errors.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);

export class StickerFileStore {
  public constructor(private readonly root: string) {}

  public get directory(): string {
    return this.root;
  }

  public async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  public async write(bytes: Uint8Array, contentId: string): Promise<void> {
    await this.ensure();
    if (await this.exists(contentId)) return;
    try {
      await writeFileAtomic(this.path(contentId), bytes, { expect: "absent" });
    } catch (cause) {
      // A concurrent writer of the same content wins; identical bytes need no second copy.
      if (await this.exists(contentId)) return;
      throw cause;
    }
  }

  public async read(contentId: string, maxBytes?: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (maxBytes === undefined) return new Uint8Array(await readFile(this.path(contentId), { signal }));
    signal?.throwIfAborted();
    const file = await open(this.path(contentId), "r");
    try {
      if ((await file.stat()).size > maxBytes) throw new AppError(STICKER_ERRORS.sticker_too_large, { effect: "none" });
      // Bound allocation and reading even if the file grows after stat.
      const bytes = new Uint8Array(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      signal?.throwIfAborted();
      if (length > maxBytes) throw new AppError(STICKER_ERRORS.sticker_too_large, { effect: "none" });
      return bytes.slice(0, length);
    } finally {
      await file.close();
    }
  }

  public async exists(contentId: string): Promise<boolean> {
    try {
      await stat(this.path(contentId));
      return true;
    } catch {
      return false;
    }
  }

  public async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.root);
      return entries.filter((name) => !name.startsWith("."));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  }

  public async remove(contentId: string): Promise<void> {
    await rm(this.path(contentId), { force: true });
  }

  private path(contentId: string): string {
    return join(this.root, contentId);
  }
}

export function detectImageMediaType(bytes: Uint8Array): string | undefined {
  const known = detectImageType(bytes);
  if (known) return known;
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  if (startsWithAscii(bytes, "<?xml") || startsWithAscii(bytes, "<svg")) {
    return "image/svg+xml";
  }
  return undefined;
}

export function isSupportedImageFile(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return false;
  return IMAGE_EXTENSIONS.has(filename.slice(dot + 1).toLowerCase());
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

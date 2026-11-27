import { crc32, inflateRawSync } from "node:zlib";

/** A file name in a release package: flat, no directories, no leading dot. */
export const PACKAGE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Reads a release ZIP: flat entries only (stored or deflated, no encryption, no ZIP64), each name checked
 * before anything is written, sizes and CRCs verified. Anything else is refused rather than guessed.
 */
export function readFlatZip(zip: Buffer, limits: { maxEntries: number; maxTotalBytes: number }): ZipEntry[] {
  const end = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(end + 10),
    size = zip.readUInt32LE(end + 12),
    offset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("zip64_not_supported");
  if (count > limits.maxEntries) throw new Error("zip_too_many_entries");
  if (offset + size > end) throw new Error("invalid_zip");
  const entries: ZipEntry[] = [],
    names = new Set<string>();
  let cursor = offset,
    total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid_zip");
    const flags = zip.readUInt16LE(cursor + 8),
      method = zip.readUInt16LE(cursor + 10),
      crc = zip.readUInt32LE(cursor + 16),
      compressed = zip.readUInt32LE(cursor + 20),
      uncompressed = zip.readUInt32LE(cursor + 24),
      nameLength = zip.readUInt16LE(cursor + 28),
      extraLength = zip.readUInt16LE(cursor + 30),
      commentLength = zip.readUInt16LE(cursor + 32),
      local = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw new Error("zip_encrypted");
    if (method !== 0 && method !== 8) throw new Error("zip_method_not_supported");
    if (!PACKAGE_FILE_NAME.test(name) || name.length > 128) throw new Error("zip_unsafe_name");
    if (names.has(name.toLowerCase())) throw new Error("zip_duplicate_name");
    names.add(name.toLowerCase());
    total += uncompressed;
    if (total > limits.maxTotalBytes) throw new Error("zip_too_large");
    if (local + 30 > offset || zip.readUInt32LE(local) !== 0x04034b50) throw new Error("invalid_zip");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + compressed > offset) throw new Error("invalid_zip");
    const raw = zip.subarray(start, start + compressed);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(uncompressed, 1) });
    if (data.length !== uncompressed || crc32(data) !== crc) throw new Error("zip_corrupt_entry");
    entries.push({ name, data });
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record is 22 bytes plus a comment of at most 65535 bytes.
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 22 - 0xffff); index--) {
    if (zip.readUInt32LE(index) === 0x06054b50) return index;
  }
  throw new Error("invalid_zip");
}

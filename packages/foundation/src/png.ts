import { crc32 } from "node:zlib";

import { AppError } from "./errors.js";
import { detectImageType, PNG_SIGNATURE } from "./media.js";

const CHUNK_TYPE = /^[A-Za-z]{4}$/;

export interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
}

/**
 * Splits a PNG into its chunks, from the signature up to and including IEND; anything after IEND is ignored. A
 * missing IEND, a truncated chunk or (with `verifyCrc`) a bad checksum is `png_invalid`.
 */
export function readPngChunks(bytes: Uint8Array, options: { verifyCrc?: boolean } = {}): PngChunk[] {
  if (detectImageType(bytes) !== "image/png") throw new AppError("png_invalid", { effect: "none", detail: "signature" });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!CHUNK_TYPE.test(type)) throw new AppError("png_invalid", { effect: "none", detail: "chunk type" });
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (options.verifyCrc && crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length))
      throw new AppError("png_invalid", { effect: "none", detail: `crc ${type}` });
    chunks.push({ type, data });
    if (type === "IEND") return chunks;
    offset = end;
  }
  throw new AppError("png_invalid", { effect: "none", detail: "no IEND" });
}

/** A PNG from chunks; the last one must be IEND. Lengths and checksums are computed here. */
export function encodePng(chunks: readonly PngChunk[]): Uint8Array {
  if (chunks.at(-1)?.type !== "IEND" || chunks.slice(0, -1).some((chunk) => chunk.type === "IEND"))
    throw new AppError("png_invalid", { effect: "none", detail: "IEND must be last" });
  const size = chunks.reduce((total, chunk) => total + 12 + chunk.data.length, PNG_SIGNATURE.length);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;
  for (const { type, data } of chunks) {
    if (!CHUNK_TYPE.test(type)) throw new AppError("png_invalid", { effect: "none", detail: "chunk type" });
    view.setUint32(offset, data.length);
    for (let index = 0; index < 4; index++) out[offset + 4 + index] = type.charCodeAt(index);
    out.set(data, offset + 8);
    view.setUint32(offset + 8 + data.length, crc32(out.subarray(offset + 4, offset + 8 + data.length)));
    offset += 12 + data.length;
  }
  return out;
}

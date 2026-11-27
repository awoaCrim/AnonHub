import { imageSize } from "image-size";

export const PNG_SIGNATURE: Uint8Array = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The image format named by the bytes themselves; the full 8-byte signature for PNG. */
export function detectImageType(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Width and height of a PNG, JPEG, GIF or WebP image; undefined for anything else or unreadable headers. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (!detectImageType(bytes)) return undefined;
  try {
    const { width, height } = imageSize(bytes);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return undefined;
    return { width, height };
  } catch {
    return undefined;
  }
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) if (bytes[index] !== prefix[index]) return false;
  return true;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return bytes.length < end ? "" : String.fromCharCode(...bytes.subarray(start, end));
}

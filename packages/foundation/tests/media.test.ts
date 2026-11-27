import { describe, expect, it } from "vitest";

import { AppError, detectImageType, encodePng, imageDimensions, readPngChunks } from "../src/index.js";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
const GIF_1X1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const WEBP_1X1 = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const JPEG_HEAD = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/wAARCAACAAMDASIAAhEBAxEB/9k=", "base64");

describe("detectImageType and imageDimensions", () => {
  it("names PNG, JPEG, GIF and WebP by their bytes", () => {
    expect(detectImageType(PNG_1X1)).toBe("image/png");
    expect(detectImageType(GIF_1X1)).toBe("image/gif");
    expect(detectImageType(WEBP_1X1)).toBe("image/webp");
    expect(detectImageType(JPEG_HEAD)).toBe("image/jpeg");
    expect(detectImageType(Buffer.from("\x89PNG\r\n\x1a"))).toBeUndefined();
    expect(detectImageType(Buffer.from("\x89PNG\r\n\x1b\n", "latin1"))).toBeUndefined();
    expect(detectImageType(Buffer.from("<svg"))).toBeUndefined();
  });

  it("reads dimensions only for those four types", () => {
    expect(imageDimensions(PNG_1X1)).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(GIF_1X1)).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(WEBP_1X1)).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(JPEG_HEAD)).toEqual({ width: 3, height: 2 });
    expect(imageDimensions(Buffer.from('<svg width="10" height="10"/>'))).toBeUndefined();
  });
});

describe("PNG chunks", () => {
  it("reads to IEND, ignores trailing bytes and round-trips", () => {
    const chunks = readPngChunks(Buffer.concat([PNG_1X1, Buffer.from("trailing junk")]), { verifyCrc: true });
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(Buffer.from(encodePng(chunks)).equals(PNG_1X1)).toBe(true);
    const text = { type: "tEXt", data: new TextEncoder().encode("ccv3\0e30=") };
    const withText = encodePng([chunks[0]!, text, ...chunks.slice(1)]);
    expect(readPngChunks(withText, { verifyCrc: true }).map((chunk) => chunk.type)).toEqual(["IHDR", "tEXt", "IDAT", "IEND"]);
  });

  it("refuses a wrong signature, truncation, a missing IEND and a bad checksum", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return "ok";
      } catch (error) {
        return error instanceof AppError ? `${error.code}:${error.detail}` : String(error);
      }
    };
    expect(code(() => readPngChunks(GIF_1X1))).toBe("png_invalid:signature");
    expect(code(() => readPngChunks(PNG_1X1.subarray(0, PNG_1X1.length - 12)))).toBe("png_invalid:no IEND");
    expect(code(() => readPngChunks(PNG_1X1.subarray(0, 40)))).toBe("png_invalid:no IEND");
    const corrupt = Buffer.from(PNG_1X1);
    corrupt[20] ^= 0xff;
    expect(code(() => readPngChunks(corrupt))).toBe("ok");
    expect(code(() => readPngChunks(corrupt, { verifyCrc: true }))).toBe("png_invalid:crc IHDR");
    expect(code(() => encodePng([{ type: "IHDR", data: new Uint8Array(13) }]))).toBe("png_invalid:IEND must be last");
  });
});

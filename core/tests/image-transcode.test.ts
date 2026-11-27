import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { stillImageToPng } from "../src/resources/image-transcode.js";

// The runtime image ships FFmpeg; machines without it skip these and the renderer reports undefined.
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;

function sized(png: Uint8Array) {
  const bytes = Buffer.from(png);
  return { png: bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("a still image as PNG", () => {
  it.skipIf(!HAS_FFMPEG)("draws a JPEG as a PNG within the longest side and keeps its proportions", async () => {
    const jpeg = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=1600x1200",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ]).stdout;
    const face = await stillImageToPng(jpeg, "image/jpeg", { maxSide: 1024, maxBytes: 1 << 24, timeoutMs: 20_000 });
    expect(face && sized(face)).toEqual({ png: true, width: 1024, height: 768 });
  });

  it.skipIf(!HAS_FFMPEG)("does not enlarge a small picture", async () => {
    const jpeg = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=300x200",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "pipe:1",
    ]).stdout;
    const face = await stillImageToPng(jpeg, "image/jpeg", { maxSide: 1024, maxBytes: 1 << 24, timeoutMs: 10_000 });
    expect(face && sized(face)).toEqual({ png: true, width: 300, height: 200 });
  });

  it("reports undefined instead of throwing for bytes FFmpeg cannot read or when FFmpeg is missing", async () => {
    await expect(stillImageToPng(new Uint8Array([1, 2, 3]), "image/jpeg", { maxSide: 1024, maxBytes: 1 << 24, timeoutMs: 20_000 })).resolves.toBeUndefined();
  });
});

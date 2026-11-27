import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const transcode = vi.hoisted(() => ({ firstFrameToPng: vi.fn<(...args: unknown[]) => Promise<Uint8Array | undefined>>() }));
vi.mock("../src/resources/image-transcode.js", async (original) => ({
  ...(await original<typeof import("../src/resources/image-transcode.js")>()),
  firstFrameToPng: transcode.firstFrameToPng,
}));

import { createReadTool } from "../src/agents/tools.js";
import { ChannelResources } from "../src/resources/index.js";
import { PNG_BYTES } from "./helpers/index.js";

/** 1×1 lossless WebP and 1×1 GIF. */
const WEBP = new Uint8Array(Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"));
const GIF = new Uint8Array(Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;
const roots: string[] = [];

afterEach(async () => {
  transcode.firstFrameToPng.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readAs(bytes: Uint8Array, nativeMediaTypes: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-still-"));
  roots.push(root);
  const resources = new ChannelResources(root, true);
  const id = await resources.assets.put(bytes);
  const tool = createReadTool(resources, { mode: "native", nativeMediaTypes });
  const uri = `asset://${id}`;
  const result = await tool.execute({ uri }, { toolCallId: "call-1", turnId: "turn-1" } as never);
  const output = await tool.toModelOutput!({ toolCallId: "call-1", input: { uri }, output: result });
  return { result, output };
}

describe("read shows a WebP or GIF the model route refuses as a PNG still", () => {
  it.each([
    ["image/webp", WEBP, "第一帧，转成了 PNG。"],
    ["image/gif", GIF, "动图后面的画面没有看到"],
  ] as const)("%s", async (mediaType, bytes, note) => {
    transcode.firstFrameToPng.mockResolvedValue(PNG_BYTES);
    const { result, output } = await readAs(bytes, ["image/png", "image/jpeg"]);
    expect(transcode.firstFrameToPng).toHaveBeenCalledWith(bytes, mediaType, expect.objectContaining({ timeoutMs: 10_000 }));
    expect(result).toMatchObject({ mediaType, imageMode: "native" });
    expect(result.text).toContain(note);
    expect(output).toMatchObject({
      type: "content",
      value: expect.arrayContaining([{ type: "image-data", data: Buffer.from(PNG_BYTES).toString("base64"), mediaType: "image/png" }]),
    });
  });

  it("keeps a format the route takes, and says nothing was seen when conversion fails or PNG is refused too", async () => {
    await expect(readAs(WEBP, ["image/png", "image/webp"])).resolves.toMatchObject({ result: { mediaType: "image/webp", imageMode: "native" } });
    transcode.firstFrameToPng.mockResolvedValue(undefined);
    await expect(readAs(GIF, ["image/png"])).resolves.toMatchObject({ result: { imageMode: "unavailable", error: "image_input_unavailable" } });
    transcode.firstFrameToPng.mockClear();
    await expect(readAs(GIF, ["image/jpeg"])).resolves.toMatchObject({ result: { error: "image_input_unavailable" } });
    expect(transcode.firstFrameToPng).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_FFMPEG)("firstFrameToPng with FFmpeg", () => {
  it.each([
    ["image/webp", WEBP],
    ["image/gif", GIF],
  ] as const)("%s", async (mediaType, bytes) => {
    const { firstFrameToPng } = await vi.importActual<typeof import("../src/resources/image-transcode.js")>("../src/resources/image-transcode.js");
    const png = await firstFrameToPng(bytes, mediaType, { maxBytes: 1 << 20, timeoutMs: 10_000 });
    expect(png && Buffer.from(png.subarray(0, 8))).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
});

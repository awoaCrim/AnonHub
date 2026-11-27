import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ fetchRemoteImage: vi.fn() }));
vi.mock("../src/resources/remote-image.js", () => remote);

import { createReadTool } from "../src/agents/tools.js";
import { ChannelResources, RESOURCE_ERRORS, resourceError } from "../src/resources/index.js";
import { PNG_BYTES } from "./helpers/index.js";

const roots: string[] = [];
const URL = "https://pbs.twimg.com/media/GxYz.png?name=orig";

afterEach(async () => {
  remote.fetchRemoteImage.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function resources(imageInput: boolean) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-read-web-"));
  roots.push(root);
  return new ChannelResources(root, imageInput);
}

// User, 2026-11-20: 「推文中的图片也看不到」.
describe("read of a picture by web address", () => {
  it("shows a picture from a public web address to the model", async () => {
    remote.fetchRemoteImage.mockResolvedValueOnce({ bytes: PNG_BYTES, mediaType: "image/png", filename: "GxYz.png" });
    const tool = createReadTool(await resources(true), { mode: "native" });
    expect(tool.description).toContain("https://…：公开网址上的图片");
    const result = await tool.execute!({ uri: URL }, { toolCallId: "web-1", turnId: "turn-1" } as never);
    expect(result).toMatchObject({ uri: URL, filename: "GxYz.png", mediaType: "image/png", imageMode: "native" });
    expect(remote.fetchRemoteImage).toHaveBeenCalledWith(URL, expect.any(Object));
    expect((await tool.toModelOutput!({ toolCallId: "web-1", input: { uri: URL }, output: result })).type).toBe("content");
  });

  it("explains a refused or failed web address", async () => {
    const tool = createReadTool(await resources(true), { mode: "native" });
    remote.fetchRemoteImage.mockRejectedValueOnce(resourceError(RESOURCE_ERRORS.resource_uri_invalid));
    expect(await tool.execute!({ uri: "https://127.0.0.1/a.png" }, { toolCallId: "web-2", turnId: "turn-1" } as never)).toEqual({
      uri: "https://127.0.0.1/a.png",
      error: "resource_uri_invalid",
      text: expect.stringContaining("内网和本机地址不能读取"),
    });
    remote.fetchRemoteImage.mockRejectedValueOnce(resourceError(RESOURCE_ERRORS.resource_not_image));
    expect(await tool.execute!({ uri: URL }, { toolCallId: "web-3", turnId: "turn-1" } as never)).toMatchObject({
      error: "resource_not_image",
      text: expect.stringContaining("不是 PNG、JPEG、GIF 或 WebP"),
    });
  });

  it("neither offers nor downloads web pictures when the model cannot see pictures", async () => {
    const tool = createReadTool(await resources(false), { mode: "unavailable" });
    expect(tool.description).not.toContain("https://…");
    expect(await tool.execute!({ uri: URL }, { toolCallId: "web-4", turnId: "turn-1" } as never)).toMatchObject({
      imageMode: "unavailable",
      error: "image_input_unavailable",
    });
    expect(remote.fetchRemoteImage).not.toHaveBeenCalled();
  });
});

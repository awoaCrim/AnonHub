import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformPart, VideoPart } from "@yesimbot/contracts/parts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMessage,
  formatCurrentInput,
  formatCurrentInputWithImages,
  formatInput,
  formatInputWithImages,
  type MessageRecord,
} from "../src/messages/index.js";
import { ChannelResources } from "../src/resources/index.js";
import { persistInbound, serveDownloads } from "./helpers/downloads.js";
import { h } from "./helpers/index.js";
import { VIDEO_BYTES } from "./helpers/video.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QQ native video source and formatting", () => {
  it.each([false, true])("persists group/private=%s current and quoted videos through the actual resource owner", async (isDirect) => {
    const root = await mkdtemp(join(tmpdir(), "video-input-"));
    roots.push(root);
    const resources = new ChannelResources(root, true, 1000, true);
    const http = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ "content-type": "video/mp4" }),
      data: new ReadableStream({
        start(c) {
          c.enqueue(VIDEO_BYTES);
          c.close();
        },
      }),
    }));
    const ctx = { http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) };
    serveDownloads(ctx);
    const element = () => h("video", { src: "https://private.example/clip?token=secret", file: "private-file", fileSize: VIDEO_BYTES.length });
    const record: MessageRecord = {
      platform: "onebot",
      selfId: "10000",
      channel: { id: isDirect ? "private:30000" : "20000", type: isDirect ? 1 : 0 },
      user: { id: "30000", name: "Alice" },
      messageId: "40000",
      timestamp: 1,
      parts: await persistInbound(ctx, [h("reply", { id: "quoted" }), h("message", {}, [element()])], resources),
      quote: { messageId: "quoted", author: { id: "10000", isBot: true }, parts: await persistInbound(ctx, [element()], resources) },
    };
    const nested = record.parts[1] as PlatformPart;
    expect(nested).toMatchObject({ type: "platform", tag: "message", parts: [{ type: "video", asset: expect.stringMatching(/^[a-f0-9]{32}$/) }] });
    const id = (nested.parts[0] as VideoPart).asset;
    expect(record.quote!.parts[0]).toEqual({ type: "video", asset: id });
    expect(JSON.stringify(record)).not.toMatch(/private.example|secret|private-file|token=/);
    expect(http).toHaveBeenCalledTimes(2);
    const message = createMessage(record);
    const resolver = vi.fn();
    const formatted = [
      formatInput(message),
      formatCurrentInput(message),
      await formatInputWithImages(message, resolver),
      await formatCurrentInputWithImages(message, resolver),
    ];
    for (const output of formatted) {
      const content = JSON.stringify(output.content);
      expect(content.split("asset://" + id)).toHaveLength(3);
      expect(content).toContain("QUOTED_MESSAGE");
      expect(content).toContain("quoted");
      expect(content).not.toContain("<video");
      expect(content).not.toMatch(/private.example|secret|token=|file-data|data:video/);
    }
    expect(JSON.stringify(formatted[1])).toContain("CURRENT_MESSAGE");
    expect(JSON.stringify(formatted[3])).toContain("CURRENT_MESSAGE");
    expect(resolver).not.toHaveBeenCalled(); // video stays on-demand, even with imageInput enabled.
  });

  it("renders bounded video failures consistently in ordinary and image-enabled paths", async () => {
    const message = createMessage({
      platform: "onebot",
      selfId: "bot",
      channel: { id: "room", type: 0 },
      user: { id: "user" },
      messageId: "message",
      timestamp: 1,
      parts: [{ type: "video", failure: "timeout" }],
    });
    const normal = formatInput(message);
    const withImages = await formatInputWithImages(message, vi.fn());
    expect(withImages).toEqual(normal);
    expect(String(normal.content)).not.toContain("<video");
    expect(String(normal.content)).toContain("视频");
    expect(String(normal.content)).not.toContain("asset://");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type FilePart, type ImagePart, type Part } from "@yesimbot/contracts/parts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReadTool } from "../src/agents/tools.js";
import { createMessage, formatInput, formatInputWithImages } from "../src/messages/index.js";
import { ChannelResources } from "../src/resources/index.js";
import { persistInbound, serveDownloads } from "./helpers/downloads.js";
import { h, parts as partsOf } from "./helpers/index.js";

const PEM = "-----BEGIN PUBLIC KEY-----\nsynthetic-test-fixture\n-----END PUBLIC KEY-----\n";
const SOURCE = "https://files.example.test/download?token=temporary-secret";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(bytes = new TextEncoder().encode(PEM), status = 200, timeoutMs = 10_000) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-file-input-"));
  roots.push(root);
  const resources = new ChannelResources(root, false, timeoutMs);
  const http = vi.fn(async () => ({
    status,
    headers: new Headers({ "content-type": "application/octet-stream" }),
    data: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  }));
  const ctx = { http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) };
  serveDownloads(ctx);
  return { ctx, http, resources };
}

function message(parts: Part[]) {
  return createMessage({
    platform: "onebot",
    selfId: "10000",
    channel: { id: "private:20000", type: 1 },
    user: { id: "20000" },
    messageId: "m",
    timestamp: 1,
    parts,
  });
}

describe("inbound text files", () => {
  it("makes a QQ PEM attachment readable using the adapter's file/fileId attributes", async () => {
    const { ctx, resources } = await setup();
    const parts = await persistInbound(
      ctx,
      [h("file", { src: SOURCE, file: "example.pem", fileId: "platform-file-id", fileSize: String(PEM.length) })],
      resources,
    );
    expect(parts[0]).toEqual({ type: "file", asset: expect.stringMatching(/^[a-f0-9]{32}$/), title: "example.pem" });
    const content = String(formatInput(message(parts)).content);
    const uri = `asset://${(parts[0] as FilePart).asset}`;
    expect(content).toContain(`[文件：example.pem ${uri}]`);
    expect(content).not.toMatch(/temporary-secret|platform-file-id/);
    const tool = createReadTool(resources, false);
    expect(await tool.execute!({ uri }, { toolCallId: "read-pem" } as never)).toMatchObject({ uri, text: PEM });
  });

  it.each(["example.PEM", "id_ed25519.pub", "server.key", "server.crt", "server.cer", "server.csr"])("accepts textual key or certificate %s", async (title) => {
    const { ctx, resources } = await setup();
    const [file] = await persistInbound(ctx, [h("file", { src: SOURCE, title })], resources);
    expect(file).toEqual({ type: "file", asset: expect.stringMatching(/^[a-f0-9]{32}$/), title });
  });

  it.each([
    [{ src: SOURCE, file: "archive.zip" }, "unsupported_type", "不支持的文件类型"],
    [{ file: "example.pem" }, "missing_source", "缺少下载地址"],
    [{ src: SOURCE }, "missing_filename", "缺少文件名"],
  ] as const)("retains the filename and reason for unread files: %j", async (attrs, code, label) => {
    const { ctx, http, resources } = await setup();
    const parts = await persistInbound(ctx, [h("file", attrs)], resources);
    expect((parts[0] as FilePart).failure).toBe(code);
    expect((parts[0] as FilePart).src).toBeUndefined();
    const content = String(formatInput(message(parts)).content);
    expect(content).toContain(label);
    if ("file" in attrs) expect(content).toContain(attrs.file);
    expect(content).not.toContain("temporary-secret");
    expect(http).not.toHaveBeenCalled();
  });

  it.each([new Uint8Array([0xff, 0xfe]), new Uint8Array([65, 0, 66]), new Uint8Array()])("rejects non-text bytes disguised as a PEM", async (bytes) => {
    const { ctx, resources } = await setup(bytes);
    const put = vi.spyOn(resources.assets, "put");
    const [file] = await persistInbound(ctx, [h("file", { src: SOURCE, file: "example.pem" })], resources);
    expect(file).toEqual({ type: "file", title: "example.pem", failure: "not_text" });
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps the 1 MiB and two-file intake limits visible", async () => {
    const { ctx, resources } = await setup(new Uint8Array(1024 * 1024 + 1).fill(65));
    const [oversize] = await persistInbound(ctx, [h("file", { src: SOURCE, name: "large.pem" })], resources);
    expect(oversize).toEqual({ type: "file", title: "large.pem", failure: "too_large" });
    const small = await setup();
    const files = await persistInbound(
      small.ctx,
      ["a.pem", "b.pem", "c.pem"].map((name) => h("file", { src: SOURCE, name })),
      small.resources,
    );
    expect(files.slice(0, 2).every((file) => file.type === "file" && file.asset)).toBe(true);
    expect(files[2]).toEqual({ type: "file", title: "c.pem", failure: "file_limit" });
  });

  it("reports a download failure without retaining signed URLs", async () => {
    const { ctx, resources } = await setup(undefined, 403);
    const [file] = await persistInbound(ctx, [h("file", { src: SOURCE, file: "example.pem" })], resources);
    expect(file).toEqual({ type: "file", title: "example.pem", failure: "download_failed" });
  });

  it("reports a timeout without persisting a partial file", async () => {
    const { ctx, resources } = await setup(undefined, 200, 10);
    ctx.http.mockImplementation(async () => new Promise(() => {}));
    const put = vi.spyOn(resources.assets, "put");
    const [file] = await persistInbound(ctx, [h("file", { src: SOURCE, file: "example.pem" })], resources);
    expect(file).toEqual({ type: "file", title: "example.pem", failure: "timeout" });
    expect(put).not.toHaveBeenCalled();
  });

  it("reports a storage failure and preserves already persisted files", async () => {
    const { ctx, resources } = await setup();
    vi.spyOn(resources.assets, "put").mockRejectedValue(new Error("private filesystem details"));
    const [file] = await persistInbound(ctx, [h("file", { src: SOURCE, file: "example.pem" })], resources);
    expect(file).toEqual({ type: "file", title: "example.pem", failure: "save_failed" });
    const saved = h("file", { id: "abcdefabcdefabcdefabcdefabcdefab", title: "saved.pem" });
    expect(await persistInbound(ctx, [saved], resources)).toEqual([{ type: "file", asset: "abcdefabcdefabcdefabcdefabcdefab", title: "saved.pem" }]);
  });

  it("shows a filename for legacy unread attachments without exposing transport metadata", () => {
    const content = String(
      formatInput(
        createMessage({
          platform: "onebot",
          selfId: "10000",
          channel: { id: "private:20000", type: 1 },
          user: { id: "20000" },
          messageId: "old",
          timestamp: 1,
          parts: partsOf(h("file", { src: SOURCE, file: "example.pem", fileId: "platform-file-id" })),
        }),
      ).content,
    );
    expect(content).toContain("example.pem");
    expect(content).toContain("未读取");
    expect(content).not.toMatch(/temporary-secret|platform-file-id/);
  });
});

// User, 2026-11-19: 「qq上文件类型的图片bot看不了」: a picture sent through 「文件」 was refused as an unsupported file.
describe("pictures sent as files", () => {
  it("shows a QQ picture sent as a file to the model as an image with its name", async () => {
    const { ctx, resources } = await setup(PNG);
    const parts = await persistInbound(ctx, [h("file", { src: SOURCE, file: "Screenshot 2026.PNG", fileId: "platform-file-id" })], resources);
    expect(parts[0]).toMatchObject({ type: "image", asset: expect.stringMatching(/^[a-f0-9]{32}$/), title: "Screenshot 2026.PNG" });
    const uri = `asset://${(parts[0] as ImagePart).asset}`;
    expect(String(formatInput(message(parts)).content)).toContain(`[图片：Screenshot 2026.PNG ${uri}]`);
    const input = await formatInputWithImages(message(parts), async () => ({ bytes: PNG, mediaType: "image/png" }));
    expect(input.content).toEqual(expect.arrayContaining([{ type: "image", image: PNG, mediaType: "image/png" }]));
    expect(JSON.stringify(input.content)).toContain("[图片：Screenshot 2026.PNG]");
    expect(JSON.stringify(input.content)).not.toMatch(/temporary-secret|platform-file-id/);
  });

  it("keeps a file that only looks like a picture unread, with the reason", async () => {
    const { ctx, resources } = await setup(new TextEncoder().encode("not a picture"));
    const put = vi.spyOn(resources.assets, "put");
    const [file] = await persistInbound(ctx, [h("file", { src: SOURCE, file: "photo.jpg" })], resources);
    expect(file).toEqual({ type: "file", title: "photo.jpg", failure: "not_image" });
    expect(put).not.toHaveBeenCalled();
    expect(String(formatInput(message([file!])).content)).toContain("[文件：photo.jpg；未读取：不是有效图片]");
  });

  it("counts pictures sent as files against the image limits", async () => {
    const { ctx, resources } = await setup(PNG);
    const elements = await persistInbound(
      ctx,
      [...["a.png", "b.jpeg", "c.gif"].map((file) => h("file", { src: SOURCE, file })), h("img", { src: SOURCE }), h("file", { src: SOURCE, file: "e.webp" })],
      resources,
    );
    expect(elements.slice(0, 4).every((part) => part.type === "image" && /^[a-f0-9]{32}$/.test(String(part.asset)))).toBe(true);
    expect(elements[4]).toEqual({ type: "file", title: "e.webp", failure: "file_limit" });
    const large = new Uint8Array(5 * 1024 * 1024 + 1);
    large.set(PNG);
    const big = await setup(large);
    const [oversize] = await persistInbound(big.ctx, [h("file", { src: SOURCE, file: "original.png" })], big.resources);
    expect(oversize).toEqual({ type: "file", title: "original.png", failure: "too_large" });
  });
});

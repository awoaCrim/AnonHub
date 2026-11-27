import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { EphemeralImageProjectionStore, type AgentTool } from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { replyChannelId } from "@yesimbot/contracts/platforms";
import { detectImageType } from "@yesimbot/foundation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReadTool, type ResourceReadResult } from "../src/agents/tools.js";
import { parseMarkup } from "../src/messages/markup.js";
import { partView } from "../src/messages/parts.js";
import { ChannelArtifactStore } from "../src/resources/artifact.js";
import { ChannelAssetStore } from "../src/resources/asset.js";
import { ChannelResources, prepareOutputSegments as prepareParts, RESOURCE_MAX_BYTES, type ResourceReader } from "../src/resources/index.js";
import { persistInbound } from "./helpers/downloads.js";
import { h, PNG_BYTES } from "./helpers/index.js";

const roots: string[] = [];

async function tempRoot(prefix = "yesimbot-resource-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function reader(scheme: string, prompt: string, setup: ResourceReader["setup"]): ResourceReader {
  return { scheme, prompt, setup };
}

async function createResources(overrides: { readTimeoutMs?: number } = {}): Promise<ChannelResources> {
  return new ChannelResources(await tempRoot(), false, overrides.readTimeoutMs ?? 10_000);
}

type ReadTool = AgentTool<{ uri: string }, ResourceReadResult>;

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared resource image validation", () => {
  it("exports the sendable byte limit and detects supported image formats from magic bytes", () => {
    expect(RESOURCE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(detectImageType(PNG_BYTES)).toBe("image/png");
    expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(detectImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(detectImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(detectImageType(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("exposes the same validation contract on each channel resource owner", async () => {
    const resources = await createResources();
    expect(resources.maxBytes).toBe(RESOURCE_MAX_BYTES);
    expect(resources.detectImageMediaType(PNG_BYTES)).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// session-live input resources
// ---------------------------------------------------------------------------

describe("session-live input resources", () => {
  it("persists an inbound image through the resolved ChannelResources owner", async () => {
    const http = Object.assign(
      vi.fn(async () => ({
        headers: new Headers({ "content-type": "image/png", "content-length": "4" }),
        status: 200,
        data: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
            controller.close();
          },
        }),
      })),
      { head: vi.fn(async () => ({ get: (name: string) => ({ "content-type": "image/png", "content-length": "4" })[name] ?? null })) },
    );
    const resources = { assets: { put: vi.fn(async () => "0123456789abcdef0123456789abcdef") } };

    const ctx = { http, logger: vi.fn(() => ({ debug: vi.fn() })) };
    const elements = await persistInbound(ctx as never, [h("img", { src: "https://example.test/image.png" })], resources as never);

    expect(http.head).not.toHaveBeenCalled();
    expect(resources.assets.put).toHaveBeenCalledWith(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(elements).toEqual([{ type: "image", asset: "0123456789abcdef0123456789abcdef" }]);
  });

  it("downloads without HEAD and honors the owner timeout beyond the former 10 second cutoff", async () => {
    const resources = await createResources({ readTimeoutMs: 30_000 });
    const put = vi.spyOn(resources.assets, "put").mockResolvedValue("0123456789abcdef0123456789abcdef");
    vi.useFakeTimers();
    const http = Object.assign(
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        return {
          status: 200,
          headers: new Headers(),
          data: new ReadableStream({
            start(c) {
              c.enqueue(PNG_BYTES);
              c.close();
            },
          }),
        };
      }),
      { head: vi.fn(() => new Promise(() => {})) },
    );
    const ctx = { http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) };
    const pending = persistInbound(ctx as never, [h("img", { src: "https://example.test/image" })], resources);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await pending).toEqual([{ type: "image", asset: "0123456789abcdef0123456789abcdef" }]);
    expect(http.head).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledOnce();
    expect(http.mock.calls[0]![0]).toBe("https://example.test/image");
    expect(put).toHaveBeenCalledWith(PNG_BYTES);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out while waiting for headers and cancels a late response without saving it", async () => {
    const resources = await createResources({ readTimeoutMs: 50 });
    const put = vi.spyOn(resources.assets, "put");
    const warn = vi.fn();
    const cancel = vi.fn();
    vi.useFakeTimers();
    const http = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { status: 200, headers: new Headers(), data: new ReadableStream({ cancel }) };
    });
    const ctx = { http, logger: () => ({ debug: vi.fn(), warn }) };
    const pending = persistInbound(ctx as never, [h("img", { src: "https://private.example/image?token=secret" })], resources);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual([{ type: "image", failure: "timeout" }]);
    expect(warn).toHaveBeenCalledWith("resources.input.failed", { kind: "image", stage: "headers", code: "timeout", elapsedMs: 50, timeoutMs: 50 });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret|token/);
    await vi.advanceTimersByTimeAsync(50);
    expect(cancel).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not persist partial bytes when timeout cancels a pending body read as done", async () => {
    const resources = await createResources({ readTimeoutMs: 50 });
    const put = vi.spyOn(resources.assets, "put");
    const warn = vi.fn();
    const cancel = vi.fn(() => Promise.reject(new Error("private cancel failure")));
    vi.useFakeTimers();
    const http = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      data: new ReadableStream({
        start(c) {
          c.enqueue(PNG_BYTES);
        },
        cancel,
      }),
    }));
    const pending = persistInbound({ http, logger: () => ({ debug: vi.fn(), warn }) } as never, [h("img", { src: "https://example.test/image" })], resources);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual([{ type: "image", failure: "timeout" }]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("resources.input.failed", expect.objectContaining({ stage: "body", code: "timeout" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [200, { "content-length": String(RESOURCE_MAX_BYTES + 1) }, "too_large"],
    [200, { "content-type": "text/html" }, "not_image"],
    [403, {}, "download_failed"],
  ] as const)("cancels rejected GET bodies for status %s and headers %j", async (status, headers, code) => {
    const resources = await createResources();
    const put = vi.spyOn(resources.assets, "put");
    const cancel = vi.fn();
    const http = vi.fn(async () => ({ status, headers: new Headers(headers), data: new ReadableStream({ cancel }) }));
    const ctx = { http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) };
    expect(await persistInbound(ctx as never, [h("img", { src: "https://example.test/image" })], resources)).toEqual([{ type: "image", failure: code }]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("bounds an unadvertised body and cancels overflow even when cancellation fails", async () => {
    const resources = await createResources();
    const put = vi.spyOn(resources.assets, "put");
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    const http = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      data: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(RESOURCE_MAX_BYTES + 1));
        },
        cancel,
      }),
    }));
    const ctx = { http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) };
    expect(await persistInbound(ctx as never, [h("img", { src: "https://example.test/image" })], resources)).toEqual([{ type: "image", failure: "too_large" }]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("preserves count and total-byte limits across concurrent GETs", async () => {
    const resources = await createResources();
    const put = vi.spyOn(resources.assets, "put").mockResolvedValue("0123456789abcdef0123456789abcdef");
    const http = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      data: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(RESOURCE_MAX_BYTES));
          c.close();
        },
      }),
    }));
    const ctx = { http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) };
    const results = await persistInbound(
      ctx as never,
      Array.from({ length: 5 }, () => h("img", { src: "https://example.test/image" })),
      resources,
    );
    expect(results.map((part) => (part.type === "image" ? part.failure : part.type))).toEqual([
      undefined,
      undefined,
      "total_size_limit",
      "total_size_limit",
      "image_limit",
    ]);
    expect(put).toHaveBeenCalledTimes(2);
    expect(http).toHaveBeenCalledTimes(4);
  });

  it("keeps data and local file ingestion independent of HTTP", async () => {
    const resources = await createResources();
    const path = join(resources.path, "image.png");
    await writeFile(path, PNG_BYTES);
    const http = vi.fn();
    const ctx = { http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) };
    for (const src of [pathToFileURL(path).href, `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`]) {
      const [part] = await persistInbound(ctx as never, [h("img", { src })], resources);
      expect(part).toMatchObject({ type: "image", asset: expect.any(String) });
      expect(await resources.assets.get(part!.type === "image" ? part.asset! : "")).toEqual(PNG_BYTES);
    }
    expect(http).not.toHaveBeenCalled();
  });

  it("records a bounded reason when an inbound image has no source", async () => {
    const ctx = { http: vi.fn(), logger: vi.fn(() => ({ debug: vi.fn() })) };
    const resources = { assets: { put: vi.fn() } };

    const elements = await persistInbound(ctx as never, [h("img", {})], resources as never);

    expect(elements).toEqual([{ type: "image", failure: "missing_source" }]);
    expect(resources.assets.put).not.toHaveBeenCalled();
  });

  it("uses an inbound file name when persisting a text script", async () => {
    const script = new TextEncoder().encode("print('ok')\n");
    const http = Object.assign(
      vi.fn(async () => ({
        headers: new Headers({ "content-type": "text/plain", "content-length": String(script.byteLength) }),
        status: 200,
        data: new ReadableStream({
          start(controller) {
            controller.enqueue(script);
            controller.close();
          },
        }),
      })),
      { head: vi.fn(async () => ({ get: (name: string) => ({ "content-type": "text/plain", "content-length": String(script.byteLength) })[name] ?? null })) },
    );
    const id = "abcdefabcdefabcdefabcdefabcdefab";
    const resources = { assets: { put: vi.fn(async () => id) } };
    const ctx = { http, logger: vi.fn(() => ({ debug: vi.fn() })) };

    const elements = await persistInbound(ctx as never, [h("file", { src: "https://example.test/script.py", name: "script.py" })], resources as never);

    expect(resources.assets.put).toHaveBeenCalledWith(script);
    expect(elements).toEqual([{ type: "file", asset: id, title: "script.py" }]);
  });

  it("persists a base64:// image element without downloading", async () => {
    const http = vi.fn();
    const resources = { assets: { put: vi.fn(async () => "0123456789abcdef0123456789abcdef") } };
    const ctx = { http, logger: vi.fn(() => ({ debug: vi.fn() })) };

    const elements = await persistInbound(ctx as never, [h("img", { src: `base64://${Buffer.from(PNG_BYTES).toString("base64")}` })], resources as never);

    expect(resources.assets.put).toHaveBeenCalledWith(PNG_BYTES);
    expect(elements).toEqual([{ type: "image", asset: "0123456789abcdef0123456789abcdef" }]);
    expect(http).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ChannelResources binary stores
// ---------------------------------------------------------------------------

describe("ChannelResources binary stores", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const id = createHash("sha256").update(PNG).digest("hex").slice(0, 32);

  it("keeps asset IDs and artifact URIs, metadata, and clear lifecycles distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channel-resources-"));
    roots.push(root);
    const assets = new ChannelAssetStore(root);
    const artifacts = new ChannelArtifactStore(root);
    const source = PNG.slice();

    expect(await assets.put(source)).toBe(id);
    source[0] = 0;
    const uri = await artifacts.forTool("capture").put(PNG, { filename: "capture.png", mediaType: "image/png" });

    await expect(assets.get(id)).resolves.toEqual(PNG);
    await expect(artifacts.open(uri)).resolves.toEqual({ bytes: PNG, filename: "capture.png", mediaType: "image/png" });
    await assets.clear();
    await expect(assets.get(id)).rejects.toThrow();
    await expect(artifacts.open(uri)).resolves.toMatchObject({ bytes: PNG });
  });
});

// ---------------------------------------------------------------------------
// Reply targets (shared by every sending path)
// ---------------------------------------------------------------------------

describe("reply target normalization", () => {
  it("strips the OneBot group prefix and keeps other targets as they are", () => {
    expect(replyChannelId("onebot", "group:100200300")).toBe("100200300");
    expect(replyChannelId("onebot", "private:1049700117")).toBe("private:1049700117");
    expect(replyChannelId("onebot", "100200300")).toBe("100200300");
    expect(replyChannelId("discord", "group:abc")).toBe("group:abc");
  });
});

// ---------------------------------------------------------------------------
// ChannelResources raw open
// ---------------------------------------------------------------------------

describe("ChannelResources raw open", () => {
  it("opens built-in assets and dispatches a registered reader", async () => {
    const resources = await createResources();
    const id = await resources.assets.put(new Uint8Array([1, 2, 3]));
    await expect(resources.open(`asset://${id}`)).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
    const setup = vi.fn(async () => ({ bytes: new Uint8Array([4]), filename: "ok.txt" }));
    resources.use({ scheme: "test", prompt: "test reader", setup });
    await expect(resources.open("test://host/file")).resolves.toMatchObject({ filename: "ok.txt" });
    expect(resources.listReaders()).toHaveLength(1);
  });

  it("returns undefined for malformed and unavailable URIs", async () => {
    const resources = await createResources();
    await expect(resources.open("asset://short")).resolves.toBeUndefined();
    await expect(resources.open("missing://host/file")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// read tool resource errors
// ---------------------------------------------------------------------------

describe("read tool resource errors", () => {
  it("rejects registration of reserved schemes", async () => {
    const resources = await createResources();
    const open = async () => ({ bytes: PNG_BYTES });
    expect(() => resources.use(reader("asset", "x", open))).toThrow();
    expect(() => resources.use(reader("artifact", "x", open))).toThrow();
  });

  it("rejects duplicate scheme registrations", async () => {
    const resources = await createResources();
    const open = async () => ({ bytes: PNG_BYTES });
    resources.use(reader("skill", "first", open));
    expect(() => resources.use(reader("skill", "second", open))).toThrow();
  });

  it("rejects traversal attempts", async () => {
    const resources = await createResources();
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "workspace:///../secret" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_uri_invalid",
    });
  });

  it("returns unavailable for unregistered schemes", async () => {
    const resources = await createResources();
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "skill://csv/SKILL.md" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_unavailable",
    });
  });

  it("respects timeout configuration", async () => {
    const resources = await createResources({ readTimeoutMs: 1 });
    resources.use(
      reader("test", "test", async (_resources, _uri, { signal }) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve({ bytes: PNG_BYTES }), 100);
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new Error("Aborted"));
          });
        });
      }),
    );
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "test:///file" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_timeout",
    });
  });

  it("enforces a hard deadline when an opener ignores abort", async () => {
    const resources = await createResources({ readTimeoutMs: 1 });
    resources.use(reader("slow", "slow", async () => Promise.withResolvers<{ bytes: Uint8Array }>().promise));
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "slow:///file" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_timeout",
    });
    await expect(resources.open("slow:///file")).resolves.toBeUndefined();
  });

  it("aborts an opener when the current turn is cancelled", async () => {
    const resources = await createResources();
    resources.use(reader("abort", "abort", async () => Promise.withResolvers<{ bytes: Uint8Array }>().promise));
    const tool = createReadTool(resources, false);
    const controller = new AbortController();
    const pending = tool.execute({ uri: "abort:///file" }, { toolCallId: "c", abortSignal: controller.signal } as never);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ error: expect.any(String) });
  });

  it("rejects unbounded and unsafe registered opener results", async () => {
    const resources = await createResources();
    resources.use(reader("unsafe", "unsafe", async () => ({ bytes: new Uint8Array([1]), filename: "../secret.txt" })));
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "unsafe:///file" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_read_failed",
    });

    const oversizedResources = await createResources();
    oversizedResources.use(reader("large", "large", async () => ({ bytes: new Uint8Array(5 * 1024 * 1024 + 1) })));
    const oversizedTool = createReadTool(oversizedResources, false);
    await expect(oversizedTool.execute({ uri: "large:///file" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_too_large",
    });
  });

  it("rejects an empty path before dispatching a custom scheme", async () => {
    const resources = await createResources();
    const open = vi.fn(async () => ({ bytes: PNG_BYTES }));
    resources.use(reader("custom", "custom", open));
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "custom:///" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_uri_invalid",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("marks long text reads with a bounded truncation marker", async () => {
    const resources = await createResources();
    resources.use(reader("text", "text", async () => ({ bytes: new TextEncoder().encode("x".repeat(30_001)) })));
    const tool = createReadTool(resources, false);
    const result = await tool.execute({ uri: "text:///file" }, { toolCallId: "c", abortSignal: undefined } as never);
    expect(result.text).toHaveLength(30_000);
    expect(result.text).toContain("内容已截断");
  });

  it("rejects authority, query, fragment, and encoded traversal", async () => {
    const resources = await createResources();
    const tool = createReadTool(resources, false);
    for (const uri of [
      "asset://a6e2b32e1d9d64b2e906ac5c3216d18f?x=1",
      "artifact://mcp/x#frag",
      "workspace://host/path",
      "workspace:///reports/%2e%2e/secret.txt",
      "asset://SHORT",
      "asset://a6e2b32e1d9d64b2e906ac5c3216d18f/extra",
    ]) {
      await expect(tool.execute({ uri }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({ error: "resource_uri_invalid" });
    }
  });
});

// ---------------------------------------------------------------------------
// prepareOutputSegments
// ---------------------------------------------------------------------------

describe("prepareOutputSegments", () => {
  // Model markup and element-shaped fixtures in, the element view of each prepared part out.
  const prepareOutputSegments = async (segments: readonly (readonly unknown[])[], resources: ChannelResources) =>
    (
      await prepareParts(
        segments.map((segment) => partsFromElements(segment, { sources: true })),
        resources,
      )
    ).map((segment) => segment.map(partView));

  it.each(["img", "file", "nested", "entities"])("blocks sticker artifact delivery through %s while retaining read access", async (shape) => {
    const resources = await createResources();
    const uri = await resources.artifacts.forTool("sticker").put(PNG_BYTES, { mediaType: "image/png" });
    const markup =
      shape === "nested"
        ? `<message><img src="${uri}"/></message>`
        : shape === "entities"
          ? `<img src="${uri.replace(":", "&#58;")}"/>`
          : `<${shape} src="${uri}"/>`;
    await expect(prepareOutputSegments([parseMarkup(markup)], resources)).rejects.toMatchObject({ code: "resource_delivery_restricted" });
    expect((await resources.open(uri))?.bytes).toEqual(PNG_BYTES);
  });

  it("enforces the sticker artifact gate on delivered elements but allows the URI as literal text", async () => {
    const resources = await createResources();
    const uri = await resources.artifacts.forTool("sticker").put(PNG_BYTES, { mediaType: "image/png" });
    await expect(prepareOutputSegments([parseMarkup(`draft <img src="${uri}"/>`)], resources)).rejects.toMatchObject({ code: "resource_delivery_restricted" });
    const literal = await prepareOutputSegments([parseMarkup(uri)], resources);
    expect(literal.flat().every((part) => part.type === "text")).toBe(true);
  });

  async function resourcesWith(open: ResourceReader["setup"], registrations: Map<string, ResourceReader> = new Map()): Promise<ChannelResources> {
    const resources = await createResources();
    for (const [_scheme, r] of registrations) resources.use(r);
    if (!registrations.has("workspace")) {
      resources.use(reader("workspace", "workspace 文件引用", open));
    }
    return resources;
  }

  it("resolves a workspace image source to a data URL before delivery", async () => {
    const resources = await resourcesWith(async () => ({ bytes: PNG_BYTES, mediaType: "image/png", filename: "chart.png" }));

    const prepared = await prepareOutputSegments(
      [
        [
          { type: "text", attrs: { content: "chart:" }, children: [] },
          { type: "img", attrs: { src: "workspace:///images/chart.png" }, children: [] },
        ],
      ],
      resources,
    );

    const img = prepared[0]![1] as { type: string; attrs: { src: string } };
    expect(img.attrs.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.attrs.src).not.toContain("workspace://");
    expect(prepared[0]![0]).toMatchObject({ type: "text" });
  });

  // User, 2026-11-17: files the bot sent on QQ all arrived as `file.bin`; OneBot names a data: file by `title`.
  it("sends a file under its own name and type", async () => {
    const resources = await resourcesWith(async () => ({ bytes: new TextEncoder().encode("%PDF-1.7"), filename: "季度报告.pdf" }));
    const [[named]] = (await prepareOutputSegments([[h("file", { src: "workspace:///out/季度报告.pdf" })]], resources)) as unknown as [
      [{ attrs: Record<string, string> }],
    ];
    expect(named.attrs.title).toBe("季度报告.pdf");
    expect(named.attrs.src.startsWith("data:application/pdf;base64,")).toBe(true);
    const [[renamed]] = (await prepareOutputSegments([[h("file", { src: "workspace:///out/a.pdf", title: "dir/给你的.pdf" })]], resources)) as unknown as [
      [{ attrs: Record<string, string> }],
    ];
    expect(renamed.attrs.title).toBe("给你的.pdf");
  });

  it("names a file without a reported name by its URI, never by an asset ID", async () => {
    const resources = await resourcesWith(async () => ({ bytes: new Uint8Array([1, 2, 3]) }));
    const [[file]] = (await prepareOutputSegments([[h("file", { src: "workspace:///data/export.zip" })]], resources)) as unknown as [
      [{ attrs: Record<string, string> }],
    ];
    expect(file.attrs).toMatchObject({ title: "export.zip" });
    expect(file.attrs.src.startsWith("data:application/zip;base64,")).toBe(true);
    const asset = await resources.assets.put(new Uint8Array([4, 5, 6]));
    const [[stored]] = (await prepareOutputSegments([[h("file", { src: `asset://${asset}` })]], resources)) as unknown as [[{ attrs: Record<string, string> }]];
    expect(stored.attrs.title).toBeUndefined();
  });

  it("resolves an artifact image through the same reader path", async () => {
    const resources = await createResources();
    const uri = await resources.artifacts.forTool("mcp_screenshot").put(PNG_BYTES, { mediaType: "image/png", filename: "screen.png" });

    const prepared = await prepareOutputSegments([[{ type: "img", attrs: { src: uri }, children: [] }]], resources);

    const img = prepared[0]![0] as { type: string; attrs: { src: string } };
    expect(img.attrs.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.attrs.src).not.toContain("artifact://");
  });

  it("omits an unavailable resource and preserves sibling content", async () => {
    const resources = await resourcesWith(async () => undefined);

    const prepared = await prepareOutputSegments(
      [
        [
          { type: "text", attrs: { content: "keep" }, children: [] },
          { type: "img", attrs: { src: "artifact://mcp_screenshot/019d3b7e-1bd0-7e4f-9c5d-5bf3fd41f1d4" }, children: [] },
        ],
      ],
      resources,
    );

    expect(prepared[0]).toHaveLength(1);
    expect(prepared[0]![0]).toMatchObject({ type: "text", attrs: { content: "keep" } });
  });

  it("leaves unrecognized elements and non-resource sources untouched", async () => {
    const resources = await resourcesWith(async () => undefined);

    const prepared = await prepareOutputSegments(
      [
        [
          { type: "at", attrs: { id: "u1" }, children: [] },
          { type: "img", attrs: { src: "https://example.test/x.png" }, children: [] },
        ],
      ],
      resources,
    );

    expect(prepared[0]).toHaveLength(2);
    expect(prepared[0]![0]).toMatchObject({ type: "at" });
    expect(prepared[0]![1]).toMatchObject({ attrs: { src: "https://example.test/x.png" } });
  });

  it("requires a complete asset ID for output resolution", async () => {
    const resources = await createResources();
    const id = await resources.assets.put(PNG_BYTES);

    const full = await prepareOutputSegments([[{ type: "img", attrs: { src: `asset://${id}` }, children: [] }]], resources);
    expect(full[0]).toHaveLength(1);
    expect((full[0]![0] as { attrs: { src: string } }).attrs.src).toContain("data:image/png;base64,");

    const prefix = await prepareOutputSegments([[{ type: "img", attrs: { src: `asset://${id.slice(0, 7)}` }, children: [] }]], resources);
    expect(prefix).toHaveLength(0);
  });

  it("drops a segment that becomes empty after resource omission", async () => {
    const resources = await resourcesWith(async () => undefined);

    const prepared = await prepareOutputSegments(
      [[{ type: "img", attrs: { src: "artifact://missing/019d3b7e-1bd0-7e4f-9c5d-5bf3fd41f1d4" }, children: [] }]],
      resources,
    );

    expect(prepared).toHaveLength(0);
  });

  it("materializes ordinary files with a generic MIME fallback", async () => {
    const resources = await resourcesWith(async () => ({ bytes: new Uint8Array([1, 2, 3]), filename: "report.bin" }));
    const prepared = await prepareOutputSegments([[{ type: "file", attrs: { src: "workspace:///reports/report.bin" }, children: [] }]], resources);
    expect((prepared[0]![0] as { attrs: { src: string } }).attrs.src).toContain("data:application/octet-stream;base64,");
  });

  it("leaves audio and video output untouched", async () => {
    const open = vi.fn(async () => ({ bytes: PNG_BYTES, mediaType: "image/png" }));
    const resources = await resourcesWith(open);
    const segments = [
      [
        { type: "audio", attrs: { src: "workspace:///sound.mp3" }, children: [] },
        { type: "video", attrs: { src: "workspace:///movie.mp4" }, children: [] },
      ],
    ];
    const prepared = await prepareOutputSegments(segments, resources);
    expect(prepared).toEqual(segments);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not trust an image MIME hint for arbitrary output bytes", async () => {
    const resources = await resourcesWith(async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" }));
    const prepared = await prepareOutputSegments([[{ type: "img", attrs: { src: "workspace:///fake.png" }, children: [] }]], resources);
    expect(prepared).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// read tool model projection
// ---------------------------------------------------------------------------

describe("read tool model projection", () => {
  async function createTool(
    overrides: {
      mode?: "native" | "vision" | "unavailable";
      imageInput?: boolean;
      visionModel?: unknown;
      nativeMediaTypes?: readonly string[];
    } = {},
  ): Promise<{ tool: ReadTool; resources: ChannelResources }> {
    const resources = await createResources();
    return {
      tool: createReadTool(new ChannelResources(resources.path, overrides.imageInput ?? false), {
        mode: overrides.mode ?? "unavailable",
        visionModel: overrides.visionModel as never,
        ...(overrides.nativeMediaTypes === undefined ? {} : { nativeMediaTypes: overrides.nativeMediaTypes }),
      }),
      resources,
    };
  }

  async function readAndProject(tool: ReadTool, uri: string, toolCallId = "call-1") {
    const result = await tool.execute({ uri }, { toolCallId, turnId: "turn-1", abortSignal: undefined } as never);
    const output = await tool.toModelOutput!({ toolCallId, input: { uri }, output: result });
    return { result, output };
  }

  it("projects native image bytes repeatedly during the bounded live-turn window", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const { result, output } = await readAndProject(tool, `asset://${id}`);

    expect(result).toMatchObject({ uri: `asset://${id}`, mediaType: "image/png", imageMode: "native" });
    for (const projected of [
      output,
      await tool.toModelOutput!({ toolCallId: "call-1", input: { uri: `asset://${id}` }, output: result }),
      await tool.toModelOutput!({ toolCallId: "call-1", input: { uri: `asset://${id}` }, output: result }),
    ]) {
      if (projected.type !== "content") throw new Error("expected multimodal output");
      expect(projected.value[0]).toMatchObject({ type: "text" });
      const image = projected.value[1];
      if (!image || image.type !== "image-data") throw new Error("expected image-data part");
      expect(image.mediaType).toBe("image/png");
      expect(Buffer.from(image.data, "base64")).toEqual(Buffer.from(PNG_BYTES));
    }
  });

  it("expires pending native images after the bounded live-turn TTL", async () => {
    vi.useFakeTimers();
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${id}`;
    const result = await tool.execute({ uri }, { toolCallId: "ttl-call", turnId: "turn-1", abortSignal: undefined } as never);

    await vi.advanceTimersByTimeAsync(60_001);

    const projected = await tool.toModelOutput!({ toolCallId: "ttl-call", input: { uri }, output: result });
    expect(projected.type).toBe("json");
    expect(projected).toMatchObject({ value: { imageMode: "unavailable", error: "image_projection_unavailable", text: expect.stringContaining("没有看到") } });
    expect(JSON.stringify(projected)).not.toContain(Buffer.from(PNG_BYTES).toString("base64"));
  });

  it("clears pending native images on abort", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${id}`;
    const controller = new AbortController();
    const result = await tool.execute({ uri }, { toolCallId: "abort-call", turnId: "turn-1", abortSignal: controller.signal } as never);

    controller.abort();

    const projected = await tool.toModelOutput!({ toolCallId: "abort-call", input: { uri }, output: result });
    expect(projected.type).toBe("json");
    expect(projected).toMatchObject({ value: { imageMode: "unavailable", error: "image_projection_unavailable" } });
  });

  it("never pairs a previous result with a replacement image under the same call id", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const uri = `asset://${await resources.assets.put(PNG_BYTES)}`;
    const execution = { toolCallId: "reused", turnId: "turn" } as never;
    const previous = await tool.execute({ uri }, execution);
    const replacement = await tool.execute({ uri }, execution);
    const project = (output: ResourceReadResult) => tool.toModelOutput!({ toolCallId: "reused", input: { uri }, output });
    expect(await project(previous)).toMatchObject({ type: "json", value: { imageMode: "unavailable", error: "image_projection_unavailable" } });
    expect(await project(replacement)).toMatchObject({ type: "content", value: expect.arrayContaining([expect.objectContaining({ type: "image-data" })]) });
    expect(await project({ ...replacement })).toMatchObject({ type: "json", value: { imageMode: "unavailable", error: "image_projection_unavailable" } });
  });

  it("does not report native success when staging image bytes fails", async () => {
    const resources = new ChannelResources(await tempRoot(), true);
    const uri = `asset://${await resources.assets.put(PNG_BYTES)}`;
    const projection = new EphemeralImageProjectionStore();
    vi.spyOn(projection, "stage").mockReturnValue(false);
    const tool = createReadTool(resources, { mode: "native" }, projection);
    const result = await tool.execute({ uri }, { toolCallId: "failed-stage", turnId: "turn" } as never);
    expect(result).toMatchObject({ imageMode: "unavailable", error: "image_projection_unavailable" });
    expect(await tool.toModelOutput!({ toolCallId: "failed-stage", input: { uri }, output: result })).toMatchObject({ type: "json", value: result });
  });

  it("clears stale bytes when a reused tool call ID fails", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${id}`;
    await tool.execute({ uri }, { toolCallId: "reused-call", turnId: "turn-1", abortSignal: undefined } as never);
    const failed = await tool.execute({ uri: `asset://${"a".repeat(32)}` }, { toolCallId: "reused-call", turnId: "turn-1", abortSignal: undefined } as never);

    const projected = await tool.toModelOutput!({ toolCallId: "reused-call", input: { uri }, output: failed });
    expect(projected.type).toBe("json");
    expect(JSON.stringify(projected)).not.toContain(Buffer.from(PNG_BYTES).toString("base64"));
  });

  it("evicts the oldest pending native image when capacity is reached", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${id}`;
    const results = [];
    for (let index = 0; index < 17; index += 1) {
      results.push(await tool.execute({ uri }, { toolCallId: `capacity-${index}`, turnId: "turn-1", abortSignal: undefined } as never));
    }

    expect(await tool.toModelOutput!({ toolCallId: "capacity-0", input: { uri }, output: results[0] })).toMatchObject({
      type: "json",
      value: { imageMode: "unavailable", error: "image_projection_unavailable" },
    });
    expect((await tool.toModelOutput!({ toolCallId: "capacity-16", input: { uri }, output: results[16] })).type).toBe("content");
  });

  it("returns an explicit unavailable result when no image route exists", async () => {
    const { tool, resources } = await createTool({ mode: "unavailable", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const { result, output } = await readAndProject(tool, `asset://${id}`);

    expect(result).toMatchObject({ imageMode: "unavailable", error: "image_input_unavailable" });
    expect(output.type).toBe("json");
  });

  it("does not project a format excluded by the native route capability", async () => {
    const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const { tool, resources } = await createTool({ mode: "native", imageInput: true, nativeMediaTypes: ["image/png", "image/jpeg"] });
    const id = await resources.assets.put(webpBytes);
    const { result, output } = await readAndProject(tool, `asset://${id}`);

    expect(result).toMatchObject({ mediaType: "image/webp", imageMode: "unavailable", error: "image_input_unavailable" });
    expect(output.type).toBe("json");
  });

  it("does not trust an image MIME hint for arbitrary bytes", async () => {
    const resources = await createResources();
    resources.use(reader("fake", "fake", async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" })));
    const tool = createReadTool(resources, { mode: "native" });
    const { result, output } = await readAndProject(tool, "fake:///image");

    expect(result).toMatchObject({ error: "invalid_image_data" });
    expect(output.type).toBe("json");
  });

  it("keeps a JSON result when the read fails", async () => {
    const { tool } = await createTool({ mode: "native", imageInput: true });
    const { result, output } = await readAndProject(tool, `asset://${"a".repeat(32)}`);

    expect(result).toMatchObject({ error: "resource_not_found" });
    expect(output.type).toBe("json");
  });

  it("describes the selected image route", async () => {
    const { tool: native } = await createTool({ mode: "native", imageInput: true });
    expect(native.description).toContain("图片字节将随结果返回");

    const { tool: vision } = await createTool({ mode: "vision", imageInput: false, visionModel: {} });
    expect(vision.description).toContain("自动调用视觉模型");

    const { tool: blind } = await createTool({ mode: "unavailable", imageInput: false });
    expect(blind.description).toContain("无法查看图片内容");
  });

  it("returns artifact image bytes through the native path", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const uri = await resources.artifacts.forTool("mcp_test").put(PNG_BYTES, { mediaType: "image/png" });

    expect((await readAndProject(tool, uri)).output.type).toBe("content");
  });
});

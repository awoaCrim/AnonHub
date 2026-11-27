import { asSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHtmlRenderTool, RenderFileError, workspaceRelativePath, type WorkspaceFileReader } from "../src/html-render.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXYsAAAAASUVORK5CYII=", "base64"));
const uri = "artifact://render_html/report.png";

function fixture(reader?: WorkspaceFileReader) {
  const put = vi.fn(async () => uri);
  const forTool = vi.fn(() => ({ put }));
  const resources = {
    maxBytes: 5 * 1024 * 1024,
    artifacts: { forTool },
    detectImageMediaType: vi.fn((bytes: Uint8Array) => (Buffer.from(bytes).equals(Buffer.from(PNG)) ? "image/png" : undefined)),
  };
  const request = vi.fn(async () => new Response(PNG, { headers: { "Content-Type": "image/png" } }));
  vi.stubGlobal("fetch", request);
  const tool = createHtmlRenderTool("http://renderer.internal/render", resources as never, reader);
  return { tool, resources, put, forTool, request };
}

const execution = { turnId: "turn", toolCallId: "call", messages: [] } as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("render_html", () => {
  // Preview records, 2026-11-20: told to write long HTML into a file first, a scheduled group turn (no admin, so no file
  // tools) delegated the page to a background task, which could not write it either.
  it("takes the whole HTML directly and asks the bot to render it itself", () => {
    const { description } = fixture().tool;
    expect(description).toContain("把完整 HTML 直接传给 html，不必先写文件");
    expect(description).toContain("不要委派后台任务");
  });

  it("stores a PNG in the current channel and returns a send_message image element", async () => {
    const f = fixture();
    const html = '<!doctype html><meta charset="utf-8"><h1>AI 每日早报</h1>';
    const result = await f.tool.execute({ html }, execution);
    expect(f.request).toHaveBeenCalledWith(
      new URL("http://renderer.internal/render"),
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        body: JSON.stringify({ html, width: 1000 }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(f.forTool).toHaveBeenCalledWith("render_html");
    expect(f.put).toHaveBeenCalledWith(Buffer.from(PNG), { mediaType: "image/png", filename: "report.png" });
    expect(result).toEqual({ ok: true, uri, mediaType: "image/png", byteLength: PNG.byteLength, sendMessageMarkup: `<img src="${uri}"/>` });
  });

  it.each(["", " ", "中".repeat(70_000)])("rejects empty or oversized HTML before requesting the renderer", async (html) => {
    const f = fixture();
    expect(await f.tool.execute({ html }, execution)).toEqual({ ok: false, error: "invalid_html" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([479, 1441, 700.5])("rejects an invalid width (%s)", async (width) => {
    const f = fixture();
    expect(await f.tool.execute({ html: "<h1>test</h1>", width }, execution)).toEqual({ ok: false, error: "invalid_width" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects unsafe configured renderer URLs", () => {
    const f = fixture();
    for (const url of ["file:///etc/passwd", "http://user:password@example.com/render"]) {
      expect(() => createHtmlRenderTool(url, f.resources as never)).toThrow("workspace_html_renderer_url_invalid");
    }
  });

  it("reports renderer HTTP errors without claiming an image exists", async () => {
    const f = fixture();
    f.request.mockResolvedValue(new Response("unavailable", { status: 503 }));
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "renderer_http_503" });
    expect(f.put).not.toHaveBeenCalled();
  });

  it.each(["text/html", "image/jpeg"])("rejects a non-PNG response (%s)", async (mediaType) => {
    const f = fixture();
    f.request.mockResolvedValue(new Response(PNG, { headers: { "Content-Type": mediaType } }));
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "invalid_renderer_image" });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("rejects invalid PNG data even when the content type claims PNG", async () => {
    const f = fixture();
    f.request.mockResolvedValue(new Response("not an image", { headers: { "Content-Type": "image/png" } }));
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "invalid_renderer_image" });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("bounds the response stream before persisting an image", async () => {
    const f = fixture();
    f.resources.maxBytes = PNG.byteLength - 1;
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "renderer_image_too_large" });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("does not request the renderer after the turn was aborted", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, { abortSignal: controller.signal } as never)).toEqual({ ok: false, error: "aborted" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("reports artifact persistence failures instead of inventing an image URI", async () => {
    const f = fixture();
    f.put.mockRejectedValue(new Error("disk error"));
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "html_render_failed" });
  });

  it("renders a workspace file given by path, sending its content as html", async () => {
    const html = '<!doctype html><meta charset="utf-8"><h1>日报</h1>';
    const reader = vi.fn(async () => new TextEncoder().encode(html));
    const f = fixture(reader);
    const result = await f.tool.execute({ path: "./reports/daily.html", width: 1200 }, execution);
    expect(reader).toHaveBeenCalledWith("reports/daily.html", { signal: expect.any(AbortSignal), maxBytes: 200_000, messages: [] });
    expect(f.request).toHaveBeenCalledWith(
      new URL("http://renderer.internal/render"),
      expect.objectContaining({ body: JSON.stringify({ html, width: 1200 }) }),
    );
    expect(result).toMatchObject({ ok: true, uri });
  });

  it.each([{}, { html: "<h1>x</h1>", path: "report.html" }])("requires exactly one of html and path: %j", async (input) => {
    const f = fixture(vi.fn());
    expect(await f.tool.execute(input as never, execution)).toMatchObject({ ok: false, error: "html_or_path_required" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("offers path only where a workspace can be read", async () => {
    const without = fixture();
    expect(Object.keys(((await asSchema(without.tool.inputSchema).jsonSchema) as { properties: object }).properties)).toEqual(["html", "width"]);
    expect(await without.tool.execute({ path: "report.html" }, execution)).toMatchObject({ ok: false, error: "path_unavailable" });
    const withReader = fixture(vi.fn());
    expect(Object.keys(((await asSchema(withReader.tool.inputSchema).jsonSchema) as { properties: object }).properties)).toEqual(["html", "path", "width"]);
  });

  it.each(["../secret.html", "/etc/passwd", "reports/../../x.html", "a//b.html", "/home/workspace", "dir\\x.html", "a\0.html", ""])(
    "refuses a path outside the workspace before reading (%j)",
    async (path) => {
      const reader = vi.fn();
      const f = fixture(reader);
      expect(await f.tool.execute({ path }, execution)).toMatchObject({ ok: false, error: "invalid_path" });
      expect(reader).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("accepts the forms the file tools use for the same file", () => {
    for (const path of ["report.html", "./report.html", "/home/workspace/report.html", "workspace:///report.html"])
      expect(workspaceRelativePath(path)).toBe("report.html");
    expect(workspaceRelativePath("日报/今天.html")).toBe("日报/今天.html");
  });

  it.each(["file_not_found", "html_file_too_large", "invalid_path", "file_unavailable"] as const)(
    "reports a workspace read failure (%s) without rendering",
    async (code) => {
      const f = fixture(vi.fn(async () => Promise.reject(new RenderFileError(code))));
      expect(await f.tool.execute({ path: "report.html" }, execution)).toEqual({ ok: false, error: code });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("rejects a file that is not UTF-8 text or is empty", async () => {
    const binary = fixture(vi.fn(async () => Uint8Array.from([0xff, 0xfe, 0x00])));
    expect(await binary.tool.execute({ path: "a.html" }, execution)).toMatchObject({ ok: false, error: "invalid_html" });
    const empty = fixture(vi.fn(async () => new Uint8Array()));
    expect(await empty.tool.execute({ path: "a.html" }, execution)).toMatchObject({ ok: false, error: "invalid_html" });
    expect(binary.request).not.toHaveBeenCalled();
    expect(empty.request).not.toHaveBeenCalled();
  });
});

import type { AgentMessage, AgentTool } from "@yesimbot/agent-runtime";
import { AppError, httpFetch } from "@yesimbot/foundation";
import type { ChannelResources } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { WORKSPACE_ERRORS } from "./errors.js";
import { DEFAULT_WORKSPACE_MOUNT } from "./mounts.js";

const MAX_HTML_BYTES = 200_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const RENDER_TIMEOUT_MS = 30_000;

const HTML = z.string().min(1).max(MAX_HTML_BYTES).describe("完整 HTML 文档，包含 UTF-8 声明和内联样式；正文总大小不超过 200 KB");

const WIDTH = z.int().min(480).max(1440).describe("截图宽度，默认 1000 像素；高度按页面内容自动确定，最多 8000 像素").optional();

/** With a workspace file reader the HTML may come from a file, so `html` is optional. */
const RENDER_FROM_FILE_SCHEMA = z.strictObject({
  html: HTML.optional(),
  path: z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .describe("当前会话工作区内的 HTML 文件，与文件工具相同的相对路径（如 report.html）；文件不超过 200 KB，UTF-8")
    .optional(),
  width: WIDTH,
});

const RENDER_HTML_SCHEMA = z.strictObject({ html: HTML, width: WIDTH });

/**
 * Reads one file of the conversation workspace (the one the file tools use), given a path relative to its root.
 * It refuses a path or link that leaves the workspace (`invalid_path`) and a file above `maxBytes`.
 */
export type WorkspaceFileReader = (
  relativePath: string,
  options: { signal: AbortSignal; maxBytes: number; messages: readonly AgentMessage[] },
) => Promise<Uint8Array>;

type HtmlRenderInput = z.infer<typeof RENDER_FROM_FILE_SCHEMA>;

type HtmlRenderOutput =
  | { ok: true; uri: string; mediaType: "image/png"; byteLength: number; sendMessageMarkup: string }
  | { ok: false; error: string; message?: string };

type RenderResources = Pick<ChannelResources, "artifacts" | "maxBytes" | "detectImageMediaType">;

/** Why a workspace HTML file could not be read; the tool reports the code. */
export class RenderFileError extends Error {
  constructor(readonly code: "invalid_path" | "file_not_found" | "html_file_too_large" | "file_unavailable") {
    super(code);
  }
}

/**
 * A workspace file path as the file tools write it: relative (`report.html`, `./reports/a.html`), under the
 * workspace mount (`/home/workspace/report.html`) or as a `workspace:///` reference. Anything else, including
 * `..` segments and other absolute paths, is not in the workspace.
 */
export function workspaceRelativePath(path: string): string | undefined {
  if (!path || path.length > MAX_PATH_LENGTH || path.includes("\0") || path.includes("\\")) return undefined;
  let relative = path;
  if (relative.startsWith("workspace:///")) relative = relative.slice("workspace:///".length);
  else if (relative.startsWith(`${DEFAULT_WORKSPACE_MOUNT}/`)) relative = relative.slice(DEFAULT_WORKSPACE_MOUNT.length + 1);
  else if (relative.startsWith("/")) return undefined;
  const segments = relative.split("/").filter((segment, index) => !(segment === "." && index === 0));
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return segments.join("/");
}

export function createHtmlRenderTool(
  url: string,
  resources: RenderResources,
  readWorkspaceFile?: WorkspaceFileReader,
): AgentTool<HtmlRenderInput, HtmlRenderOutput> {
  const endpoint = new URL(url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new AppError(WORKSPACE_ERRORS.workspace_html_renderer_url_invalid, { effect: "none" });
  }
  return {
    name: "render_html",
    description:
      "将完整 HTML 文档与内联 CSS 在独立浏览器中渲染为 PNG，不操作用户桌面，不执行脚本或加载外部资源。html 和 path 二选一：HTML 已经在当前会话工作区的文件里就传 path（如 report.html）；否则把完整 HTML 直接传给 html，不必先写文件。渲染一两次就能完成，自己直接做，不要委派后台任务，也不要把 HTML 抄进委派说明。返回当前频道的图片 URI 和 sendMessageMarkup；这不是发送回执。要发出图片，用 send_message 的 parts 发送一个 kind:text 单元，text 为该 sendMessageMarkup 原文，使用默认 element 模式解析为图片；不能把 HTML、URI 或文字正文当作图片交付。",
    inputSchema: (readWorkspaceFile ? RENDER_FROM_FILE_SCHEMA : RENDER_HTML_SCHEMA) as z.ZodType<HtmlRenderInput>,
    execute: async (input, execution) => {
      const hasHtml = input?.html !== undefined,
        hasPath = input?.path !== undefined;
      if (hasHtml === hasPath)
        return { ok: false, error: "html_or_path_required", message: "html 和 path 必须且只能提供一个：完整 HTML 传 html，工作区里已有的 HTML 文件传 path。" };
      const width = input.width ?? 1000;
      if (!Number.isSafeInteger(width) || width < 480 || width > 1440) return { ok: false, error: "invalid_width" };
      const signal = AbortSignal.any([AbortSignal.timeout(RENDER_TIMEOUT_MS), ...(execution.abortSignal ? [execution.abortSignal] : [])]);
      let html: string;
      if (hasHtml) html = input.html!;
      else {
        if (!readWorkspaceFile) return { ok: false, error: "path_unavailable", message: "当前会话没有可读的工作区，请改用 html。" };
        const relative = typeof input.path === "string" ? workspaceRelativePath(input.path) : undefined;
        if (!relative) return { ok: false, error: "invalid_path", message: "path 只能是当前会话工作区内的相对路径。" };
        try {
          const bytes = await readWorkspaceFile(relative, { signal, maxBytes: MAX_HTML_BYTES, messages: execution.messages ?? [] });
          if (bytes.byteLength > MAX_HTML_BYTES) return { ok: false, error: "html_file_too_large" };
          html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (error) {
          if (error instanceof RenderFileError) return { ok: false, error: error.code };
          if (error instanceof TypeError) return { ok: false, error: "invalid_html", message: "文件不是 UTF-8 文本。" };
          return { ok: false, error: execution.abortSignal?.aborted ? "aborted" : signal.aborted ? "renderer_timeout" : "file_unavailable" };
        }
      }
      if (typeof html !== "string" || !html.trim() || Buffer.byteLength(html) > MAX_HTML_BYTES) {
        return { ok: false, error: "invalid_html" };
      }
      try {
        signal.throwIfAborted();
        // The renderer is the operator's own service (a sidecar or a public one): no address restriction, no redirects.
        const response = await httpFetch(endpoint, {
          purpose: "public",
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ html, width }),
          timeoutMs: RENDER_TIMEOUT_MS,
          maxBytes: MAX_IMAGE_BYTES,
          maxRedirects: 0,
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return { ok: false, error: `renderer_http_${response.status}` };
        }
        if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/png" || !response.body) {
          await response.body?.cancel();
          return { ok: false, error: "invalid_renderer_image" };
        }
        const maxBytes = Math.min(resources.maxBytes, MAX_IMAGE_BYTES);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            byteLength += value.byteLength;
            if (byteLength > maxBytes) {
              await reader.cancel();
              return { ok: false, error: "renderer_image_too_large" };
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks, byteLength);
        if (resources.detectImageMediaType(bytes) !== "image/png") return { ok: false, error: "invalid_renderer_image" };
        signal.throwIfAborted();
        const uri = await resources.artifacts.forTool("render_html").put(bytes, { mediaType: "image/png", filename: "report.png" });
        return { ok: true, uri, mediaType: "image/png", byteLength, sendMessageMarkup: `<img src="${uri}"/>` };
      } catch (cause) {
        // The shared client's own limits: a declared or streamed body past the size limit, and its timeout.
        if (cause instanceof AppError && cause.code === "network_response_too_large") return { ok: false, error: "renderer_image_too_large" };
        if (cause instanceof AppError && cause.code === "network_timeout") return { ok: false, error: "renderer_timeout" };
        return { ok: false, error: execution.abortSignal?.aborted ? "aborted" : signal.aborted ? "renderer_timeout" : "html_render_failed" };
      }
    },
  };
}

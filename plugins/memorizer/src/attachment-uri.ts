import type { MemoryAttachment } from "./types.js";

/** Shown in `read`'s list of resource schemes. */
export const MEMORY_SCHEME_PROMPT =
  "memory://<记忆ID>/<序号> 是记忆带着的图片或文件（recall 结果的 attachments）。只在能看到那条记忆的会话里读得到；可以用 read 查看、放进 generate_image 的 referenceUris，或作为 img/file 的 src 发出去。";

const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a kept picture or file is read, generated from, or sent again wherever its memory is visible. */
export function attachmentUri(memoryId: string, attachment: Pick<MemoryAttachment, "index">): string {
  return `memory://${memoryId}/${attachment.index}`;
}

/** The memory and attachment a `memory://<uuid>/<index>` URI names, or undefined for anything else. */
export function parseAttachmentUri(uri: URL): { memoryId: string; index: number } | undefined {
  const index = /^\/([1-9]\d{0,5})$/.exec(uri.pathname)?.[1];
  return uri.protocol === "memory:" && MEMORY_ID.test(uri.hostname) && index ? { memoryId: uri.hostname, index: Number(index) } : undefined;
}

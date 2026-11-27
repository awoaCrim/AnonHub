import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { AppError, httpFetch } from "@yesimbot/foundation";

import { MEDIA_ERRORS, type MediaFetcher, type MediaKind } from "./input.js";

const DATA_URL = /^data:([^;,]+)(;base64)?,([\s\S]*)$/;
const BASE64_URL = /^base64:\/\/([\s\S]*)$/;
/** Content types that carry no signal about the real payload; the checks after download stay authoritative. */
const AMBIGUOUS_TYPES: readonly string[] = ["application/octet-stream", "binary/octet-stream", "application/unknown"];
const BINARY_KINDS: readonly string[] = ["image", "audio", "video", "font"];

/**
 * Downloads a media source the way chat platforms give it: `data:` and `base64://` inline, `file:` on this machine
 * (NapCat's downloads), and http(s) from the platform's own servers, which are known public services (convention 05).
 * Shared by the connectors of `apps/server`.
 */
export const fetchPlatformMedia: MediaFetcher = async ({ src, kind }, { maxBytes, signal, timeoutMs, onStage }) => {
  const inline = decodeDataUrl(src, maxBytes) ?? decodeBase64Url(src, maxBytes);
  if (inline) return inline;
  signal.throwIfAborted();
  if (src.startsWith("file:")) return loadLocalFile(src, signal, maxBytes);
  onStage?.("headers");
  // HEAD can consume the entire deadline. Validate the streamed GET itself instead.
  const response = await httpFetch(src, { purpose: "public", timeoutMs, maxBytes, signal });
  try {
    signal.throwIfAborted();
    if (response.status >= 400) throw new AppError(MEDIA_ERRORS.media_download_failed, { effect: "none", detail: `status ${response.status}` });
    const rawType = response.headers.get("content-type");
    const type = rawType === null ? null : rawType.split(";")[0]!.trim().toLowerCase();
    if (!matchesKind(type, kind))
      throw new AppError(
        kind === "image" ? MEDIA_ERRORS.media_not_image : kind === "video" ? MEDIA_ERRORS.media_not_video : MEDIA_ERRORS.media_download_failed,
        {
          effect: "none",
        },
      );
  } catch (cause) {
    void response.cancel().catch(() => undefined);
    throw cause;
  }
  onStage?.("body");
  return readBody(response.body, signal);
};

function matchesKind(type: string | null, kind: MediaKind): boolean {
  if (type === null) return true;
  if (kind === "image") return type.startsWith("image/") || AMBIGUOUS_TYPES.includes(type);
  if (kind === "video") return type === "video/mp4" || type === "application/mp4" || AMBIGUOUS_TYPES.includes(type);
  return !BINARY_KINDS.some((prefix) => type.startsWith(`${prefix}/`));
}

async function loadLocalFile(src: string, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
  const path = fileURLToPath(src);
  const entry = await stat(path);
  if (entry.size > maxBytes) throw new AppError(MEDIA_ERRORS.media_too_large, { effect: "none" });
  signal.throwIfAborted();
  const data = new Uint8Array(await readFile(path, { signal }));
  if (data.byteLength > maxBytes) throw new AppError(MEDIA_ERRORS.media_too_large, { effect: "none" });
  return data;
}

/** The body `httpFetch` already bounds; an abort cancels the pending read, which then must not count as the end. */
async function readBody(stream: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function decodeDataUrl(src: string, maxBytes: number): Uint8Array | null {
  const match = DATA_URL.exec(src);
  if (!match) return null;
  const [, _mime, base64, payload] = match;
  // Bound encoded input before decoding; canonical padding must not reject an exact byte limit.
  // The observed-byte check below still enforces the unchanged image/text/video allowance.
  if (base64 && payload!.length > Math.ceil(maxBytes / 3) * 4) throw new AppError(MEDIA_ERRORS.media_too_large, { effect: "none" });
  if (!base64 && payload!.length > maxBytes) throw new AppError(MEDIA_ERRORS.media_too_large, { effect: "none" });
  const decoded = base64 ? new Uint8Array(Buffer.from(payload!, "base64")) : new TextEncoder().encode(decodeURIComponent(payload!));
  if (decoded.byteLength > maxBytes) throw new AppError(MEDIA_ERRORS.media_too_large, { effect: "none" });
  return decoded;
}

function decodeBase64Url(src: string, maxBytes: number): Uint8Array | null {
  const match = BASE64_URL.exec(src);
  if (!match) return null;
  const payload = match[1]!;
  if (payload.length > Math.ceil(maxBytes / 3) * 4) throw new AppError(MEDIA_ERRORS.media_too_large, { effect: "none" });
  const decoded = new Uint8Array(Buffer.from(payload, "base64"));
  if (decoded.byteLength > maxBytes) throw new AppError(MEDIA_ERRORS.media_too_large, { effect: "none" });
  return decoded;
}

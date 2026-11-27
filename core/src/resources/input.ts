import type { FilePart, ImagePart, Part, VideoPart } from "@yesimbot/contracts/parts";
import { AppError, defineErrors, detectImageType, logger, systemClock } from "@yesimbot/foundation";

import type { AssetStore } from "./asset.js";
import { isFileFailureCode, type FileFailureCode } from "./file-failure.js";
import { isImageFailureCode, type ImageFailureCode } from "./image-failure.js";
import { isVideoFailureCode, type VideoFailureCode } from "./video-failure.js";
import { detectVideoMediaType, VIDEO_SOURCE_MAX_BYTES } from "./video-media.js";

/** Why a connector could not hand over a media source; Core turns each into the part's failure reason. */
export const MEDIA_ERRORS = defineErrors({
  media_timeout: { model: "媒体下载超时。", user: "媒体下载超时。", status: 504, retryable: true },
  media_too_large: { model: "媒体超过大小上限。", user: "媒体超过大小上限。", status: 413 },
  media_not_image: { model: "下载到的不是图片。", user: "下载到的不是图片。", status: 415 },
  media_not_video: { model: "下载到的不是视频。", user: "下载到的不是视频。", status: 415 },
  media_download_failed: { model: "媒体下载失败。", user: "媒体下载失败。", status: 502, retryable: true },
});
const MAX_IMAGES = 4;
const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;
const MAX_FILES = 2;
/** One bounded native video per persistence call; its budget is separate from the image/text pool. */
const MAX_VIDEOS = 1;

/** 1 MiB of UTF-8 text already exceeds the read tool's character truncation; larger is useless to the model. */
const MAX_BYTES_PER_FILE = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const RESOURCE_TIMEOUT_MS = 10_000;

/** Cheap pre-filter so a large binary is never downloaded; the UTF-8 check after download is authoritative. */
/* prettier-ignore */
const TEXT_FILE_EXTENSIONS: readonly string[] = [ "txt", "md", "markdown", "rst", "log", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml", "ini", "conf", "env", "properties", "xml", "html", "htm", "css", "svg", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "py", "rb", "rs", "go", "java", "kt", "kts", "scala", "swift", "c", "h", "cpp", "cc", "hpp", "cs", "php", "lua", "pl", "r", "m", "sh", "bash", "zsh", "fish", "ps1", "bat", "sql", "graphql", "proto", "patch", "diff", "pem", "key", "pub", "crt", "cer", "csr" ] as const;

/** Pictures a model can look at. QQ sends a picture as a file when it goes through 「文件」, often to keep the original. */
const IMAGE_FILE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "gif", "webp"];
const ASSET_ID = /^[a-f0-9]{32}$/;
const clock = systemClock();
const log = logger("yesimbot.resources");

/** What the bytes must be: a picture, an MP4, or a UTF-8 text file. */
export type MediaKind = "image" | "video" | "text";

/** How far a remote download got, for the failure log. */
export type MediaStage = "headers" | "body";

/**
 * The connector's download of a media source it put in a part (convention 09, rule 8). It returns at most `maxBytes`
 * bytes and throws an `AppError`: `MEDIA_ERRORS`, or the `network_*` errors of `httpFetch`.
 */
export type MediaFetcher = (source: MediaSource, options: MediaFetchOptions) => Promise<Uint8Array>;

type MediaFailureCode = ImageFailureCode | VideoFailureCode | FileFailureCode;

export interface MediaSource {
  readonly src: string;
  readonly kind: MediaKind;
}

export interface MediaFetchOptions {
  readonly maxBytes: number;
  /** Aborted at Core's deadline; the bytes are then discarded. */
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly onStage?: (stage: MediaStage) => void;
}

interface ResourceBudget {
  images: number;
  files: number;
  videos: number;
  bytes: number;
  videoBytes: number;
}

interface PersistJob {
  readonly store: AssetStore;
  readonly budget: ResourceBudget;
  readonly videoInput: boolean;
  readonly fetchMedia: MediaFetcher;
  readonly timeoutMs: number;
}

/**
 * Stores the inbound pictures, native video and restricted text files of `parts` as channel assets while their sources
 * are live, and drops every source: a stored part keeps its asset ID, a failed one its reason.
 */
export async function persistParts(
  parts: readonly Part[],
  resources: { readonly assets: AssetStore; readonly videoInput?: boolean },
  fetchMedia: MediaFetcher,
  timeoutMs = RESOURCE_TIMEOUT_MS,
): Promise<Part[]> {
  const job: PersistJob = {
    store: resources.assets,
    budget: { images: 0, files: 0, videos: 0, bytes: 0, videoBytes: 0 },
    videoInput: resources.videoInput === true,
    fetchMedia,
    timeoutMs,
  };
  const prepared = await Promise.all(parts.map((part) => persistPart(part, job)));
  const imageCount = countParts(prepared, "image");
  const fileCount = countParts(prepared, "file");
  const videoCount = countParts(prepared, "video");
  if (imageCount || fileCount || videoCount) log.debug("resources.input.persisted", { imageCount, fileCount, videoCount });
  return prepared;
}

async function persistPart(part: Part, job: PersistJob): Promise<Part> {
  if (part.type === "image") return storeImage(part, job);
  if (part.type === "video") return storeVideo(part, job);
  if (part.type === "file") {
    if (part.title && hasExtension(part.title, IMAGE_FILE_EXTENSIONS)) return storeImageFile(part, part.title, job);
    return storeTextFile(part, job);
  }
  if ((part.type === "quote" || part.type === "platform") && part.parts.length > 0)
    return { ...part, parts: await Promise.all(part.parts.map((child) => persistPart(child, job))) };
  return part;
}

async function storeImage(part: ImagePart, job: PersistJob): Promise<Part> {
  if (part.asset && ASSET_ID.test(part.asset)) return withoutSource(part);
  const source = part.src;
  if (typeof source !== "string" || source.trim().length === 0) return failedImage("missing_source");
  const { budget } = job;
  if (budget.images >= MAX_IMAGES) return failedImage("image_limit");
  budget.images += 1;
  const remaining = MAX_TOTAL_BYTES - budget.bytes;
  if (remaining <= 0) return failedImage("total_size_limit");

  const loaded = await download(job, source, "image", Math.min(MAX_BYTES_PER_IMAGE, remaining));
  if (typeof loaded === "string") return failedImage(isImageFailureCode(loaded) ? loaded : "download_failed");
  if (budget.bytes + loaded.byteLength > MAX_TOTAL_BYTES) return failedImage("total_size_limit");

  // Reserve the bytes before awaiting the store so concurrent parts cannot exceed the total.
  budget.bytes += loaded.byteLength;
  let id: string;
  try {
    id = await job.store.put(loaded);
  } catch {
    budget.bytes -= loaded.byteLength;
    return failedImage("save_failed");
  }
  return {
    type: "image",
    asset: id,
    ...(part.subtype === undefined ? {} : { subtype: part.subtype }),
    ...(part.summary === undefined ? {} : { summary: part.summary }),
  };
}

function failedImage(code: ImageFailureCode): ImagePart {
  return { type: "image", failure: code };
}

/**
 * Persists one valid MP4 as an immutable channel asset while its platform source is live. The stored part carries only
 * the asset id, so history never retains a temporary source. When native video input is disabled the part keeps its
 * kind but loses its source too.
 */
async function storeVideo(part: VideoPart, job: PersistJob): Promise<VideoPart> {
  if (part.asset && ASSET_ID.test(part.asset)) return { type: "video", asset: part.asset };
  const source = part.src;
  if (!job.videoInput) return failedVideo("video_input_unavailable");
  if (typeof source !== "string" || source.trim().length === 0) return failedVideo("missing_source");
  const { budget } = job;
  if (budget.videos >= MAX_VIDEOS) return failedVideo("video_limit");
  budget.videos += 1;
  const remaining = VIDEO_SOURCE_MAX_BYTES - budget.videoBytes;
  if (remaining <= 0) return failedVideo("total_size_limit");

  const loaded = await download(job, source, "video", Math.min(VIDEO_SOURCE_MAX_BYTES, remaining));
  if (typeof loaded === "string") return failedVideo(isVideoFailureCode(loaded) ? loaded : "download_failed");
  if (budget.videoBytes + loaded.byteLength > VIDEO_SOURCE_MAX_BYTES) return failedVideo("too_large");
  if (!detectVideoMediaType(loaded)) return failedVideo("not_video");

  // Reserve the bytes before awaiting the store so concurrent parts cannot exceed the pool.
  budget.videoBytes += loaded.byteLength;
  let id: string;
  try {
    id = await job.store.put(loaded);
  } catch {
    budget.videoBytes -= loaded.byteLength;
    return failedVideo("save_failed");
  }
  return { type: "video", asset: id };
}

function failedVideo(code: VideoFailureCode): VideoPart {
  return { type: "video", failure: code };
}

async function storeTextFile(part: FilePart, job: PersistJob): Promise<FilePart> {
  if (part.asset && ASSET_ID.test(part.asset)) return withoutSource(part);
  const filename = part.title;
  const failed = (code: FileFailureCode): FilePart => ({ type: "file", ...(filename ? { title: filename } : {}), failure: code });
  if (isFileFailureCode(part.failure)) return failed(part.failure);
  if (!filename) return failed("missing_filename");
  if (!hasExtension(filename, TEXT_FILE_EXTENSIONS)) return failed("unsupported_type");
  const source = part.src;
  if (typeof source !== "string" || !source.trim()) return failed("missing_source");
  const { budget } = job;
  if (budget.files >= MAX_FILES) return failed("file_limit");
  budget.files += 1;
  const remaining = MAX_TOTAL_BYTES - budget.bytes;
  if (remaining <= 0) return failed("total_size_limit");

  const loaded = await download(job, source, "text", Math.min(MAX_BYTES_PER_FILE, remaining));
  if (typeof loaded === "string") return failed(isFileFailureCode(loaded) ? loaded : "download_failed");
  if (budget.bytes + loaded.byteLength > MAX_TOTAL_BYTES) return failed("total_size_limit");
  if (!isUtf8Text(loaded)) return failed("not_text");
  budget.bytes += loaded.byteLength;
  try {
    return { type: "file", asset: await job.store.put(loaded), title: filename };
  } catch {
    budget.bytes -= loaded.byteLength;
    return failed("save_failed");
  }
}

/**
 * A picture sent as a file becomes an image the model sees, named after the file (user, 2026-11-19: 「qq上文件类型的图片bot
 * 看不了」; only text files were read). It counts against the image limits; bytes that are no picture leave an unread file.
 */
async function storeImageFile(part: FilePart, filename: string, job: PersistJob): Promise<Part> {
  if (part.asset && ASSET_ID.test(part.asset)) return withoutSource(part);
  const failed = (code: FileFailureCode): FilePart => ({ type: "file", title: filename, failure: code });
  if (isFileFailureCode(part.failure)) return failed(part.failure);
  const source = part.src;
  if (typeof source !== "string" || !source.trim()) return failed("missing_source");
  const { budget } = job;
  if (budget.images >= MAX_IMAGES) return failed("file_limit");
  budget.images += 1;
  const remaining = MAX_TOTAL_BYTES - budget.bytes;
  if (remaining <= 0) return failed("total_size_limit");

  const loaded = await download(job, source, "image", Math.min(MAX_BYTES_PER_IMAGE, remaining));
  if (typeof loaded === "string") return failed(isFileFailureCode(loaded) ? loaded : "download_failed");
  if (budget.bytes + loaded.byteLength > MAX_TOTAL_BYTES) return failed("total_size_limit");
  if (!detectImageType(loaded)) return failed("not_image");
  budget.bytes += loaded.byteLength;
  try {
    return { type: "image", asset: await job.store.put(loaded), title: filename };
  } catch {
    budget.bytes -= loaded.byteLength;
    return failed("save_failed");
  }
}

function withoutSource<T extends ImagePart | FilePart>(part: T): T {
  const { src: _src, ...rest } = part;
  return rest as T;
}

function hasExtension(filename: string, extensions: readonly string[]): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return false;
  return extensions.includes(filename.slice(dot + 1).toLowerCase());
}

function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    return !bytes.includes(0) && new TextDecoder("utf-8", { fatal: true }).decode(bytes).length > 0;
  } catch {
    return false;
  }
}

/** The connector's bytes, or the failure reason; Core's own deadline bounds the whole download. */
async function download(job: PersistJob, src: string, kind: MediaKind, maxBytes: number): Promise<Uint8Array | MediaFailureCode> {
  const controller = new AbortController();
  const startedAt = clock.now();
  let stage: "source" | MediaStage = "source";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new AppError(MEDIA_ERRORS.media_timeout, { effect: "none" });
      controller.abort(error);
      reject(error);
    }, job.timeoutMs);
  });
  try {
    const data = await Promise.race([
      job.fetchMedia({ src, kind }, { maxBytes, signal: controller.signal, timeoutMs: job.timeoutMs, onStage: (next) => void (stage = next) }),
      deadline,
    ]);
    controller.signal.throwIfAborted();
    if (data.byteLength > maxBytes) throw new AppError(MEDIA_ERRORS.media_too_large, { effect: "none" });
    return data;
  } catch (cause) {
    const code = controller.signal.aborted ? "timeout" : failureCode(cause);
    log.warn("resources.input.failed", { kind, stage, code, elapsedMs: clock.now() - startedAt, timeoutMs: job.timeoutMs });
    return code;
  } finally {
    clearTimeout(timeout);
  }
}

function failureCode(cause: unknown): MediaFailureCode {
  if (!(cause instanceof AppError)) return "download_failed";
  switch (cause.code) {
    case MEDIA_ERRORS.media_timeout:
    case "network_timeout":
      return "timeout";
    case MEDIA_ERRORS.media_too_large:
    case "network_response_too_large":
      return "too_large";
    case MEDIA_ERRORS.media_not_image:
      return "not_image";
    case MEDIA_ERRORS.media_not_video:
      return "not_video";
    default:
      return "download_failed";
  }
}

function countParts(parts: readonly Part[], type: Part["type"]): number {
  let count = 0;
  const visit = (part: Part): void => {
    if (part.type === type) count += 1;
    if (part.type === "quote" || part.type === "platform") for (const child of part.parts) visit(child);
  };
  for (const part of parts) visit(part);
  return count;
}

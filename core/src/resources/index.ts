import { URL } from "node:url";

import type { FilePart, ImagePart, Part } from "@yesimbot/contracts/parts";
import { AppError, detectImageType } from "@yesimbot/foundation";

import { CHANNEL_ERRORS } from "../channels/errors.js";
import type { ChannelContext } from "../channels/index.js";
import { ChannelArtifactStore, type ArtifactStore } from "./artifact.js";
import { ChannelAssetStore, type AssetStore } from "./asset.js";
import { RESOURCE_ERRORS, resourceError, resourceErrorCode } from "./errors.js";
import { persistParts, type MediaFetcher } from "./input.js";
import { detectVideoMediaType, VIDEO_SOURCE_MAX_BYTES } from "./video-media.js";

export const RESOURCE_MAX_BYTES = 5 * 1024 * 1024;

const COMPLETE_ASSET_ID = /^[a-f0-9]{32}$/;

const URI_SHAPE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)(?:\/([^?#]*))?$/;

const RESOURCE_SOURCE = /^(asset|artifact|workspace):\/\//;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  pdf: "application/pdf",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

export type Disposer = () => void;

export interface ResourceOpenOptions {
  /** Trusted current-turn senders. Never taken from a resource URI or model input. */
  readonly actorIds?: readonly string[];
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

export interface ResourceOpenResult {
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
  readonly filename?: string;
}

export interface ResourceReader {
  readonly scheme: string;
  readonly prompt: string;
  setup(resources: ChannelResources, uri: URL, options: ResourceOpenOptions): Promise<ResourceOpenResult>;
}

export interface Resources {
  get(ctx: ChannelContext): Promise<ChannelResources>;
  use(reader: ResourceReader): Disposer;
}

export class ChannelResources {
  public readonly assets: AssetStore;
  public readonly artifacts: ArtifactStore;
  public readonly maxBytes = RESOURCE_MAX_BYTES;

  private readonly readers = new Map<string, ResourceReader>();

  public constructor(
    public readonly path: string,
    public readonly imageInput = false,
    private readonly readTimeoutMs = 10_000,
    public readonly videoInput = false,
  ) {
    this.assets = new ChannelAssetStore(path);
    this.artifacts = new ChannelArtifactStore(path);
  }

  public async open(uri: string, signal?: AbortSignal, actorIds?: readonly string[]): Promise<ResourceOpenResult | undefined> {
    try {
      return await this.openStrict(uri, signal, actorIds);
    } catch (cause) {
      if (resourceErrorCode(cause)) return undefined;
      throw cause;
    }
  }

  /** Strict raw-open used by tool factories: throws a typed error instead of collapsing to undefined. */
  public async openStrict(uri: string, signal?: AbortSignal, actorIds?: readonly string[]): Promise<ResourceOpenResult> {
    const parsed = parseUri(uri);
    if (!parsed) throw resourceError(RESOURCE_ERRORS.resource_uri_invalid);

    try {
      if (parsed.protocol === "asset:") {
        if (!COMPLETE_ASSET_ID.test(parsed.hostname) || parsed.pathname !== "") throw resourceError(RESOURCE_ERRORS.resource_uri_invalid);
        return normalize({ bytes: await this.readAssetBounded(parsed.hostname, RESOURCE_MAX_BYTES, signal) });
      }
      if (parsed.protocol === "artifact:") {
        if (!parsed.hostname || parsed.pathname === "/") throw resourceError(RESOURCE_ERRORS.resource_uri_invalid);
        try {
          return normalize(await this.artifacts.open(uri));
        } catch (cause) {
          throw resourceError(RESOURCE_ERRORS.resource_not_found, { cause });
        }
      }
      if (parsed.protocol === "workspace:" && parsed.hostname) throw resourceError(RESOURCE_ERRORS.resource_uri_invalid);
      if (parsed.pathname === "" || parsed.pathname === "/") throw resourceError(RESOURCE_ERRORS.resource_uri_invalid);

      const reader = this.readers.get(parsed.protocol.slice(0, -1));
      if (!reader) throw resourceError(RESOURCE_ERRORS.resource_unavailable);
      return await this.openReader(reader, parsed, signal, actorIds);
    } catch (cause) {
      if (resourceErrorCode(cause)) throw cause;
      throw resourceError(RESOURCE_ERRORS.resource_read_failed, { cause });
    }
  }

  /**
   * Opens exactly one complete channel asset id as valid MP4 bytes under the narrow video budget.
   * This never lends the video allowance to ordinary reads: callers must already be admitted by
   * the native video capability and always use a canonical `asset://<32-hex>` URI.
   */
  public async openVideoAssetStrict(uri: string, signal?: AbortSignal): Promise<ResourceOpenResult> {
    const parsed = parseUri(uri);
    if (!parsed || parsed.protocol !== "asset:" || !COMPLETE_ASSET_ID.test(parsed.hostname) || parsed.pathname !== "") {
      throw resourceError(RESOURCE_ERRORS.resource_uri_invalid);
    }
    if (signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
    const bytes = await this.readAssetBounded(parsed.hostname, VIDEO_SOURCE_MAX_BYTES, signal);
    if (signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
    const mediaType = detectVideoMediaType(bytes);
    if (!mediaType) throw resourceError(RESOURCE_ERRORS.resource_not_video);
    return { bytes, mediaType };
  }

  /**
   * Asset reads used by native media paths. The read timeout is an overall deadline: the check is
   * re-evaluated after the bounded read and any late result is discarded instead of returned.
   */
  private async readAssetBounded(id: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
    const controller = new AbortController();
    let rejectAborted!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () => {
      controller.abort(signal?.reason);
      rejectAborted(resourceError(RESOURCE_ERRORS.resource_read_aborted));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = resourceError(RESOURCE_ERRORS.resource_timeout);
        controller.abort(error);
        reject(error);
      }, this.readTimeoutMs);
    });
    try {
      const bytes = await Promise.race([this.assets.get(id, { maxBytes, signal: controller.signal }), deadline, cancelled]);
      if (signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
      controller.signal.throwIfAborted();
      if (!(bytes instanceof Uint8Array)) throw resourceError(RESOURCE_ERRORS.resource_read_failed);
      if (bytes.byteLength > maxBytes) throw resourceError(RESOURCE_ERRORS.resource_too_large);
      return bytes;
    } catch (cause) {
      if (signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
      if (resourceErrorCode(cause)) throw cause;
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") throw resourceError(RESOURCE_ERRORS.resource_not_found, { cause });
      throw resourceError(RESOURCE_ERRORS.resource_read_failed, { cause });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  public listReaders(): readonly ResourceReader[] {
    return [...this.readers.values()];
  }

  public detectImageMediaType(bytes: Uint8Array): string | undefined {
    return detectImageType(bytes);
  }

  public use(reader: ResourceReader): Disposer {
    if (reader.scheme === "asset" || reader.scheme === "artifact")
      throw new AppError(RESOURCE_ERRORS.resource_scheme_reserved, { effect: "none", detail: reader.scheme });
    if (this.readers.has(reader.scheme)) throw new AppError(CHANNEL_ERRORS.channel_reader_duplicate, { effect: "none", detail: reader.scheme });
    this.readers.set(reader.scheme, reader);
    return () => {
      if (this.readers.get(reader.scheme) === reader) this.readers.delete(reader.scheme);
    };
  }

  private async openReader(reader: ResourceReader, uri: URL, signal?: AbortSignal, actorIds?: readonly string[]): Promise<ResourceOpenResult> {
    if (signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timed = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = resourceError(RESOURCE_ERRORS.resource_timeout);
        controller.abort(error);
        reject(error);
      }, this.readTimeoutMs);
    });
    let rejectAborted!: (reason?: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () => {
      controller.abort(signal?.reason);
      rejectAborted(resourceError(RESOURCE_ERRORS.resource_read_aborted));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await Promise.race([reader.setup(this, uri, { signal: controller.signal, maxBytes: RESOURCE_MAX_BYTES, actorIds }), timed, cancelled]);
      if (signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
      return normalize(result);
    } catch (cause) {
      if (resourceErrorCode(cause)) throw cause;
      if (signal?.aborted) throw resourceError(RESOURCE_ERRORS.resource_read_aborted);
      throw resourceError(RESOURCE_ERRORS.resource_read_failed, { cause });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Stores the inbound pictures, native video and restricted text files of `parts` through the connector's download. */
  public async persistParts(parts: readonly Part[], fetchMedia: MediaFetcher): Promise<Part[]> {
    return persistParts(parts, this, fetchMedia, this.readTimeoutMs);
  }
}

export async function prepareOutputSegments(
  segments: readonly (readonly Part[])[],
  resources: ChannelResources,
  signal?: AbortSignal,
  actorIds?: readonly string[],
): Promise<Part[][]> {
  return (await prepareOutputSegmentsWithProjection(segments, resources, signal, actorIds)).map((segment) => segment.parts);
}

/** Materialized transport and its surviving public source, without expanded resource bytes. */
export async function prepareOutputSegmentsWithProjection(
  segments: readonly (readonly Part[])[],
  resources: ChannelResources,
  signal?: AbortSignal,
  actorIds?: readonly string[],
): Promise<{ parts: Part[]; source: Part[] }[]> {
  const prepared: { parts: Part[]; source: Part[] }[] = [];
  for (const segment of segments) {
    const next = await Promise.all(segment.map((part) => preparePart(part, resources, signal, actorIds)));
    const filtered = next.filter((part) => part !== undefined);
    if (filtered.length) prepared.push({ parts: filtered.map((value) => value.part), source: filtered.map((value) => value.source) });
  }
  return prepared;
}

/**
 * The transport copy of a picture or file whose bytes were read: a `data:` URL, and for a file the name it is sent
 * under. Adapters name an untitled `data:` file themselves (OneBot sent every file as `file.bin`, user report
 * 2026-11-17), so a file keeps its own title, else the source's file name, else the URI's last segment. A picture
 * whose bytes are not an image is not sent.
 */
export function materializeOutputPart<T extends ImagePart | FilePart>(part: T, opened: ResourceOpenResult): T | undefined {
  const detected = detectImageType(opened.bytes);
  if (part.type === "image" && !detected) return undefined;
  const title = part.type === "file" ? outputFileName(part, opened) : undefined;
  const mediaType = detected ?? opened.mediaType ?? mediaTypeOfName(title) ?? "application/octet-stream";
  return { ...part, ...(title ? { title } : {}), src: `data:${mediaType};base64,${Buffer.from(opened.bytes).toString("base64")}` };
}

async function preparePart(
  part: Part,
  resources: ChannelResources,
  signal?: AbortSignal,
  actorIds?: readonly string[],
): Promise<{ part: Part; source: Part } | undefined> {
  if ((part.type === "quote" || part.type === "platform") && part.parts.length) {
    const children = (await Promise.all(part.parts.map((child) => preparePart(child, resources, signal, actorIds)))).filter((child) => child !== undefined);
    return {
      part: { ...part, parts: children.map((child) => child.part) },
      source: { ...part, parts: children.map((child) => child.source) },
    };
  }
  if (part.type !== "image" && part.type !== "file") return { part, source: part };
  const src = part.src;
  if (src === undefined || !RESOURCE_SOURCE.test(src)) return { part, source: part };
  if (part.type === "image" && !/^asset:\/\/[a-f0-9]{32}$/.test(src)) {
    // ponytail: full 32-hex ID required for output resolution; prefix/short IDs are not resolvable
    const scheme = src.slice(0, src.indexOf(":"));
    if (scheme === "asset") return undefined;
  }
  // Sticker artifacts are historical/read-only projections, never a second delivery route.
  // Enforce after parsing (and polishing), including file/nested image parts.
  const parsedSource = parseUri(src);
  if (parsedSource?.protocol === "artifact:" && parsedSource.hostname === "sticker") {
    throw resourceError(RESOURCE_ERRORS.resource_delivery_restricted);
  }
  const opened = await resources.open(src, signal, actorIds);
  if (!opened) return undefined;
  const materialized = materializeOutputPart(part, opened);
  return materialized ? { part: materialized, source: part } : undefined;
}

function outputFileName(part: FilePart, opened: ResourceOpenResult): string | undefined {
  const own = part.title?.trim() ? part.title : undefined;
  // A URI segment names the file only when it looks like one (an asset ID does not).
  const segment = part.src?.split(/[?#]/, 1)[0]!.split("/").at(-1);
  const source = segment && /\.[A-Za-z0-9]{1,10}$/.test(segment) ? segment : undefined;
  for (const candidate of [own, opened.filename, source]) {
    const name = candidate?.split(/[\\/]/).at(-1)?.trim();
    if (name && name !== "." && name !== ".." && !/[\0\r\n]/.test(name)) return name.slice(0, 200);
  }
  return undefined;
}

function mediaTypeOfName(name: string | undefined): string | undefined {
  const extension = name?.includes(".") ? name.split(".").at(-1)!.toLowerCase() : undefined;
  return extension ? MEDIA_TYPES[extension] : undefined;
}

function parseUri(value: string): URL | undefined {
  const match = URI_SHAPE.exec(value);
  if (!match) return undefined;
  const scheme = match[1]!.toLowerCase();
  const authority = match[2] ?? "";
  const rawPath = match[3] ?? "";
  if (
    value.includes("?") ||
    value.includes("#") ||
    authority.includes("@") ||
    authority.includes(":") ||
    rawPath.includes("%") ||
    rawPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }
  const uri = new URL(`${scheme}://${authority}${rawPath ? `/${rawPath}` : ""}`);
  if (uri.search || uri.hash || uri.username || uri.password || uri.port) return undefined;
  if (uri.pathname.split("/").some((part) => part === "." || part === "..")) return undefined;
  return uri;
}

function normalize(value: unknown): ResourceOpenResult {
  if (!value || typeof value !== "object" || !("bytes" in value))
    throw resourceError(RESOURCE_ERRORS.resource_read_failed, { detail: "reader result is not an object with bytes" });
  const result = value as Partial<ResourceOpenResult>;
  if (!(result.bytes instanceof Uint8Array)) throw resourceError(RESOURCE_ERRORS.resource_read_failed, { detail: "reader bytes are not a Uint8Array" });
  if (result.bytes.byteLength > RESOURCE_MAX_BYTES) throw resourceError(RESOURCE_ERRORS.resource_too_large);
  if (result.mediaType !== undefined && !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(result.mediaType))
    throw resourceError(RESOURCE_ERRORS.resource_read_failed, { detail: "reader media type is malformed" });
  if (result.filename !== undefined && (result.filename.length === 0 || /[\\/\0]/.test(result.filename)))
    throw resourceError(RESOURCE_ERRORS.resource_read_failed, { detail: "reader filename is unsafe" });
  return result as ResourceOpenResult;
}

export {
  RESOURCE_ERRORS,
  resourceError,
  resourceErrorCode,
  videoCompressionErrorCode,
  type ResourceReadErrorCode,
  type VideoCompressionErrorCode,
} from "./errors.js";

/** Narrow native-video allowance; ordinary readers, images and output stay at RESOURCE_MAX_BYTES. */
export { detectVideoMediaType, VIDEO_MAX_BYTES, VIDEO_SOURCE_MAX_BYTES } from "./video-media.js";

export { type ImageFailureCode, formatImageFailure, imageFailureLabel, isImageFailureCode } from "./image-failure.js";

export { type VideoFailureCode, formatVideoFailure, isVideoFailureCode, videoFailureLabel } from "./video-failure.js";

export { type ArtifactOpenResult, type ArtifactStore, type ArtifactWriter } from "./artifact.js";

export { type AssetReadOptions, type AssetStore } from "./asset.js";

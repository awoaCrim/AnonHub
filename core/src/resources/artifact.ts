import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AppError, createDirectory, newId } from "@yesimbot/foundation";

import { RESOURCE_ERRORS } from "./errors.js";

const SAFE_ARTIFACT_NAME = /^[a-zA-Z0-9_-]+$/;
const SAFE_MEDIA_TYPE = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;

export interface ArtifactOpenResult {
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
  readonly filename?: string;
}

export interface ArtifactWriter {
  put(bytes: Uint8Array, metadata: { mediaType?: string; filename?: string }): Promise<string>;
}

export interface ArtifactStore {
  forTool(toolName: string): ArtifactWriter;
  open(uri: string): Promise<ArtifactOpenResult>;
  clear(): Promise<void>;
}

export class ChannelArtifactStore implements ArtifactStore {
  public constructor(private readonly root: string) {}

  public forTool(toolName: string): ArtifactWriter {
    assertSafeArtifactName(toolName);
    return new ChannelArtifactWriter(this.root, toolName);
  }

  public async open(uri: string): Promise<ArtifactOpenResult> {
    const parsed = parseArtifactUri(uri);
    if (!parsed) throw new AppError(RESOURCE_ERRORS.artifact_uri_invalid, { effect: "none" });
    const directory = join(this.path(), parsed.toolName, parsed.uuid);
    try {
      const [bytes, metadataRaw] = await Promise.all([readFile(join(directory, "data")), readFile(join(directory, "metadata.json"), "utf-8")]);
      const metadata = parseMetadata(JSON.parse(metadataRaw), bytes.byteLength);
      return { bytes: new Uint8Array(bytes), mediaType: metadata.mediaType, filename: metadata.filename };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new AppError(RESOURCE_ERRORS.artifact_not_found, { effect: "none", cause });
      throw cause;
    }
  }

  public async clear(): Promise<void> {
    await rm(this.path(), { recursive: true, force: true });
  }

  private path(): string {
    return join(this.root, "artifacts");
  }
}

class ChannelArtifactWriter implements ArtifactWriter {
  public constructor(
    private readonly root: string,
    private readonly toolName: string,
  ) {}

  public async put(bytes: Uint8Array, metadata: { mediaType?: string; filename?: string }): Promise<string> {
    if (!(bytes instanceof Uint8Array)) throw new AppError(RESOURCE_ERRORS.artifact_data_invalid, { effect: "none" });
    const normalized = parseMetadata({ ...metadata, byteLength: bytes.byteLength }, bytes.byteLength);
    const uuid = newId();
    const base = join(this.root, "artifacts", this.toolName);
    await mkdir(base, { recursive: true });
    await createDirectory(join(base, uuid), async (staging) => {
      await Promise.all([writeFile(join(staging, "data"), bytes), writeFile(join(staging, "metadata.json"), JSON.stringify(normalized))]);
    });
    return `artifact://${this.toolName}/${uuid}`;
  }
}

function assertSafeArtifactName(name: string): void {
  if (typeof name !== "string" || !SAFE_ARTIFACT_NAME.test(name))
    throw new AppError(RESOURCE_ERRORS.artifact_metadata_invalid, { effect: "none", detail: "tool name" });
}

function parseMetadata(value: unknown, byteLength: number): { filename?: string; mediaType?: string; byteLength: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(RESOURCE_ERRORS.artifact_metadata_invalid, { effect: "none" });
  const metadata = value as Record<string, unknown>;
  if (Object.keys(metadata).some((key) => !["filename", "mediaType", "byteLength"].includes(key)))
    throw new AppError(RESOURCE_ERRORS.artifact_metadata_invalid, { effect: "none" });
  const filename = metadata.filename;
  if (filename !== undefined && (typeof filename !== "string" || !isSafeBasename(filename)))
    throw new AppError(RESOURCE_ERRORS.artifact_metadata_invalid, { effect: "none", detail: "filename" });
  const mediaType = metadata.mediaType;
  if (mediaType !== undefined && (typeof mediaType !== "string" || !SAFE_MEDIA_TYPE.test(mediaType)))
    throw new AppError(RESOURCE_ERRORS.artifact_metadata_invalid, { effect: "none", detail: "media type" });
  if (metadata.byteLength !== byteLength || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 0)
    throw new AppError(RESOURCE_ERRORS.artifact_metadata_invalid, { effect: "none", detail: "byte length mismatch" });
  return { ...(filename === undefined ? {} : { filename }), ...(mediaType === undefined ? {} : { mediaType }), byteLength };
}

function isSafeBasename(filename: string): boolean {
  return filename.length > 0 && filename !== "." && filename !== ".." && !/[\\/\0]/.test(filename);
}

/** New artifacts are named by `newId()` (UUID v4); those already in history carry the UUID v7 Core used to make. */
function parseArtifactUri(uri: string): { toolName: string; uuid: string } | undefined {
  const match = uri.match(/^artifact:\/\/([a-zA-Z0-9_-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/);
  if (!match) return undefined;
  assertSafeArtifactName(match[1]!);
  return { toolName: match[1]!, uuid: match[2]! };
}

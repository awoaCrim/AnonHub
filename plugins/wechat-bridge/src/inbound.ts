import { errorFields, type Clock } from "@yesimbot/foundation";
import type { AgentWechatClient, AgentWechatMediaAsset, AgentWechatMessage } from "@yesimbot/wechat-transport";
import type { Part } from "koishi-plugin-yesimbot/kernel";

import { log } from "./log.js";
import { sleep } from "./sleep.js";

/** Formats Core and vision models read directly; anything else (WXGF, HEVC) is tried through the daemon's preview copy. */
const READABLE_IMAGE = /^image\/(jpeg|png|gif|webp)$/;

/** Best copy first. A thumbnail is still better than no picture. */
const VARIANTS = ["original", "best", "standard", "normal", "encoded", "thumbnail"];

/**
 * How long a message waits while the daemon's download is on its way. A 2 MB sticker took 27 s from Tencent's CDN
 * (2026-11-23), with no progress reported until it was done, so the wait follows the job's state, not its bytes.
 */
const MEDIA_WAIT_MS = 60_000;

/** Download job states that may still bring the bytes. */
const LIVE_JOB = new Set(["queued", "running", "available"]);

/** Core keeps at most 5 MiB of an incoming picture or file (text files 1 MiB); a larger one is not fetched at all. */
const FILE_MAX_BYTES = 5 * 1024 * 1024;

const QUOTED_KINDS: Readonly<Record<number, string>> = { 34: "[语音]", 43: "[视频]", 48: "[位置]" };

export type MediaReader = Pick<AgentWechatClient, "mediaAssets" | "mediaContent" | "transferMedia" | "job">;

/** A file's bytes, or why they were not read (Core's file failure codes). */
export type InboundFile =
  | { readonly bytes: Uint8Array; readonly mediaType: string; readonly filename?: string }
  | { readonly failure: "too_large" | "timeout" | "download_failed"; readonly filename?: string };

type AssetRead<T> = (asset: AgentWechatMediaAsset) => Promise<T | undefined>;

/** The clock the daemon's download wait is measured on, and the caller's cancellation. */
export interface MediaOptions {
  readonly clock: Clock;
  readonly signal?: AbortSignal;
}

export interface InboundImage {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface InboundReaders {
  readonly image: (message: AgentWechatMessage) => Promise<InboundImage | undefined>;
  readonly file: (message: AgentWechatMessage) => Promise<InboundFile>;
}

/** The quoted message of a quote reply, as Core keeps it in the record's quote. */
export interface InboundQuote {
  readonly id: string;
  readonly user?: { readonly id: string; readonly name?: string };
  readonly parts: Part[];
}

/**
 * Parts for one incoming message, or undefined when it is not something people say (system notices, recalled
 * messages). Pictures, stickers and files go to Core with their bytes; voice and video are named in text, so the bot
 * is told they arrived, never that it heard or watched them.
 */
export async function messageParts(message: AgentWechatMessage, selfId: string, read: InboundReaders): Promise<Part[] | undefined> {
  if (message.recall || message.type === 10000) return undefined;
  const parts: Part[] = [];
  if (message.mentions?.self === true) parts.push({ type: "mention", userId: selfId });
  if (message.mentions?.all === true) parts.push({ type: "mention", scope: "all" });
  const body = message.body?.trim() ?? "";
  switch (message.type) {
    case 1:
      if (!body) return undefined;
      parts.push(text(message.body!));
      break;
    case 3:
    case 47: {
      const image = await read.image(message);
      parts.push(
        image ? { type: "image", src: dataUrl(image.mediaType, image.bytes) } : text(message.type === 3 ? "[图片（未能读取）]" : "[表情（未能读取）]"),
      );
      break;
    }
    case 34:
      parts.push(text("[语音消息]\n[语音尚未转写]"));
      break;
    case 43:
      parts.push(text("[视频]\n[视频内容尚未读取]"));
      break;
    case 48:
      parts.push(text(body ? `[位置] ${body}` : "[位置]"));
      break;
    case 49:
      if (message.appMessageType === 6) {
        parts.push(filePart(await read.file(message), body));
        break;
      }
      // A quote reply's own words; the quoted message travels as the message's quote.
      parts.push(text(appMessageText(message) || "[微信消息]"));
      break;
    default:
      parts.push(text(body || `[微信消息（类型 ${message.type}）]\n[已收到此消息，暂无法读取具体内容]`));
  }
  return parts;
}

/** The quoted message of a quote reply (type 49/57), or undefined. Only WeChat's own summary of it is known. */
export function messageQuote(message: AgentWechatMessage): InboundQuote | undefined {
  const quote = message.quote;
  if (message.type !== 49 || message.appMessageType !== 57 || !quote?.serverId) return undefined;
  const link = quote.embeddedLink?.url?.trim() ? [quote.embeddedLink.title?.trim(), quote.embeddedLink.url.trim()].filter(Boolean).join("\n") : "";
  const summary =
    quote.state === "recalled"
      ? "[已撤回的消息]"
      : quote.embeddedText?.trim() ||
        link ||
        (quote.embeddedImage || quote.type === 3 ? "[图片]" : quote.embeddedSticker || quote.type === 47 ? "[表情]" : (QUOTED_KINDS[quote.type] ?? ""));
  return {
    id: quote.serverId,
    ...(quote.senderId ? { user: { id: quote.senderId, ...(quote.senderName ? { name: quote.senderName } : {}) } } : {}),
    parts: summary ? [text(summary)] : [],
  };
}

/** The message's picture or sticker bytes, in a format a model can look at. */
export async function readMessageImage(
  api: MediaReader,
  account: string,
  message: AgentWechatMessage,
  options: MediaOptions,
): Promise<InboundImage | undefined> {
  const { signal } = options;
  const result = await readMessageAsset(api, account, message, ["image", "sticker"], undefined, options, async (asset) => {
    for (const representation of ["original", "preview"] as const) {
      try {
        const content = await api.mediaContent(account, asset.id, { representation, signal });
        const mediaType = baseType(content.contentType);
        if (READABLE_IMAGE.test(mediaType) && content.bytes.byteLength > 0) return { bytes: content.bytes, mediaType };
      } catch (error) {
        // Not cached in this representation; try the next.
        log.debug("media.representation_unavailable", { representation, ...errorFields(error) });
      }
    }
    return undefined;
  });
  return result && "bytes" in result ? result : undefined;
}

/** The message's file bytes, up to Core's limit. */
export async function readMessageFile(api: MediaReader, account: string, message: AgentWechatMessage, options: MediaOptions): Promise<InboundFile> {
  const { signal } = options;
  let filename: string | undefined;
  const result = await readMessageAsset(api, account, message, ["file"], FILE_MAX_BYTES, options, async (asset) => {
    filename = asset.filename?.trim() || filename;
    try {
      const content = await api.mediaContent(account, asset.id, { maxBytes: FILE_MAX_BYTES, signal });
      if (content.bytes.byteLength > FILE_MAX_BYTES) return { failure: "too_large" as const };
      return { bytes: content.bytes, mediaType: baseType(content.contentType) || "application/octet-stream" };
    } catch (error) {
      log.debug("media.file_download_failed", { ...errorFields(error) });
      return { failure: "download_failed" as const };
    }
  });
  filename ??= result && "filename" in result ? result.filename : undefined;
  const named = filename ? { filename } : {};
  if (!result) return { failure: "timeout", ...named };
  return { ...result, ...named };
}

function filePart(file: InboundFile, body: string): Part {
  const title = file.filename?.trim() || body || undefined;
  if ("failure" in file) return { type: "file", ...(title ? { title } : {}), failure: file.failure };
  return { type: "file", src: dataUrl(file.mediaType, file.bytes), ...(title ? { title } : {}) };
}

function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function text(content: string): Part {
  return { type: "text", text: content };
}

function appMessageText(message: AgentWechatMessage): string {
  const body = message.body?.trim() ?? "";
  const url = message.link?.url?.trim();
  if (url && /^https?:\/\//.test(url) && !body.includes(url)) {
    const title = message.link?.title?.trim();
    return [body || title || "[链接]", url].join("\n");
  }
  return body;
}

/**
 * Reads the best cached copy of a message's media. The daemon downloads media by itself; when no copy is cached yet
 * this waits for it, and asks for a transfer once if nothing is on its way. Undefined when nothing could be read in time
 * or every download failed.
 */
async function readMessageAsset<T extends object>(
  api: MediaReader,
  account: string,
  message: AgentWechatMessage,
  kinds: readonly AgentWechatMediaAsset["kind"][],
  maxBytes: number | undefined,
  { clock, signal }: MediaOptions,
  read: AssetRead<T>,
): Promise<T | { failure: "too_large"; filename?: string } | undefined> {
  const deadline = clock.now() + MEDIA_WAIT_MS;
  let requested = false;
  for (let delay = 250; ; delay = Math.min(delay * 2, 1000)) {
    const assets = (await api.mediaAssets(account, message.id, signal)).filter((asset) => kinds.includes(asset.kind));
    if (maxBytes !== undefined) {
      const oversized = assets.find((asset) => (asset.byteLength ?? asset.advertisedByteLength ?? 0) > maxBytes);
      if (oversized) return { failure: "too_large", ...(oversized.filename ? { filename: oversized.filename } : {}) };
    }
    for (const asset of rank(assets.filter((item) => item.state === "available"))) {
      const value = await read(asset);
      if (value) return value;
    }
    const pending = assets.filter((asset) => asset.state === "pending");
    if (!pending.length) return undefined;
    if (pending.some((asset) => asset.jobId)) {
      if (await downloadsFailed(api, account, pending, signal)) return undefined;
    } else if (!requested) {
      requested = true;
      await api
        .transferMedia(account, message.id, "best", signal)
        .catch((error: unknown) => log.debug("media.transfer_request_failed", { ...errorFields(error) }));
    }
    if (clock.now() + delay > deadline) return undefined;
    await sleep(delay, signal);
  }
}

/** True when every known download job for these assets has ended without the bytes. A job that cannot be looked up may still be running. */
async function downloadsFailed(api: MediaReader, account: string, pending: AgentWechatMediaAsset[], signal: AbortSignal | undefined): Promise<boolean> {
  const jobs = pending.flatMap((asset) => (asset.jobId ? [asset.jobId] : []));
  const states = await Promise.all(
    jobs.map((id) =>
      api.job(account, id, signal).then(
        (job) => job.state,
        (error: unknown) => {
          log.debug("media.job_unavailable", { job: id, ...errorFields(error) });
          return undefined;
        },
      ),
    ),
  );
  return states.every((state) => state !== undefined && !LIVE_JOB.has(state));
}

function baseType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

function rank(assets: AgentWechatMediaAsset[]): AgentWechatMediaAsset[] {
  const order = (asset: AgentWechatMediaAsset) => {
    const index = VARIANTS.indexOf(asset.variant);
    return index < 0 ? VARIANTS.length : index;
  };
  return [...assets].sort((left, right) => order(left) - order(right));
}

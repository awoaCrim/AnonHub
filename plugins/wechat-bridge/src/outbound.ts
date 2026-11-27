import { AppError, errorFields, newId, type Clock } from "@yesimbot/foundation";
import { AgentWechatError, MAX_IMAGE_BYTES, type AgentWechatClient, type AgentWechatMediaJob, type AgentWechatSendIntent } from "@yesimbot/wechat-transport";
import type { Part } from "koishi-plugin-yesimbot/kernel";

import { isGroupThread } from "./config.js";
import { WECHAT_ERRORS } from "./errors.js";
import { log } from "./log.js";
import type { RemoteMediaFetcher } from "./media.js";
import { sleep } from "./sleep.js";

/** Ordinary files and videos; images are capped lower by WeChat. */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const TEXT_DEADLINE_MS = 65_000;

const IMAGE_DEADLINE_MS = 120_000;

const MEDIA_DEADLINE_MS = 10 * 60_000;

const QUOTE_SCAN = 100;

const MEDIA_TAGS = new Set(["img", "image", "video", "file", "audio"]);

export type SendApi = Pick<AgentWechatClient, "sendText" | "sendMedia" | "sendIntent" | "sendByKey" | "job" | "upload" | "threadMessages">;

type Piece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "at"; readonly id?: string; readonly name?: string; readonly all?: boolean }
  | { readonly kind: "quote"; readonly id: string }
  | { readonly kind: "media"; readonly type: "image" | "file" | "video"; readonly src: string; readonly name?: string };

export interface SendTarget {
  readonly api: SendApi;
  readonly account: string;
  readonly threadId: string;
  /** NativeMessage IDs of messages this adapter has seen, by WeChat server ID, for quote replies. */
  readonly quotes: Map<string, string>;
  readonly clock: Clock;
  readonly fetchMedia?: RemoteMediaFetcher;
  readonly signal?: AbortSignal;
}

/**
 * Sends message parts as WeChat messages, in order: text with its @-mentions and quote as one message, each picture,
 * video or file as its own. Resolves with WeChat's server IDs once WeChat accepted every message. A send whose outcome
 * is unknown is never repeated: it throws `wechat_send_unknown` and the caller must not resend.
 */
export async function sendParts(target: SendTarget, content: readonly Part[]): Promise<string[]> {
  const pieces = flatten(content);
  const group = isGroupThread(target.threadId);
  const ids: string[] = [];
  let text = "",
    mentions: string[] = [],
    all = false,
    quote: string | undefined;
  const flush = async () => {
    if (!text.trim()) {
      text = "";
      return;
    }
    const quoted = quote ? await resolveQuote(target, quote) : undefined;
    ids.push(
      await sendText(target, {
        kind: "text",
        threadId: target.threadId,
        text,
        ...(quoted ? { quote: quoted } : {}),
        ...(mentions.length ? { mentions: { userIds: [...new Set(mentions)] } } : all ? { mentions: { all: true } } : {}),
      }),
    );
    text = "";
    mentions = [];
    all = false;
    quote = undefined;
  };
  for (const piece of pieces) {
    if (piece.kind === "text") text += piece.text;
    else if (piece.kind === "quote") quote ??= piece.id;
    else if (piece.kind === "at") {
      // WeChat writes the @name itself for real mentions; outside groups a mention is only text.
      if (group && piece.all) all = true;
      else if (group && piece.id) mentions.push(piece.id);
      else text += `@${piece.name ?? piece.id ?? "所有人"} `;
    } else {
      await flush();
      ids.push(await sendMedia(target, piece));
    }
  }
  await flush();
  if (!ids.length) throw new AppError(WECHAT_ERRORS.wechat_empty_message, { effect: "none" });
  return ids;
}

export function isServerId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}

/** A bounded memory of recent messages for quote replies. */
export function remember(quotes: Map<string, string>, serverId: string, messageId: string): void {
  quotes.delete(serverId);
  quotes.set(serverId, messageId);
  if (quotes.size > 2048) quotes.delete(quotes.keys().next().value!);
}

function flatten(parts: readonly Part[]): Piece[] {
  const pieces: Piece[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        pieces.push({ kind: "text", text: part.text });
        break;
      case "mention":
        pieces.push({
          kind: "at",
          ...(part.scope === "all" ? { all: true } : {}),
          ...(part.userId ? { id: part.userId } : {}),
          ...(part.name ? { name: part.name } : {}),
        });
        break;
      case "quote":
        if (/^[1-9][0-9]{0,19}$/.test(part.messageId)) pieces.push({ kind: "quote", id: part.messageId });
        break;
      case "image":
      case "file":
      case "video":
        pieces.push(mediaPiece(part.type, part.src, part.type === "video" ? undefined : part.title));
        break;
      case "platform":
        pieces.push(...platformPieces(part));
        break;
      default:
        throw new AppError(WECHAT_ERRORS.wechat_unsupported_element, { effect: "none", detail: part.type });
    }
  }
  return pieces;
}

/** An element Core does not type: line breaks, paragraphs, mentions in an unusual spelling, audio, and wrappers. */
function platformPieces(part: Extract<Part, { type: "platform" }>): Piece[] {
  const attrs = part.attrs;
  const own = (key: string) => (typeof attrs[key] === "string" && attrs[key] ? (attrs[key] as string) : undefined);
  if (part.tag === "br") return [{ kind: "text", text: "\n" }];
  if (part.tag === "p") return [...flatten(part.parts), { kind: "text", text: "\n" }];
  if (part.tag === "at") {
    const id = own("id");
    const name = own("name");
    return [{ kind: "at", ...(attrs.type === "all" ? { all: true } : {}), ...(id ? { id } : {}), ...(name ? { name } : {}) }];
  }
  if (part.tag === "quote") {
    const id = own("id");
    return id && /^[1-9][0-9]{0,19}$/.test(id) ? [{ kind: "quote", id }] : [];
  }
  if (MEDIA_TAGS.has(part.tag)) {
    const name = [attrs.title, attrs.name, attrs.file].find((value): value is string => typeof value === "string" && !!value.trim());
    const type = part.tag === "img" || part.tag === "image" ? "image" : part.tag === "video" ? "video" : "file";
    return [mediaPiece(type, own("src") ?? own("url"), name)];
  }
  // Formatting wrappers (b, i, a, message…) send their text.
  if (part.parts.length) return flatten(part.parts);
  throw new AppError(WECHAT_ERRORS.wechat_unsupported_element, { effect: "none", detail: part.tag });
}

function mediaPiece(type: "image" | "file" | "video", src: string | undefined, name: string | undefined): Piece {
  if (!src) throw new AppError(WECHAT_ERRORS.wechat_media_source_missing, { effect: "none" });
  return { kind: "media", type, src, ...(name ? { name } : {}) };
}

async function resolveQuote(target: SendTarget, serverId: string): Promise<{ messageId: string; serverId: string } | undefined> {
  const known = target.quotes.get(serverId);
  if (known) return { messageId: known, serverId };
  try {
    const found = (await target.api.threadMessages(target.account, target.threadId, QUOTE_SCAN, target.signal)).find(
      (message) => message.serverId === serverId,
    );
    if (found) return { messageId: found.id, serverId };
  } catch (error) {
    // Without the original, send the reply unquoted rather than not at all.
    if (target.signal?.aborted) throw error;
    log.debug("send.quote_unresolved", { thread: target.threadId, ...errorFields(error) });
  }
  return undefined;
}

async function sendText(target: SendTarget, request: Parameters<SendApi["sendText"]>[1]): Promise<string> {
  const key = `yesimbot:${newId()}`;
  let intent = await submit(target, key, () => target.api.sendText(target.account, request, key, target.signal));
  const deadline = target.clock.now() + TEXT_DEADLINE_MS;
  for (let delay = 250; intent.state === "queued" || intent.state === "submitting"; delay = Math.min(delay * 2, 1000)) {
    if (target.clock.now() + delay > deadline) throw sendUnknown();
    await sleep(delay, target.signal);
    intent = await target.api.sendIntent(target.account, intent.id, target.signal);
  }
  if (intent.state === "accepted" && isServerId(intent.serverId)) {
    if (intent.localMessageId) remember(target.quotes, intent.serverId, intent.localMessageId);
    return intent.serverId;
  }
  throw intent.state === "failed" || intent.state === "cancelled" ? sendFailed(intent.errorCode ?? intent.state) : sendUnknown();
}

async function sendMedia(target: SendTarget, piece: Extract<Piece, { kind: "media" }>): Promise<string> {
  const media = await readSource(target, piece.src);
  if (media.bytes.byteLength > (piece.type === "image" ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES))
    throw new AppError(WECHAT_ERRORS.wechat_media_too_large, { effect: "none" });
  const upload = await target.api.upload(target.account, media.bytes, fileName(piece, media.mediaType), media.mediaType, target.signal);
  const key = `yesimbot:${newId()}`;
  let job = await submit(target, key, () =>
    target.api.sendMedia(target.account, { kind: piece.type, threadId: target.threadId, sourceId: upload.id }, key, target.signal),
  );
  const deadline = target.clock.now() + (piece.type === "image" ? IMAGE_DEADLINE_MS : MEDIA_DEADLINE_MS);
  for (let delay = 250; job.state === "queued" || job.state === "running"; delay = Math.min(delay * 2, 1000)) {
    if (target.clock.now() + delay > deadline) throw sendUnknown();
    await sleep(delay, target.signal);
    job = await target.api.job(target.account, job.id, target.signal);
  }
  if (job.state === "accepted" && isServerId(job.serverMessageId)) return job.serverMessageId;
  throw ["failed", "cancelled", "unsupported", "expired"].includes(job.state) ? sendFailed(job.reason ?? job.state) : sendUnknown();
}

/**
 * Submits once. A refusal (4xx) means nothing was sent. When the request may have reached the daemon (network error,
 * 5xx) the same key is looked up instead of submitting again, so a retry can never send twice.
 */
async function submit<T extends AgentWechatSendIntent | AgentWechatMediaJob>(target: SendTarget, key: string, post: () => Promise<T>): Promise<T> {
  try {
    return await post();
  } catch (error) {
    if (error instanceof AgentWechatError && error.status >= 400 && error.status < 500) throw sendFailed(error.code, error);
    try {
      return (await target.api.sendByKey(target.account, key, target.signal)) as T;
    } catch (lookup) {
      log.warn("send.outcome_unknown", { thread: target.threadId, ...errorFields(lookup) });
      throw sendUnknown(lookup);
    }
  }
}

async function readSource(target: SendTarget, src: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const data = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(src);
  if (data) return { bytes: Buffer.from(data[2]!, "base64"), mediaType: data[1] || "application/octet-stream" };
  if (src.startsWith("base64://")) return { bytes: Buffer.from(src.slice(9), "base64"), mediaType: "application/octet-stream" };
  if (/^https?:\/\//.test(src) && target.fetchMedia) return target.fetchMedia(src, target.signal);
  throw new AppError(WECHAT_ERRORS.wechat_media_source_unsupported, { effect: "none" });
}

function sendFailed(reason: string, cause?: unknown): AppError {
  return new AppError(WECHAT_ERRORS.wechat_send_failed, { effect: "none", detail: reason, ...(cause === undefined ? {} : { cause }) });
}

function sendUnknown(cause?: unknown): AppError {
  return new AppError(WECHAT_ERRORS.wechat_send_unknown, { effect: "unknown", ...(cause === undefined ? {} : { cause }) });
}

function fileName(piece: Extract<Piece, { kind: "media" }>, mediaType: string): string {
  const own = piece.name
    ?.split(/[\\/]/)
    .at(-1)
    ?.replace(/[\0\r\n]/g, "")
    .trim();
  if (own) return own.slice(0, 200);
  const extension = mediaType.split("/")[1]?.split(/[;+]/)[0];
  return `${piece.type}${extension && /^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : ""}`;
}

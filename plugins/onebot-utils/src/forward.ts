import { DEFAULT_TIME_ZONE } from "@yesimbot/foundation";
import { z } from "zod/v4";

import { formatAnimatedImageLabel, isAnimatedImage } from "./animated-image.js";
import type { OneBotCalls, OneBotSenderInfo } from "./onebot.js";

export const FORWARD_TOOL_SCHEMA = z.strictObject({
  forwardId: z.string().describe("合并转发消息的 ID"),
  offset: z.int().min(0).describe("分页偏移，默认 0").optional(),
  limit: z.int().min(1).max(60).describe("每页条数，默认 30，最大 60").optional(),
});

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DEFAULT_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Text characters of one forward page; a single longer message is still returned alone. */
const MAX_FORWARD_PAGE_CHARS = 6000;

export type ForwardToolInput = z.infer<typeof FORWARD_TOOL_SCHEMA>;

export type ForwardResult = ForwardPage | ForwardFailure;

type ForwardPart = string | { image: readonly [summary: string, file: string, size: string | null] } | { forward: string };

type ForwardMessage = readonly [sender: string, time: string | null, content: readonly ForwardPart[]];

type OneBotForwardSegment = OneBotTextSegment | OneBotImageSegment | OneBotNestedForwardSegment | OneBotRecordSegment | OneBotVideoSegment | OneBotFileSegment;

export interface ForwardImageRequest {
  readonly file: string;
  readonly summary: string;
  readonly url?: string;
}

export interface ForwardReaderConfig {
  parseImages: boolean;
  persistImages?: (images: readonly ForwardImageRequest[]) => Promise<ReadonlyMap<string, string>>;
}

interface ForwardPage {
  messages: readonly ForwardMessage[];
  nextOffset?: number;
  tips?: string;
  overLimit?: true;
}

interface ForwardFailure {
  error: string;
}

interface OneBotForwardNode {
  sender: OneBotSenderInfo;
  time: number;
  message: readonly OneBotForwardSegment[];
  raw_message?: unknown;
}

interface OneBotTextSegment {
  type: "text";
  data: { text: string };
}

interface OneBotImageSegment {
  type: "image";
  data: { summary: string; file: string; file_size?: string; src?: string; url?: string; sub_type?: unknown; subType?: unknown };
}

interface OneBotNestedForwardSegment {
  type: "forward";
  data: { id: string; content?: readonly OneBotForwardNode[] };
}

interface OneBotRecordSegment {
  type: "record";
  data: object;
}

interface OneBotVideoSegment {
  type: "video";
  data: object;
}

interface OneBotFileSegment {
  type: "file";
  data: object;
}

export function createForwardReader(
  internal: Pick<OneBotCalls, "getForwardMsg">,
  config: Readonly<ForwardReaderConfig>,
): (input: ForwardToolInput) => Promise<ForwardResult> {
  const cache = new Map<string, readonly ForwardMessage[]>();

  return async function readForwardPage(input) {
    const start = clampOffset(input.offset);
    const limit = clampLimit(input.limit);
    const records = cache.get(input.forwardId) ?? (await loadAndNormalize(input.forwardId));
    if (!records) return { error: `未找到合并转发消息: ${input.forwardId}` };

    return page(records, start, limit);
  };

  async function loadAndNormalize(forwardId: string): Promise<readonly ForwardMessage[] | undefined> {
    const response = await internal.getForwardMsg(forwardId);
    if (!Array.isArray(response)) return undefined;

    const nodes = response as unknown as readonly OneBotForwardNode[];
    const nestedForwards = new Map<string, readonly ForwardMessage[]>();
    const imageUrls = new Map<string, string>();
    const records = nodes.map((node) => normalizeNode(node, config, nestedForwards, imageUrls));

    const imageRequests = collectImageRequests([records, ...nestedForwards.values()], imageUrls);
    if (config.persistImages && imageRequests.length > 0) {
      const assetIds = await config.persistImages(imageRequests);
      const render = (items: readonly ForwardMessage[]): ForwardMessage[] =>
        items.map((record) => [record[0], record[1], coalesceParts(record[2].map((part) => renderImagePart(part, assetIds)))]);
      const renderedRecords = render(records);
      cache.set(forwardId, renderedRecords);
      for (const [nestedForwardId, nestedRecords] of nestedForwards) {
        cache.set(nestedForwardId, render(nestedRecords));
      }
      return renderedRecords;
    }

    cache.set(forwardId, records);
    for (const [nestedForwardId, nestedRecords] of nestedForwards) {
      cache.set(nestedForwardId, nestedRecords);
    }
    return records;
  }
}

function normalizeNode(
  node: OneBotForwardNode,
  config: Readonly<ForwardReaderConfig>,
  nestedForwards: Map<string, readonly ForwardMessage[]>,
  imageUrls: Map<string, string>,
): ForwardMessage {
  return [formatSender(node.sender), formatTime(node.time), normalizeSegments(node.message, config, nestedForwards, imageUrls)];
}

function formatSender(sender: OneBotSenderInfo): string {
  const userId = String(sender.user_id);
  const displayName = sender.card || sender.nickname;

  return displayName && displayName !== userId ? `${displayName} (${userId})` : userId;
}

function formatTime(value: number): string | null {
  if (!Number.isFinite(value)) return null;

  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : timeFormatter.format(date);
}

function normalizeSegments(
  segments: readonly OneBotForwardSegment[],
  config: Readonly<ForwardReaderConfig>,
  nestedForwards: Map<string, readonly ForwardMessage[]>,
  imageUrls: Map<string, string>,
): readonly ForwardPart[] {
  const parts: ForwardPart[] = [];

  for (const segment of segments) {
    switch (segment?.type) {
      case "text": {
        const text = (segment.data as { text?: unknown } | undefined)?.text;
        if (typeof text === "string") appendString(parts, text);
        else appendString(parts, "[未知消息段]");
        break;
      }
      case "image": {
        const data = segment.data as
          | { summary?: unknown; file?: unknown; file_size?: unknown; src?: unknown; url?: unknown; sub_type?: unknown; subType?: unknown }
          | undefined;
        if (typeof data?.summary !== "string" || typeof data.file !== "string") {
          appendString(parts, "[未知消息段]");
        } else if (config.parseImages) {
          if (typeof data.src === "string" && data.src.length > 0) imageUrls.set(data.file, data.src);
          else if (typeof data.url === "string" && data.url.length > 0) imageUrls.set(data.file, data.url);
          parts.push({ image: [data.summary, data.file, formatFileSize(data.file_size)] });
        } else {
          appendString(parts, isAnimatedImage(data) ? formatAnimatedImageLabel({ summary: data.summary }) : "[图片]");
        }
        break;
      }
      case "forward": {
        const data = segment.data as { id?: unknown; content?: readonly OneBotForwardNode[] } | undefined;
        if (typeof data?.id !== "string") {
          appendString(parts, "[未知消息段]");
          break;
        }
        if (Array.isArray(data.content) && !nestedForwards.has(data.id)) {
          nestedForwards.set(
            data.id,
            data.content.map((node) => normalizeNode(node, config, nestedForwards, imageUrls)),
          );
        }
        parts.push({ forward: data.id });
        break;
      }
      case "record":
        appendString(parts, "[语音]");
        break;
      case "video":
        appendString(parts, "[视频]");
        break;
      case "file":
        appendString(parts, "[文件]");
        break;
      default:
        appendString(parts, "[未知消息段]");
    }
  }

  return parts;
}

function appendString(parts: ForwardPart[], value: string): void {
  const previous = parts.at(-1);
  if (typeof previous === "string") {
    parts[parts.length - 1] = previous + value;
  } else {
    parts.push(value);
  }
}

function formatFileSize(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;

  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) return null;
  if (bytes < 1000) return `${bytes} B`;

  const unit: readonly [number, string] = bytes < 1_000_000 ? [1000, "KB"] : bytes < 1_000_000_000 ? [1_000_000, "MB"] : [1_000_000_000, "GB"];
  return `${(bytes / unit[0]).toFixed(1)} ${unit[1]}`;
}

function collectImageRequests(records: readonly (readonly ForwardMessage[])[], imageUrls: ReadonlyMap<string, string>): ForwardImageRequest[] {
  const requests = new Map<string, ForwardImageRequest>();
  for (const recordList of records) {
    for (const record of recordList) {
      for (const part of record[2]) {
        if (typeof part === "string" || !("image" in part)) continue;
        const [summary, file] = part.image;
        if (!requests.has(file)) {
          const url = imageUrls.get(file);
          requests.set(file, { file, summary, ...(url === undefined ? {} : { url }) });
        }
      }
    }
  }
  return [...requests.values()];
}

function renderImagePart(part: ForwardPart, assetIds: ReadonlyMap<string, string>): ForwardPart {
  if (typeof part === "string" || !("image" in part)) return part;
  const assetId = assetIds.get(part.image[1]);
  return assetId ? `[图片：asset://${assetId}]` : "[图片]";
}

function coalesceParts(parts: readonly ForwardPart[]): ForwardPart[] {
  const result: ForwardPart[] = [];
  for (const part of parts) {
    const previous = result.at(-1);
    if (typeof previous === "string" && typeof part === "string") {
      result[result.length - 1] = previous + part;
    } else {
      result.push(part);
    }
  }
  return result;
}

function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 30;
  return Math.min(60, Math.max(1, Math.trunc(value)));
}

function page(records: readonly ForwardMessage[], start: number, limit: number): ForwardPage {
  if (start >= records.length) return { messages: [] };

  const messages: ForwardMessage[] = [];
  let chars = 0;
  let index = start;

  while (index < records.length && messages.length < limit) {
    const record = records[index]!;
    const recordChars = record[2].reduce((total, part) => total + (typeof part === "string" ? part.length : 0), 0);

    if (messages.length === 0 && recordChars > MAX_FORWARD_PAGE_CHARS) {
      return { messages: [record], ...continuation(index + 1, records.length), overLimit: true };
    }
    if (chars + recordChars > MAX_FORWARD_PAGE_CHARS) break;

    messages.push(record);
    chars += recordChars;
    index += 1;
  }

  return { messages, ...continuation(index, records.length) };
}

function continuation(nextOffset: number, totalRecords: number) {
  if (nextOffset >= totalRecords) return {};

  return { nextOffset, tips: `还有 ${totalRecords - nextOffset} 条消息未读取；如需继续，请使用相同 forwardId 和 nextOffset ${nextOffset}。` };
}

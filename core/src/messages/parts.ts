import { escapeMarkup, isAssetId, markupTag, partElement, type Part, type PartElement } from "@yesimbot/contracts/parts";

import { fileName, formatFileFailure } from "../resources/file-failure.js";
import { formatImageFailure } from "../resources/image-failure.js";
import { formatVideoFailure } from "../resources/video-failure.js";

/** Separates the image placeholders of one request from any text the model or a user wrote. */
export const MARK = "\u0000";

/**
 * How one part reads in the model's input. Stored pictures, files and videos become their `asset://` URI (or why they
 * could not be stored); a quote of the record's own quoted message is left out (the quote block shows it); everything
 * else is element markup, e.g. `<at id="1" name="小明"/>`.
 */
export function formatPart(part: Part, quotedMessageId?: string): string {
  if (repeatsQuote(part, quotedMessageId)) return "";
  switch (part.type) {
    case "text":
      return escapeMarkup(part.text);
    case "image": {
      if (!isAssetId(part.asset)) return formatImageFailure(part.failure);
      return `[图片：${part.title === undefined ? "" : `${part.title} `}asset://${part.asset}]`;
    }
    case "file": {
      const name = fileName({ title: part.title });
      if (!isAssetId(part.asset)) return formatFileFailure(part.failure, name);
      return `[文件：${name === undefined ? "" : `${name} `}asset://${part.asset}]`;
    }
    case "video":
      // The model reads videos on demand through `read`; only the stable URI is rendered here.
      return isAssetId(part.asset) ? `[视频：asset://${part.asset}]` : formatVideoFailure(part.failure);
    default: {
      const element = partElement(part);
      return markupTag(
        element.type,
        element.attrs,
        element.children.map((child) => formatPart(child, quotedMessageId)),
      );
    }
  }
}

export function formatParts(parts: readonly Part[]): string {
  return parts.map((part) => formatPart(part)).join("");
}

/**
 * `formatPart` for a request that carries image bytes: each stored picture becomes a placeholder (`nonce` + index)
 * that the request replaces with the image; its file name, when it was sent as a file, stays beside it.
 */
export function formatPartWithImages(part: Part, quotedMessageId: string | undefined, imageIds: string[], nonce: string): string {
  if (repeatsQuote(part, quotedMessageId)) return "";
  if (part.type === "image") {
    if (!isAssetId(part.asset)) return formatPart(part, quotedMessageId);
    const index = imageIds.push(part.asset) - 1;
    const title = part.title ? `[图片：${part.title}]` : "";
    return `${title}${nonce}${index}${MARK}`;
  }
  // Files and videos stay URI/text based even when image bytes are enabled: native video is on-demand.
  if (part.type === "text" || part.type === "file" || part.type === "video") return formatPart(part, quotedMessageId);
  const element = partElement(part);
  return markupTag(
    element.type,
    element.attrs,
    element.children.map((child) => formatPartWithImages(child, quotedMessageId, imageIds, nonce)),
  );
}

/** The text a context-region summary works from: text verbatim, `[图片]`, `[文件]`, `@name`, other parts by their content. */
export function compactPartsText(parts: readonly Part[] | undefined): string {
  return (parts ?? [])
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
          return "[图片]";
        case "file":
          return "[文件]";
        case "mention":
          return `@${part.name ?? part.userId ?? ""}`;
        case "platform":
          if (part.tag === "img" || part.tag === "image") return "[图片]";
          if (part.tag === "file") return "[文件]";
          if (part.tag === "at") return `@${String(part.attrs.name ?? part.attrs.id ?? "")}`;
          return compactPartsText(part.parts);
        case "quote":
          return compactPartsText(part.parts);
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("");
}

/** An inline quote (or platform `reply`) of the message the record already quotes. */
export function quotedMessageIdOf(part: Part): string | undefined {
  if (part.type === "quote") return part.messageId;
  if (part.type === "platform" && (part.tag === "quote" || part.tag === "reply")) return typeof part.attrs.id === "string" ? part.attrs.id : undefined;
  return undefined;
}

/** A part as the element it was (`at`, `img`, `quote` …, text as `text` with `content`), for checks written against those tags. */
export function partView(part: Part): PartElement {
  return part.type === "text" ? { type: "text", attrs: { content: part.text }, children: [] } : partElement(part);
}

function repeatsQuote(part: Part, quotedMessageId: string | undefined): boolean {
  return quotedMessageId !== undefined && quotedMessageIdOf(part) === quotedMessageId;
}

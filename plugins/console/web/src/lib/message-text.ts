/**
 * Stored user messages are Koishi element markup (`<at id="1"/> 你好`, escaped text) plus the bot's
 * own resource placeholders (`[图片：asset://…]`). The reader shows what a person saw instead.
 * Output is plain text for Vue interpolation; nothing here produces HTML.
 */

/** `name (id)` as stored for message senders. */
const SENDER = /^(.*\S)\s+\(([^()\s]+)\)$/;

/** Known display names by user id, from the senders of the same conversation. */
export function senderNames(senders: Iterable<string | undefined>): Map<string, string> {
  const names = new Map<string, string>();
  for (const sender of senders) {
    const match = sender ? SENDER.exec(sender) : null;
    if (match && !names.has(match[2]!)) names.set(match[2]!, match[1]!);
  }
  return names;
}

const ASSET = /\s*asset:\/\/[a-f0-9]{32}/g;
const TAG = /<(\/?)([a-z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>/gi;
const ATTR = /([\w:-]+)(?:="([^"]*)")?/g;

/** Elements that become a short bracketed label; their children are dropped. */
const LABELS: Record<string, string> = {
  img: "图片",
  image: "图片",
  video: "视频",
  audio: "语音",
  record: "语音",
  file: "文件",
  face: "表情",
  mface: "表情",
  json: "卡片",
  xml: "卡片",
  forward: "合并转发",
};

export function readableMessageText(text: string, names: ReadonlyMap<string, string> = new Map()): string {
  if (!text) return text;
  let skipping = "";
  const markup = text.replace(TAG, (_raw, closing: string, rawName: string, rawAttrs: string, selfClosing: string) => {
    const name = rawName.toLowerCase();
    if (skipping) {
      if (closing && name === skipping) skipping = "";
      return "";
    }
    if (closing) return name === "p" ? "\n" : name === "quote" || name === "reply" ? "」" : "";
    const attrs = attributes(rawAttrs);
    if (name === "at") {
      if (attrs.type === "all") return "@全体成员";
      const label = attrs.name || (attrs.id ? names.get(attrs.id) : undefined) || attrs.id;
      return label ? `@${label}` : "@";
    }
    if (name === "sharp") return `#${attrs.name || attrs.id || ""}`;
    if (name === "br") return "\n";
    if (name === "quote" || name === "reply") return selfClosing ? "" : "「";
    if (name === "author") return "";
    const label = LABELS[name];
    if (label) {
      if (!selfClosing) skipping = name;
      return name === "face" && attrs.name ? `[表情：${attrs.name}]` : `[${label}]`;
    }
    return "";
  });
  return unescape(markup)
    .replace(ASSET, "")
    .replace(/\[动画表情:\s*\[动画表情\]\s*\]/g, "[动画表情]")
    .replace(/\[(图片|视频|文件|动画表情)[：:]\s*\]/g, "[$1]");
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [, key, value] of source.matchAll(ATTR)) result[key!.toLowerCase()] = unescape(value ?? "");
  return result;
}

function unescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

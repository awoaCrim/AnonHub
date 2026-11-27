import type { AgentEntry, AgentMessage } from "@yesimbot/agent-runtime";
import { textPart, type Part } from "koishi-plugin-yesimbot/kernel";

const ASSET_ID = /^[a-f0-9]{32}$/;

export function projectAnimatedImages(entries: readonly AgentEntry[]): AgentEntry[] {
  return entries.map((entry) => {
    if (entry.type !== "message") return entry;
    const data = getMessageData(entry.data);
    if (!data) return entry;
    const parts = data.parts.map((part) => projectPart(part));
    if (parts.every((part, index) => part === data.parts[index])) return entry;
    const message = entry.data as unknown as { data: { parts: readonly Part[] } };
    return { ...entry, data: { ...message, data: { ...message.data, parts } } } as unknown as AgentEntry;
  });
}

export function isAnimatedImage(data: { sub_type?: unknown; subType?: unknown }): boolean {
  return data.sub_type === 1 || data.sub_type === "1" || data.subType === 1 || data.subType === "1";
}

/** The image summary, when present, is always shown in the placeholder. */
export function formatAnimatedImageLabel(options: { readonly summary?: unknown; readonly id?: unknown }): string {
  const parts: string[] = [];
  const summary = options.summary;
  if (typeof summary === "string" && summary.trim().length > 0) parts.push(summary.trim());
  const id = options.id;
  if (typeof id === "string" && ASSET_ID.test(id)) parts.push(`asset://${id}`);
  return parts.length > 0 ? `[动画表情: ${parts.join(" ")}]` : "[动画表情]";
}

function getMessageData(message: AgentMessage): { parts: readonly Part[] } | undefined {
  if (message.role !== "custom" || message.type !== "yesimbot.message") return undefined;
  const data = (message as { data?: unknown }).data;
  return typeof data === "object" && data !== null && "parts" in data && Array.isArray(data.parts) ? (data as { parts: readonly Part[] }) : undefined;
}

function projectPart(part: Part): Part {
  if (part.type === "image" && isAnimatedImageElement({ subType: part.subtype, summary: part.summary }))
    return textPart(formatAnimatedImageLabel({ summary: part.summary, id: part.asset }));
  if (part.type === "platform" && part.tag === "img" && isAnimatedImageElement(part.attrs))
    return textPart(formatAnimatedImageLabel({ summary: part.attrs.summary, id: part.attrs.id }));
  if ((part.type !== "quote" && part.type !== "platform") || part.parts.length === 0) return part;
  const children = part.parts.map((child) => projectPart(child));
  if (children.every((child, index) => child === part.parts[index])) return part;
  return { ...part, parts: children };
}

function isAnimatedImageElement(attrs: { summary?: unknown; sub_type?: unknown; subType?: unknown }): boolean {
  return isAnimatedImage(attrs) || (typeof attrs.summary === "string" && attrs.summary.trim().length > 0);
}

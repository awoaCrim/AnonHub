import { PLATFORMS, platformLabel } from "@yesimbot/contracts/platforms";

import type { ChatConversation } from "../../../src/shared/chat";
import type { ConversationChannelSummary } from "../state/history-types";
import { formatSessionName } from "./format";
import { isWebPlatform } from "./web-platform";

/**
 * The 对话 page's conversation list: the account holder's web conversations (the default one is the 全局大脑),
 * and every chat the bot is in on each platform. The selection lives in the URL as `c`: `web:<id>` for a web
 * conversation, a channel key for any other chat.
 */
export type TalkTarget = { kind: "web"; id: string } | { kind: "channel"; key: string };

export interface TalkItem {
  /** The `c` value that opens it. */
  value: string;
  label: string;
  /** The letter in the round avatar; the label's first letter when absent. */
  avatar?: string;
  /** One quiet line under the name: 群聊 / 私聊, or the web conversation's state. */
  note: string;
  lastActivityAt: number;
  typing?: boolean;
  channel?: ConversationChannelSummary;
}

export interface TalkGroup {
  id: string;
  label: string;
  items: TalkItem[];
}

export const WEB_PREFIX = "web:";

export function parseTarget(value: string): TalkTarget | undefined {
  if (value.startsWith(WEB_PREFIX)) return { kind: "web", id: value.slice(WEB_PREFIX.length) };
  return value ? { kind: "channel", key: value } : undefined;
}

/** The first web conversation is the 全局大脑: it can read every chat and talk to the bot in any of them. */
export const webTitle = (item: Pick<ChatConversation, "id" | "title">) => (item.id ? item.title || "新对话" : "全局大脑");

/** A chat's line under its name: the latest message (who said it, in a group), else what kind of chat it is. */
export function previewNote(channel: ConversationChannelSummary): string {
  const preview = channel.preview;
  if (!preview?.text) return channel.type === "direct" ? "私聊" : "群聊";
  if (preview.fromBot) return `我：${preview.text}`;
  return channel.type === "direct" && preview.sender !== "你" ? preview.text : `${senderName(preview.sender)}：${preview.text}`;
}

/** History names a person `名字 (号码)`; people are shown by name, the number stays for hover. */
export function senderName(sender: string | undefined): string {
  const match = /^(.+?) \(([^()]*)\)$/.exec(sender ?? "");
  return (match ? match[1] : sender)?.trim() || "对方";
}

export function talkGroups(options: {
  web: readonly ChatConversation[];
  channels: readonly ConversationChannelSummary[];
  name: (channel: ConversationChannelSummary) => string;
  query?: string;
}): TalkGroup[] {
  const keyword = options.query?.trim().toLowerCase() ?? "";
  const matches = (item: TalkItem) => !keyword || `${item.label} ${item.channel?.channelId ?? ""}`.toLowerCase().includes(keyword);
  const groups: TalkGroup[] = [];
  // The 全局大脑 first, then the others newest first.
  const web = [...options.web]
    .sort((a, b) => Number(!!a.id) - Number(!!b.id) || b.updatedAt - a.updatedAt)
    .map<TalkItem>((item) => ({
      value: `${WEB_PREFIX}${item.id}`,
      label: webTitle(item),
      note: item.typing ? "正在回复…" : item.id ? "网页对话" : "能看所有会话，能找任意会话的 bot",
      lastActivityAt: item.updatedAt,
      typing: item.typing,
    }))
    .filter(matches);
  if (web.length || !keyword) groups.push({ id: "web", label: "网页", items: web });

  const chats = options.channels.filter((channel) => !isWebPlatform(channel.platform));
  const known = PLATFORMS.map((platform) => platform.id);
  const platforms = [...new Set(chats.map((channel) => channel.platform))].sort(
    (a, b) => (known.indexOf(a) + 1 || 99) - (known.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
  for (const platform of platforms) {
    const items = chats
      .filter((channel) => channel.platform === platform)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .map<TalkItem>((channel) => ({
        value: channel.key,
        label: options.name(channel),
        note: previewNote(channel),
        lastActivityAt: channel.lastActivityAt ?? 0,
        channel,
      }))
      .filter(matches);
    if (items.length) groups.push({ id: platform, label: platformLabel(platform), items });
  }
  return groups;
}

/** What the browser last saw of each conversation, so newer activity elsewhere shows a dot. */
const SEEN_KEY = "yesimbot:talk-seen";
export function readSeen(): Record<string, number> {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(SEEN_KEY) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function writeSeen(seen: Record<string, number>) {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Private windows may refuse storage; the dots then simply reset each visit.
  }
}

/** Management selections identify a web session, not the long-lived transport channel. */
export function webHistoryTarget(channel: string, session: string): string {
  return `web-history:${encodeURIComponent(JSON.stringify([channel, session]))}`;
}

export function parseWebHistoryTarget(value: string): { channel: string; session: string } | undefined {
  if (!value.startsWith("web-history:")) return;
  try {
    const parts: unknown = JSON.parse(decodeURIComponent(value.slice("web-history:".length)));
    if (Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === "string" && part)) return { channel: parts[0], session: parts[1] };
  } catch {
    /* A malformed URL is not a conversation selection. */
  }
}

/**
 * One row per web session. A conversation keeps its first message as its title for every session it ever had, so each
 * row is named by its own session's latest message instead (user, 2026-11-20: every row read 「网页对话 · 你好」).
 * The group headers already say 网页会话, so the rows drop that prefix; the round avatar stays 「网」.
 */
export function webHistoryGroups(
  channels: readonly ConversationChannelSummary[],
  name: (channel: ConversationChannelSummary) => string,
  query = "",
): TalkGroup[] {
  const current: TalkGroup = { id: "web", label: "网页会话", items: [] };
  const archived: TalkGroup = { id: "web-archive", label: "已归档网页会话", items: [] };
  const keyword = query.trim().toLowerCase();
  for (const channel of channels.filter((channel) => channel.platform === "web")) {
    const conversation = name(channel);
    const fallback = conversation.replace(/^网页对话 · /, "");
    for (const session of channel.sessions) {
      const label = session.preview?.text || fallback;
      if (!session.size || (keyword && !`${label} ${conversation}`.toLowerCase().includes(keyword))) continue;
      const active = session.filename === channel.activeSession;
      (active ? current : archived).items.push({
        value: webHistoryTarget(channel.key, session.filename),
        label,
        avatar: "网",
        note: `${active ? "当前会话" : "已归档"} · ${formatSessionName(session.filename)}`,
        lastActivityAt: session.lastActivityAt,
        channel,
      });
    }
  }
  for (const group of [current, archived]) group.items.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return [current, archived].filter((group) => group.items.length);
}

/** Read only one web session; archived sessions must never be concatenated into a new chat. */
export function webSessionView(channel: ConversationChannelSummary, filename?: string): ConversationChannelSummary {
  const selected = filename ?? channel.activeSession;
  const sessions = channel.sessions.filter((session) => session.filename === selected);
  return {
    ...channel,
    sessions,
    activeSession: selected === channel.activeSession ? channel.activeSession : null,
    totalSizeBytes: sessions.reduce((sum, session) => sum + session.size, 0),
    lastActivityAt: sessions[0]?.lastActivityAt ?? null,
  };
}

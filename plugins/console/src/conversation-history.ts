import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Part } from "@yesimbot/contracts/parts";
import { WEB_CHAT } from "@yesimbot/contracts/platforms";
import { detectImageType } from "@yesimbot/foundation";
import {
  formatParts,
  listSessionFiles,
  readChannelManifestFile,
  readFileTailLines,
  readSessionPage,
  type ChannelManifestSummary,
  type SessionFileInfo,
} from "koishi-plugin-yesimbot/kernel";

import type { Host } from "./host.js";

const MAX_SESSION_ENTRIES = 3_000;

const MAX_ASSET_DATA_URL_BYTES = 1024 * 1024;

const COMPLETE_ASSET_ID = /^[a-f0-9]{32}$/;

// ---------- List preview: the end of the newest sessions, read once per file version ----------
const TAIL_BYTES = 64 * 1024;

const PREVIEW_CHARS = 60;

const tailCache = new Map<string, { size: number; mtime: number; tail: SessionTail }>();

export type ChannelManifest = ChannelManifestSummary;

export interface ConversationPageRequest {
  readonly limit?: number;
  readonly cursor?: string;
  /** false: assets carry their size but no `dataUrl`, and their bytes are not read. */
  readonly inlineAssets?: boolean;
  /** The time shown for a record without one; 0 when not given. */
  readonly now?: number;
}

export interface ConversationRequest extends ConversationPageRequest {
  readonly channel: string;
  readonly session: string;
}

export interface ConversationChannelSummary {
  readonly key: string;
  readonly type: "channel" | "guild" | "direct";
  readonly platform: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly userId?: string;
  readonly selfId?: string;
  readonly createdAt: string;
  readonly activeSession: string | null;
  readonly sessions: ConversationSessionSummary[];
  readonly totalSizeBytes: number;
  readonly lastActivityAt: number | null;
  /** The latest message someone could see, for the conversation list (user, 2026-11-17: 「会话管理页面优化一下」). */
  readonly preview?: ConversationPreview;
  /** A direct chat's other side as their messages name them, for when no contact list knows them (WeChat). */
  readonly peerName?: string;
}

export interface ConversationPreview {
  /** One line, clipped. */
  readonly text: string;
  /** The person who said it; absent when the bot did. */
  readonly sender?: string;
  readonly fromBot: boolean;
  readonly at: number;
}

export interface ConversationSessionSummary extends SessionFileInfo {
  /**
   * A web session's own latest visible message. Web sessions are listed one by one, and the conversation's title
   * is the same for all of them (user, 2026-11-20: every archived row read 「网页对话 · 你好」).
   */
  readonly preview?: ConversationPreview;
}

export interface ConversationIndex {
  readonly generatedAt: string;
  readonly channels: ConversationChannelSummary[];
  readonly totalChannels: number;
  readonly totalSessions: number;
  readonly totalSizeBytes: number;
}

export interface ConversationEntryView {
  readonly id: string;
  readonly timestamp: number;
  readonly kind: "user" | "assistant" | "thought" | "tool-call" | "tool-result" | "event" | "will";
  readonly text?: string;
  readonly sender?: string;
  /** The account holder's private word (`user`) or the bot's private answer to it (`assistant`). */
  readonly whisper?: boolean;
  readonly messageId?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly name?: string; readonly message?: string };
  readonly assets?: ConversationAssetView[];
  /** The web chat's clickable replies offered under this bot message. */
  readonly choices?: string[];
  readonly usage?: unknown;
  readonly finishReason?: string;
  readonly turnId?: string;
  readonly eventType?: string;
  readonly decision?: string;
  readonly willDebug?: unknown;
  readonly groupKey?: string;
  readonly sourceSession?: string;
}

export interface ConversationAssetView {
  readonly id: string;
  readonly kind: "image" | "file";
  readonly title?: string;
  readonly size: number;
  readonly dataUrl?: string;
}

export interface ConversationPage {
  readonly entries: ConversationEntryView[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface ConversationDetail extends ConversationPage {
  readonly channel: string;
  readonly session: string;
  readonly summary: {
    readonly messageCount: number;
    readonly thoughtCount: number;
    readonly toolCallCount: number;
    readonly errorCount: number;
    readonly sizeBytes: number;
  };
}

interface RawEntry {
  readonly id?: unknown;
  readonly timestamp?: unknown;
  readonly type?: unknown;
  readonly data?: unknown;
}

interface RawMessage {
  readonly id?: unknown;
  readonly role?: unknown;
  readonly type?: unknown;
  readonly content?: unknown;
  readonly data?: unknown;
  readonly usage?: unknown;
  readonly finishReason?: unknown;
}

interface SessionTail {
  readonly preview?: ConversationPreview;
  readonly peerName?: string;
}

export async function parseConversationJsonl(
  content: string,
  session: string,
  channelRoot: string,
  now = 0,
): Promise<{ entries: ConversationEntryView[]; truncated: boolean }> {
  const entries: ConversationEntryView[] = [];
  let sequence = 0;
  let truncated = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    sequence += 1;
    const parsed = await parseRawEntry(raw, session, sequence, channelRoot, now);
    if (entries.length + parsed.length > MAX_SESSION_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push(...parsed);
  }
  return { entries, truncated };
}

export async function readConversationPage(
  filePath: string,
  session: string,
  channelRoot: string,
  request: ConversationPageRequest = {},
): Promise<ConversationPage> {
  return readSessionEntries(filePath, session, channelRoot, request);
}

export async function buildConversationIndex(ctx: Host, filter?: (manifest: ChannelManifest) => boolean, strict = Boolean(filter)): Promise<ConversationIndex> {
  const channelsPath = resolveChannelsPath(ctx);
  const channels = await scanChannelSummaries(channelsPath, filter, strict);
  return {
    generatedAt: new Date(ctx.clock.now()).toISOString(),
    channels,
    totalChannels: channels.length,
    totalSessions: channels.reduce((sum, channel) => sum + channel.sessions.length, 0),
    totalSizeBytes: channels.reduce((sum, channel) => sum + channel.totalSizeBytes, 0),
  };
}

export async function readConversationDetail(
  ctx: Host,
  request: ConversationRequest,
  filter: (manifest: ChannelManifest) => boolean,
): Promise<ConversationDetail> {
  const channelsPath = resolveChannelsPath(ctx);
  const channelPath = safeJoin(channelsPath, request.channel);
  if (!channelPath) throw new Error("Invalid channel");
  const manifest = await readChannelManifestFile(join(channelPath, "channel.json"), true);
  if (!manifest || !filter(manifest)) throw new Error("Invalid channel");
  const sessionPath = safeJoin(join(channelPath, "sessions"), request.session);
  if (!sessionPath) throw new Error("Invalid session");
  const info = await stat(sessionPath);
  if (!info.isFile()) throw new Error("Session file not found");
  const parsed = await readSessionEntries(sessionPath, request.session, channelPath, { ...request, now: ctx.clock.now() });
  return {
    channel: request.channel,
    session: request.session,
    entries: parsed.entries,
    hasMore: parsed.hasMore,
    nextCursor: parsed.nextCursor,
    summary: summarizeConversationEntries(parsed.entries, info.size),
  };
}

/** Sessions of one known channel, oldest first. Unrelated channel manifests are never read. */
export async function listChannelSessions(ctx: Host, channel: string, filter: (manifest: ChannelManifest) => boolean): Promise<ConversationSessionSummary[]> {
  const channelPath = safeJoin(resolveChannelsPath(ctx), channel);
  if (!channelPath) throw new Error("Invalid channel");
  const manifest = await readChannelManifestFile(join(channelPath, "channel.json"), true);
  if (!manifest || !filter(manifest)) throw new Error("Invalid channel");
  return listSessionFiles(join(channelPath, "sessions"), true);
}

async function scanChannelSummaries(
  channelsPath: string,
  filter: ((manifest: ChannelManifest) => boolean) | undefined,
  strict: boolean,
): Promise<ConversationChannelSummary[]> {
  const entries = await readdir(channelsPath, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
    if (strict && cause.code !== "ENOENT") throw new Error("Conversation index unavailable", { cause });
    return [];
  });
  const channels: ConversationChannelSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = join(channelsPath, entry.name);
    const manifest = await readChannelManifestFile(join(root, "channel.json"), strict);
    if (!manifest || (filter && !filter(manifest))) continue;
    const sessionsPath = join(root, "sessions");
    let sessions = await listSessionFiles(sessionsPath, strict);
    if (manifest.platform === WEB_CHAT.platform) sessions = await withSessionPreviews(sessionsPath, sessions, manifest);
    const activeSession = sessions.find((session) => session.isActive)?.filename ?? null;
    const tail = await sessionTail(sessionsPath, sessions, manifest);
    channels.push({
      key: entry.name,
      type: manifest.type,
      platform: manifest.platform,
      channelId: manifest.channelId ?? manifest.guildId ?? "",
      guildId: manifest.guildId,
      userId: manifest.userId,
      selfId: manifest.selfId,
      createdAt: manifest.createdAt,
      activeSession,
      sessions,
      totalSizeBytes: sessions.reduce((sum, session) => sum + session.size, 0),
      lastActivityAt: sessions.reduce<number | null>((latest, session) => {
        if (latest === null || session.lastActivityAt > latest) return session.lastActivityAt;
        return latest;
      }, null),
      ...(tail.preview ? { preview: tail.preview } : {}),
      ...(tail.peerName ? { peerName: tail.peerName } : {}),
    });
  }
  return channels.sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
}

/** Each non-empty session with its own latest visible message; a file is read again only when its size or mtime changes. */
async function withSessionPreviews(
  sessionsPath: string,
  sessions: readonly ConversationSessionSummary[],
  manifest: ChannelManifest,
): Promise<ConversationSessionSummary[]> {
  const result: ConversationSessionSummary[] = [];
  for (const session of sessions) {
    if (!session.size) {
      result.push(session);
      continue;
    }
    const tail = await readSessionTail(join(sessionsPath, session.filename), session, manifest).catch(() => ({}) as SessionTail);
    result.push(tail.preview ? { ...session, preview: tail.preview } : session);
  }
  return result;
}

/** The newest visible message and the other side's name, from the last two non-empty session files at most. */
async function sessionTail(sessionsPath: string, sessions: readonly ConversationSessionSummary[], manifest: ChannelManifest): Promise<SessionTail> {
  let found: SessionTail = {};
  for (const session of [...sessions]
    .reverse()
    .filter((item) => item.size > 0)
    .slice(0, 2)) {
    const tail = await readSessionTail(join(sessionsPath, session.filename), session, manifest).catch(() => ({}) as SessionTail);
    found = { preview: found.preview ?? tail.preview, peerName: found.peerName ?? tail.peerName };
    if (found.preview && (found.peerName || manifest.type !== "direct")) break;
  }
  return found;
}

async function readSessionTail(path: string, session: ConversationSessionSummary, manifest: ChannelManifest): Promise<SessionTail> {
  const cached = tailCache.get(path);
  if (cached && cached.size === session.size && cached.mtime === session.lastActivityAt) return cached.tail;
  const lines = await readFileTailLines(path, session.size, TAIL_BYTES);
  let preview: ConversationPreview | undefined;
  let peerName: string | undefined;
  for (let index = lines.length - 1; index >= 0 && !(preview && (peerName || manifest.type !== "direct")); index--) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let entry: RawEntry | undefined;
    try {
      entry = objectValue(JSON.parse(line)) as RawEntry | undefined;
    } catch {
      continue;
    }
    if (!entry) continue;
    const at = numberValue(entry.timestamp) ?? session.lastActivityAt;
    const seen = previewOf(entry, at);
    if (!seen) continue;
    preview ??= seen.preview;
    if (!peerName && seen.person && seen.personId !== manifest.selfId) peerName = seen.person;
  }
  const tail: SessionTail = { ...(preview ? { preview } : {}), ...(peerName ? { peerName } : {}) };
  tailCache.set(path, { size: session.size, mtime: session.lastActivityAt, tail });
  if (tailCache.size > 2000) tailCache.delete(tailCache.keys().next().value!);
  return tail;
}

/** What a record shows in the list: someone's message, or what the bot sent (send_message or a platform copy). */
function previewOf(entry: RawEntry, at: number): { preview?: ConversationPreview; person?: string; personId?: string } | undefined {
  const line = (text: string) => {
    const flat = stripInnerThoughts(text)
      .replace(/<img\b[^>]*>/gi, "[图片]")
      .replace(/<file\b[^>]*>/gi, "[文件]")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
  };
  if (entry.type === "platform-message") {
    const data = objectValue(entry.data);
    const text = line(partsPreview(storedParts(data)));
    return text ? { preview: { text, fromBot: true, at } } : undefined;
  }
  if (entry.type !== "message") return undefined;
  const message = objectValue(entry.data) as RawMessage | undefined;
  if (message?.role === "custom" && message.type === "yesimbot.message") {
    const data = objectValue(message.data);
    const user = objectValue(data?.user);
    const name = stringValue(user?.name)?.trim();
    const id = stringValue(user?.id);
    const whisper = data?.whisper === true;
    const text = line(partsPreview(storedParts(data)));
    return {
      ...(text ? { preview: { text, sender: whisper ? "你" : name || id || "对方", fromBot: false, at } } : {}),
      ...(!whisper && name ? { person: name, personId: id } : {}),
    };
  }
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    const sent: string[] = [];
    for (const part of message.content) {
      const call = objectValue(part);
      if (call?.type !== "tool-call" || call.toolName !== "send_message") continue;
      const input = objectValue(call.input ?? call.args);
      if (Array.isArray(input?.messages)) sent.push(...input.messages.filter((item): item is string => typeof item === "string"));
      if (Array.isArray(input?.parts))
        for (const item of input.parts) {
          const value = objectValue(item);
          if (value?.kind === "text" && typeof value.text === "string") sent.push(value.text);
          else if (value?.kind === "sticker") sent.push("[表情]");
        }
    }
    const text = line(sent.join(" "));
    return text ? { preview: { text, fromBot: true, at } } : undefined;
  }
  return undefined;
}

/** A record's parts as stored; history is plain JSON, so anything else reads as none. */
function storedParts(data: Record<string, unknown> | undefined): Part[] {
  return Array.isArray(data?.parts) ? (data.parts.filter((part) => objectValue(part) && typeof objectValue(part)!.type === "string") as Part[]) : [];
}

function partsPreview(parts: readonly Part[]): string {
  try {
    return formatParts(parts);
  } catch {
    return "";
  }
}

function readSessionEntries(filePath: string, session: string, channelRoot: string, request: ConversationPageRequest): Promise<ConversationPage> {
  return readSessionPage<ConversationEntryView>(filePath, request, {
    project: (raw, line) => parseRawEntry(raw, session, line.start, channelRoot, request.now ?? 0, request.inlineAssets !== false),
    // A turn opens with what arrived: a message, or an event delivered as one. Runtime diagnostics
    // (turn.start, tool.done…) sit inside a turn and never open one.
    opensTurn: (entries, raw) => entries[0]?.kind === "user" || (entries[0]?.kind === "event" && objectValue(raw)?.type === "message"),
  });
}

function summarizeConversationEntries(entries: ConversationEntryView[], sizeBytes: number): ConversationDetail["summary"] {
  return {
    messageCount: entries.filter((entry) => entry.kind === "user" || entry.kind === "assistant").length,
    thoughtCount: entries.filter((entry) => entry.kind === "thought").length,
    toolCallCount: entries.filter((entry) => entry.kind === "tool-call").length,
    errorCount: entries.filter((entry) => entry.kind === "event" && entry.eventType?.includes("failed")).length,
    sizeBytes,
  };
}

async function parseRawEntry(
  raw: unknown,
  session: string,
  sequence: number | string,
  channelRoot: string,
  now: number,
  inline = true,
): Promise<ConversationEntryView[]> {
  const entry = objectValue(raw) as RawEntry | undefined;
  if (!entry) return [];
  const timestamp = numberValue(entry.timestamp) ?? now;
  const id = `${sequence}-${stringValue(entry.id) ?? sequence}`;
  const groupKey = stringValue(entry.id) ?? String(sequence);
  if (entry.type === "platform-message") {
    const data = objectValue(entry.data);
    const parts = storedParts(data);
    const parsed = await parseCustomMessage(
      { type: "yesimbot.message", data: { ...data, parts: parts.filter((part) => part.type === "text") } },
      { id, timestamp, groupKey, sourceSession: session },
      channelRoot,
      inline,
    );
    // What the transport sent: a kept image or file by its asset, one that was not kept by its name only.
    const assets = await resolveAssetViews(parts, channelRoot, inline, true);
    // The web chat's clickable replies under this message.
    const offered = parts.flatMap((part) => (part.type === "choices" && Array.isArray(part.options) ? part.options : []));
    const choices = [
      ...new Set(offered.filter((option): option is string => typeof option === "string" && !!option.trim()).map((option) => option.trim())),
    ].slice(0, 4);
    return parsed.map((item) => ({ ...item, kind: "assistant" as const, eventType: "platform-message", assets, ...(choices.length ? { choices } : {}) }));
  }
  if (entry.type === "message") return parseMessageEntry(entry.data, { id, timestamp, groupKey, sourceSession: session }, channelRoot, inline);
  if (entry.type === "event") {
    const event = objectValue(entry.data);
    if (event?.type === "will.decision") {
      return [
        {
          id,
          timestamp,
          kind: "will",
          eventType: "will.decision",
          decision: stringValue(event.decision),
          willDebug: event.debug,
          groupKey,
          sourceSession: session,
        },
      ];
    }
    return [
      {
        id,
        timestamp,
        kind: "event",
        eventType: stringValue(event?.type),
        text: diagnosticText(event),
        error: diagnosticError(event),
        turnId: stringValue(event?.turnId),
        groupKey,
        sourceSession: session,
      },
    ];
  }
  return [];
}

async function parseMessageEntry(
  raw: unknown,
  base: { id: string; timestamp: number; groupKey: string; sourceSession: string },
  channelRoot: string,
  inline = true,
): Promise<ConversationEntryView[]> {
  const message = objectValue(raw) as RawMessage | undefined;
  if (!message) return [];
  if (message.role === "custom") return parseCustomMessage(message, base, channelRoot, inline);
  if (message.role === "user") {
    const text = extractText(message.content);
    return text ? [{ ...base, kind: "user", text }] : [];
  }
  if (message.role === "assistant") {
    const { thoughts, visibleText } = extractAssistantContent(message.content);
    const result: ConversationEntryView[] = [];
    for (const thought of thoughts) {
      result.push({ ...base, id: `${base.id}-thought-${result.length}`, kind: "thought", text: thought });
    }
    if (visibleText) {
      result.push({
        ...base,
        id: `${base.id}-assistant`,
        kind: "assistant",
        text: visibleText,
        usage: message.usage,
        finishReason: stringValue(message.finishReason),
      });
    }
    result.push(...parseToolCalls(message.content, base));
    return result;
  }
  if (message.role === "tool") return parseToolResults(message.content, base);
  return [];
}

async function parseCustomMessage(
  message: RawMessage,
  base: { id: string; timestamp: number; groupKey: string; sourceSession: string },
  channelRoot: string,
  inline = true,
): Promise<ConversationEntryView[]> {
  if (message.type === "yesimbot.message") {
    const data = objectValue(message.data);
    const parts = storedParts(data);
    const user = objectValue(data?.user);
    const sender = typeof user?.name === "string" ? `${user.name} (${stringValue(user.id) ?? ""})` : stringValue(user?.id);
    const assets = await resolveAssetViews(parts, channelRoot, inline);
    let text = "";
    try {
      text = formatParts(parts);
    } catch {
      text = JSON.stringify(parts);
    }
    return [
      {
        ...base,
        kind: "user",
        text,
        sender: data?.whisper === true ? "主人" : sender || undefined,
        ...(data?.whisper === true ? { whisper: true } : {}),
        assets: assets.length ? assets : undefined,
        messageId: stringValue(data?.messageId),
      },
    ];
  }
  if (message.type === "yesimbot.event") {
    const data = objectValue(message.data);
    return [
      {
        ...base,
        kind: "event",
        eventType: stringValue(data?.eventType),
        text: stringValue(data?.text),
        error: diagnosticError(data),
        sourceSession: base.sourceSession,
      },
    ];
  }
  return [];
}

/**
 * The images and files of a message that are kept as channel assets. `inline` reads small ones into a
 * `dataUrl`; otherwise only their size is read. `placeholders` also lists the ones that were not kept, by name.
 */
async function resolveAssetViews(parts: readonly Part[], channelRoot: string, inline = true, placeholders = false): Promise<ConversationAssetView[]> {
  const result: ConversationAssetView[] = [];
  const visit = async (nodes: readonly Part[]): Promise<void> => {
    for (const part of nodes) {
      if (part.type === "image" || part.type === "file") {
        const kind: ConversationAssetView["kind"] = part.type;
        const id = part.asset;
        const assetPath = id && COMPLETE_ASSET_ID.test(id) ? safeJoin(join(channelRoot, "assets"), id) : undefined;
        const view = assetPath ? await readAssetView(assetPath, id!, kind, part.title, inline) : undefined;
        if (view) result.push(view);
        else if (placeholders) result.push({ id: "", kind, title: part.title, size: 0 });
      }
      if ((part.type === "quote" || part.type === "platform") && Array.isArray(part.parts)) await visit(part.parts);
    }
  };
  await visit(parts);
  return result;
}

async function readAssetView(
  path: string,
  id: string,
  kind: ConversationAssetView["kind"],
  title: string | undefined,
  inline: boolean,
): Promise<ConversationAssetView | undefined> {
  try {
    if (!inline) {
      const info = await stat(path);
      return info.isFile() ? { id, kind, title, size: info.size } : undefined;
    }
    const bytes = await readFile(path);
    const mediaType = kind === "image" ? (detectImageType(bytes) ?? "application/octet-stream") : "application/octet-stream";
    const dataUrl = bytes.byteLength <= MAX_ASSET_DATA_URL_BYTES ? `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}` : undefined;
    return { id, kind, title, size: bytes.byteLength, dataUrl };
  } catch {
    return undefined;
  }
}

function parseToolCalls(content: unknown, base: { id: string; timestamp: number; groupKey: string; sourceSession: string }): ConversationEntryView[] {
  if (!Array.isArray(content)) return [];
  const result: ConversationEntryView[] = [];
  for (const part of content) {
    const raw = objectValue(part);
    if (raw?.type !== "tool-call") continue;
    result.push({
      ...base,
      id: `${base.id}-tool-call-${result.length}`,
      kind: "tool-call",
      toolName: stringValue(raw.toolName),
      toolCallId: stringValue(raw.toolCallId),
      args: raw.args ?? raw.input,
    });
  }
  return result;
}

function parseToolResults(content: unknown, base: { id: string; timestamp: number; groupKey: string; sourceSession: string }): ConversationEntryView[] {
  if (!Array.isArray(content)) return [];
  const result: ConversationEntryView[] = [];
  for (const part of content) {
    const raw = objectValue(part);
    if (raw?.type !== "tool-result") continue;
    result.push({
      ...base,
      id: `${base.id}-tool-result-${result.length}`,
      kind: "tool-result",
      toolName: stringValue(raw.toolName),
      toolCallId: stringValue(raw.toolCallId),
      result: raw.output ?? raw.result,
      error: toolResultError(raw),
    });
  }
  return result;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const raw = objectValue(part);
      return typeof raw?.text === "string" ? raw.text : "";
    })
    .join("");
}

function extractAssistantContent(content: unknown): { thoughts: string[]; visibleText: string } {
  const thoughts: string[] = [];
  const visibleParts: string[] = [];
  if (typeof content === "string") {
    thoughts.push(...extractThoughts(content));
    const visible = stripInnerThoughts(content);
    if (visible) visibleParts.push(visible);
    return { thoughts, visibleText: visibleParts.join("\n") };
  }
  if (!Array.isArray(content)) return { thoughts, visibleText: "" };
  for (const part of content) {
    if (typeof part === "string") {
      thoughts.push(...extractThoughts(part));
      const visible = stripInnerThoughts(part);
      if (visible) visibleParts.push(visible);
      continue;
    }
    const raw = objectValue(part);
    if (!raw) continue;
    if ((raw.type === "reasoning" || raw.type === "reasoning_text" || raw.type === "thinking") && typeof raw.text === "string" && raw.text.trim()) {
      thoughts.push(raw.text.trim());
      continue;
    }
    if (raw.type === "text" && typeof raw.text === "string") {
      thoughts.push(...extractThoughts(raw.text));
      const visible = stripInnerThoughts(raw.text);
      if (visible) visibleParts.push(visible);
    }
  }
  return { thoughts, visibleText: visibleParts.join("\n") };
}

function extractThoughts(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(/<inner_thought\b[^>]*>([\s\S]*?)<\/inner_thought\s*>/gi)) {
    const thought = match[1]?.trim();
    if (thought) result.push(thought);
  }
  return result;
}

function stripInnerThoughts(text: string): string {
  return text
    .replace(/<inner_thought\b[^>]*\/>/gi, "")
    .replace(/<inner_thought\b[^>]*>[\s\S]*?<\/inner_thought\s*>/gi, "")
    .trim();
}

function resolveChannelsPath(ctx: Host): string {
  const plugins = flattenPluginConfig(ctx.loader.config.plugins ?? {});
  const coreEntry = Object.entries(plugins).find(([key]) => normalizePluginKey(key) === "yesimbot");
  const raw = coreEntry?.[1] as Record<string, unknown> | undefined;
  const basePath = typeof raw?.basePath === "string" ? raw.basePath : "data/yesimbot";
  return resolve(ctx.baseDir, basePath, "channels");
}

function flattenPluginConfig(plugins: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plugins)) {
    if (key.startsWith("group:")) {
      if (!value || typeof value !== "object") continue;
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (childKey === "$collapsed" || childKey === "$label") continue;
        result[childKey] = childValue;
      }
      continue;
    }
    result[key] = value;
  }
  return result;
}

function normalizePluginKey(key: string): string {
  const bare = key.startsWith("~") ? key.slice(1) : key;
  const instanceIndex = bare.indexOf(":");
  return instanceIndex < 0 ? bare : bare.slice(0, instanceIndex);
}

function safeJoin(root: string, segment: string): string | undefined {
  if (!segment || segment.includes("/") || segment.includes("\\") || segment.includes("..")) return undefined;
  const target = join(root, segment);
  const rel = relative(root, target);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return undefined;
  return target;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function diagnosticText(value: Record<string, unknown> | undefined): string | undefined {
  const error = objectValue(value?.error);
  return stringValue(error?.message) ?? stringValue(value?.message) ?? stringValue(value?.reason);
}

/**
 * A failed tool call. Stored results follow the AI SDK: an error is `output.type` `error-text`/`error-json`, a refusal
 * `execution-denied`; tools that report failure in their value return `ok: false`. Older records used `isError`.
 */
function toolResultError(raw: Record<string, unknown>): { name?: string; message?: string } | undefined {
  if (raw.isError) return diagnosticError(raw) ?? { message: "工具返回错误" };
  const output = objectValue(raw.output);
  if (!output) return undefined;
  if (output.type === "execution-denied") return { name: "ExecutionDenied", message: stringValue(output.reason) ?? "调用被拒绝" };
  const value = output.type === "json" || output.type === "error-json" ? objectValue(output.value) : undefined;
  if (output.type === "error-text") return { message: stringValue(output.value)?.slice(0, 500) ?? "工具返回错误" };
  if (output.type === "error-json") return diagnosticError(value) ?? { message: stringValue(value?.message) ?? "工具返回错误" };
  if (value?.ok === false) {
    const error = objectValue(value.error);
    return { name: stringValue(error?.name) ?? stringValue(value.error), message: stringValue(error?.message) ?? stringValue(value.message) ?? "工具报告失败" };
  }
  return undefined;
}

function diagnosticError(value: Record<string, unknown> | undefined): { name?: string; message?: string } | undefined {
  const error = objectValue(value?.error);
  if (!error) return undefined;
  return {
    name: stringValue(error.name),
    message: stringValue(error.message),
  };
}

import { partsFromElements, type Part } from "@yesimbot/contracts/parts";
import { logger } from "@yesimbot/foundation";
import {
  assembleEvent,
  CHANNEL_TYPE,
  fetchPlatformMedia,
  type ChannelContext,
  type ChannelResources,
  type ChannelType,
  type EventRecord,
  type Inbound,
  type MessageQuote,
  type MessageRecord,
  type RecordBase,
} from "koishi-plugin-yesimbot/kernel";

import { decodeMessage, element, type ElementView } from "./elements.js";
import type { OneBotEvent } from "./protocol.js";

const log = logger("onebot.inbound");

const KNOWN_FILE_SOURCE = /^(?:https?|data|base64|file):/i;
const DOWNLOADABLE_FILE_SOURCE = /^(?:https?|data|base64):/i;
/** Notices adapter-onebot made a Session of; it dropped every other kind. */
const NOTICES: ReadonlySet<string> = new Set([
  "group_recall",
  "friend_recall",
  "guild_channel_recall",
  "friend_add",
  "group_admin",
  "group_ban",
  "group_decrease",
  "group_increase",
  "group_card",
  "notify",
  "message_reactions_updated",
  "channel_created",
  "channel_updated",
  "channel_destroyed",
]);

/** What translating needs of the account: OneBot actions, with adapter-onebot's argument conversion applied. */
export interface InboundActions {
  /** The answer's `data`; a failed answer throws. */
  call(action: string, params: Record<string, unknown>): Promise<unknown>;
}

/**
 * The fields of the Koishi Session adapter-onebot made of an event, as Core's Koishi shell read it (removed in leave-koishi stage 8).
 */
interface OneBotSession {
  readonly kind: "message" | "poke" | "other";
  readonly selfId: string;
  readonly timestamp: number;
  readonly channelId?: string;
  /** Satori's channel type; a notice's channel has none. */
  readonly channelType?: ChannelType;
  readonly guildId?: string;
  readonly userId?: string;
  /** `event.user.name`: the sender's QQ nickname, never the group card. */
  readonly userName?: string;
  /** Koishi's `session.username`: group card, else nickname, else QQ number. */
  readonly username?: string;
  readonly messageId?: string;
  readonly elements?: ElementView[];
  readonly replyId?: unknown;
  readonly raw: OneBotEvent;
}

/**
 * The input NapCat's event is for Core, as the Koishi path made it from adapter-onebot's Session (pinned in `tests/pinned.test.ts`): same context, same
 * record. `undefined` for what never reached Core there: heartbeats and lifecycle, the account's own messages,
 * unknown notices, QQ guild events and anything without a conversation.
 */
export function inboundFromEvent(event: OneBotEvent, actions: InboundActions, now: () => number): Inbound | undefined {
  const session = sessionOf(event, now);
  if (!session) return undefined;
  // Koishi's middleware never sees the account's own messages.
  if (session.kind === "message" && session.userId === session.selfId) return undefined;
  const context = contextOf(session);
  if (!context) return undefined;
  return {
    context,
    selfId: session.selfId,
    routeId: session.messageId ?? `${event.post_type}:${now()}`,
    translate: (resources) => translate(session, resources, actions),
  };
}

function sessionOf(event: OneBotEvent, now: () => number): OneBotSession | undefined {
  // Events of the QQ guild account went to adapter-onebot's guild bot, which this connector does not have.
  if (event.self_tiny_id) return undefined;
  const selfId = `${event.self_id}`;
  if (event.post_type === "message" || event.post_type === "message_sent") return messageSession(event, selfId);
  if (event.post_type !== "notice" && event.post_type !== "request") return undefined;
  if (event.post_type === "notice" && !NOTICES.has(String(event.notice_type))) return undefined;
  let channelId = event.group_id ? `${event.group_id}` : undefined;
  let guildId = channelId;
  if (event.guild_id) guildId = `${event.guild_id}`;
  if (event.channel_id) channelId = `${event.channel_id}`;
  const userId = event.user_id ? `${event.user_id}` : undefined;
  const messageId = event.post_type === "request" ? stringOrUndefined(event.flag) : event.message_id ? `${event.message_id}` : undefined;
  const poke = event.post_type === "notice" && event.notice_type === "notify" && event.sub_type === "poke";
  if ((event.post_type === "request" && event.request_type === "friend") || (event.notice_type === "friend_recall" && userId)) channelId = `private:${userId}`;
  else if (poke) channelId ||= `private:${userId}`;
  return { kind: poke ? "poke" : "other", selfId, timestamp: now(), channelId, guildId, userId, messageId, raw: event };
}

function messageSession(event: OneBotEvent, selfId: string): OneBotSession | undefined {
  const sender = (event.sender ?? undefined) as Record<string, unknown> | undefined;
  // adapter-onebot read these unchecked; without them it threw and the event was lost.
  if (event.message_id === undefined || event.message_id === null || sender?.user_id === undefined || sender.user_id === null) return undefined;
  const decoded = decodeMessage(event.message);
  if (!decoded) return undefined;
  const direct = event.message_type === "private";
  let guildId = event.guild_id ? stringOrUndefined(event.guild_id) : event.group_id ? `${event.group_id}` : undefined;
  let channelId = event.guild_id ? stringOrUndefined(event.channel_id) : event.group_id ? `${event.group_id}` : `private:${sender.user_id}`;
  if (event.post_type === "message_sent" && !guildId) channelId = `private:${event.target_id}`;
  if (direct) {
    channelId = `private:${sender.user_id}`;
    if (event.sub_type === "group" && event.target_id) guildId = `${event.target_id}`;
  } else if (event.message_type === "group") channelId = guildId = `${event.group_id}`;
  const userId = sender.user_id ? `${sender.user_id}` : `${(sender.tiny_id as string | undefined) || sender.user_id}`;
  const nickname = sender.nickname as string | undefined;
  const card = sender.card as string | undefined;
  return {
    kind: "message",
    selfId,
    timestamp: Number(event.time) * 1000,
    channelId,
    channelType: direct ? CHANNEL_TYPE.direct : CHANNEL_TYPE.text,
    guildId,
    userId,
    userName: nickname,
    username: card || nickname || userId,
    messageId: `${event.message_id}`,
    elements: decoded.elements,
    replyId: decoded.replyId,
    raw: event,
  };
}

/** `contextFromSession`. */
function contextOf(session: OneBotSession): ChannelContext | undefined {
  const { channelId, selfId, guildId, userId } = session;
  if (!channelId || !selfId) return undefined;
  if (session.channelType === CHANNEL_TYPE.direct) {
    if (!userId) return undefined;
    return { type: "direct", platform: "onebot", channelId, selfId, userId, userName: session.username };
  }
  if (!guildId) return undefined;
  return guildId !== channelId
    ? { type: "channel", platform: "onebot", channelId, guildId, selfId }
    : { type: "guild", platform: "onebot", channelId, guildId, selfId };
}

async function translate(session: OneBotSession, resources: ChannelResources, actions: InboundActions): Promise<MessageRecord | EventRecord | null> {
  const base = recordBase(session);
  if (session.kind === "poke") return pokeEvent(base, session.raw);
  if (session.kind !== "message" || !session.elements || !session.messageId) return null;
  const parts = await persist(resources, await resolveFileSources(session, session.elements, actions));
  const quote = await persistQuote(session, resources, actions);
  return { ...base, messageId: session.messageId, parts, ...(quote ? { quote } : {}) };
}

function recordBase(session: OneBotSession): RecordBase {
  return {
    platform: "onebot",
    selfId: session.selfId,
    timestamp: session.timestamp,
    channel: { id: session.channelId ?? "", type: session.channelType ?? CHANNEL_TYPE.text },
    user: { id: session.userId || "", ...(session.userName === undefined ? {} : { name: session.userName }) },
  };
}

function pokeEvent(base: RecordBase, raw: OneBotEvent): EventRecord | null {
  const actorId = identifier(raw.user_id);
  const targetId = identifier(raw.target_id);
  if (!targetId) return null;
  return assembleEvent(base, {
    eventType: "notice.poke",
    ...(actorId ? { actorId } : {}),
    targetId,
    action: "拍了拍",
    text: `${raw.user_id} 拍了拍 ${raw.target_id}`,
  });
}

function persist(resources: ChannelResources, elements: readonly ElementView[]): Promise<Part[]> {
  return resources.persistParts(partsFromElements(elements, { sources: true }), fetchPlatformMedia);
}

/** adapter-onebot fetched the message a leading reply points at (`get_msg`); a failure leaves the record without a quote. */
async function persistQuote(session: OneBotSession, resources: ChannelResources, actions: InboundActions): Promise<MessageQuote | undefined> {
  if (session.replyId === undefined) return undefined;
  let quoted: { messageId: string; elements: ElementView[]; authorId: string } | undefined;
  try {
    const data = (await actions.call("get_msg", { message_id: session.replyId })) as Record<string, unknown>;
    const sender = data.sender as Record<string, unknown>;
    const decoded = decodeMessage(data.message);
    if (!decoded) throw new TypeError("get_msg: no message");
    quoted = {
      messageId: `${(data.message_id as { toString(): string }).toString()}`,
      elements: decoded.elements,
      authorId: `${(sender.tiny_id as string | undefined) || (sender.user_id as { toString(): string }).toString()}`,
    };
  } catch (error) {
    log.warn("quote.unavailable", { messageId: session.messageId, cause: error });
    return undefined;
  }
  if (!quoted.messageId) return undefined;
  return {
    messageId: quoted.messageId,
    parts: await persist(resources, await resolveFileSources(session, quoted.elements, actions)),
    ...(quoted.authorId ? { author: { id: quoted.authorId } } : {}),
  };
}

/** A file NapCat sent by ID gets its download URL; one it cannot resolve stays as it came. */
function resolveFileSources(session: OneBotSession, elements: readonly ElementView[], actions: InboundActions): Promise<ElementView[]> {
  return Promise.all(elements.map((view) => resolveFileSource(session, view, actions)));
}

async function resolveFileSource(session: OneBotSession, view: ElementView, actions: InboundActions): Promise<ElementView> {
  if (view.type === "file") {
    const source = attributeText(view, "src");
    if (source && KNOWN_FILE_SOURCE.test(source)) return view;
    const resolved = await resolveFileUrl(session, view, actions);
    return resolved ? element("file", { ...view.attrs, src: resolved }) : view;
  }
  if (view.children.length === 0) return view;
  return element(view.type, view.attrs, await Promise.all(view.children.map((child) => resolveFileSource(session, child, actions))));
}

async function resolveFileUrl(session: OneBotSession, view: ElementView, actions: InboundActions): Promise<string | undefined> {
  const fileId = firstAttributeText(view, ["file_id", "fileId", "file", "id"]);
  if (!fileId || KNOWN_FILE_SOURCE.test(fileId)) return undefined;
  const fileHash = firstAttributeText(view, ["file_hash", "fileHash", "hash"]);
  try {
    if (session.channelType === CHANNEL_TYPE.direct) {
      if (session.userId) {
        const data = (await actions.call("get_private_file_url", { user_id: session.userId, file_id: fileId, file_hash: fileHash })) as { url?: unknown };
        if (isDownloadable(data.url)) return data.url;
      }
    } else {
      const groupId = session.guildId || session.channelId;
      const busid = attributeNumber(view, ["busid", "bus_id"]);
      if (groupId && busid !== undefined) {
        const data = (await actions.call("get_group_file_url", { group_id: groupId, file_id: fileId, busid })) as { url?: unknown };
        if (isDownloadable(data.url)) return data.url;
      }
    }
  } catch {
    // Keep the original element when OneBot cannot resolve the attachment.
  }
  const recovered = await recoverFileUrl(session, fileId, actions);
  if (recovered) return recovered;
  log.debug("file_source_unresolved", { direct: session.channelType === CHANNEL_TYPE.direct, hasFileId: true });
  return undefined;
}

/** The file's URL from the message as `get_msg` gives it again. */
async function recoverFileUrl(session: OneBotSession, fileId: string, actions: InboundActions): Promise<string | undefined> {
  if (!session.channelId || !session.messageId) return undefined;
  try {
    const data = (await actions.call("get_msg", { message_id: session.messageId })) as { message?: unknown };
    const candidates = (decodeMessage(data.message)?.elements ?? []).filter((candidate) => candidate.type === "file");
    const matching =
      candidates.find((candidate) => firstAttributeText(candidate, ["file_id", "fileId", "file", "id"]) === fileId) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    const source = matching && attributeText(matching, "src");
    return isDownloadable(source) ? source : undefined;
  } catch {
    return undefined;
  }
}

function attributeText(view: ElementView, key: string): string | undefined {
  const value = view.attrs[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstAttributeText(view: ElementView, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attributeText(view, key);
    if (value) return value;
  }
  return undefined;
}

function attributeNumber(view: ElementView, keys: readonly string[]): number | undefined {
  const value = firstAttributeText(view, keys);
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

function isDownloadable(value: unknown): value is string {
  return typeof value === "string" && DOWNLOADABLE_FILE_SOURCE.test(value);
}

function identifier(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value);
  return normalized.length > 0 ? normalized : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : `${value}`;
}

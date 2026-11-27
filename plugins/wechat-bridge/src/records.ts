import {
  CHANNEL_TYPE,
  fetchPlatformMedia,
  partElement,
  partsFromElements,
  type ChannelContext,
  type ChannelResources,
  type Inbound,
  type MessageQuote,
  type MessageRecord,
  type Part,
  type RecordBase,
} from "koishi-plugin-yesimbot/kernel";

import type { InboundMessage } from "./connection.js";

const PLATFORM = "wechat-bridge";

/** A Satori-shaped element, plain JSON: what the Koishi adapter (removed in leave-koishi stage 8) made of parts. */
interface ElementView {
  readonly type: string;
  readonly attrs: Record<string, unknown>;
  readonly children: readonly ElementView[];
}

/**
 * The input an admitted WeChat message is for Core, as the Koishi adapter made it through a Session and Core's default
 * translator (pinned in `tests/pinned.test.ts`): same context, same record. `undefined` where there is no conversation.
 */
export function inboundFromMessage(message: InboundMessage, selfId: string): Inbound | undefined {
  const context = contextOf(message, selfId);
  if (!context) return undefined;
  return { context, selfId, routeId: message.id, translate: (resources) => recordOf(message, selfId, resources) };
}

/**
 * Parts as the Koishi path handed them on: to Satori-shaped elements and back
 * (`partsFromElements`, sources kept). Inbound records and outbound sends both went through it.
 */
export function throughElements(parts: readonly Part[]): Part[] {
  return partsFromElements(elementViews(parts), { sources: true });
}

/** The conversation of a message, as the Koishi path derived it from its Session. */
function contextOf(message: InboundMessage, selfId: string): ChannelContext | undefined {
  const channelId = message.channel.id;
  if (!channelId || !selfId) return undefined;
  if (message.channel.direct) {
    const userId = message.user.id;
    if (!userId) return undefined;
    // Koishi's `session.username`: the user's name, else the wxid.
    return { type: "direct", platform: PLATFORM, channelId, selfId, userId, userName: message.user.name || userId };
  }
  const guildId = message.group?.id;
  if (!guildId) return undefined;
  return guildId !== channelId
    ? { type: "channel", platform: PLATFORM, channelId, guildId, selfId }
    : { type: "guild", platform: PLATFORM, channelId, guildId, selfId };
}

/** Core's `translateDefault`: the quote is stored first, then the message's own parts. */
async function recordOf(message: InboundMessage, selfId: string, resources: ChannelResources): Promise<MessageRecord | null> {
  if (!message.id || !message.channel.id) return null;
  const base: RecordBase = {
    platform: PLATFORM,
    selfId,
    timestamp: message.timestamp,
    channel: {
      id: message.channel.id,
      type: message.channel.direct ? CHANNEL_TYPE.direct : CHANNEL_TYPE.text,
      ...(message.channel.name ? { name: message.channel.name } : {}),
    },
    user: { id: message.user.id || "", ...(message.user.name ? { name: message.user.name } : {}) },
  };
  const quote = await persistQuote(message, resources);
  return { ...base, messageId: message.id, parts: await persist(resources, message.parts), ...(quote ? { quote } : {}) };
}

async function persistQuote(message: InboundMessage, resources: ChannelResources): Promise<MessageQuote | undefined> {
  const source = message.quote;
  if (!source?.id) return undefined;
  const authorId = source.user?.id === undefined || source.user.id === null ? "" : String(source.user.id);
  return { messageId: source.id, parts: await persist(resources, source.parts), ...(authorId ? { author: { id: authorId } } : {}) };
}

function persist(resources: ChannelResources, parts: readonly Part[]): Promise<Part[]> {
  return resources.persistParts(throughElements(parts), fetchPlatformMedia);
}

function elementViews(parts: readonly Part[]): ElementView[] {
  return parts.map((part) => {
    if (part.type === "text") return { type: "text", attrs: { content: part.text }, children: [] };
    const view = partElement(part);
    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(view.attrs)) if (value !== undefined && value !== null) attrs[key] = value;
    return { type: view.type, attrs, children: elementViews(view.children) };
  });
}

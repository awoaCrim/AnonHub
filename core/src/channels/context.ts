import { AppError } from "@yesimbot/foundation";

import type { EventRecord, MessageRecord } from "../messages/index.js";
import { CHANNEL_ERRORS } from "./errors.js";

// ── Constants ──────────────────────────────────────────────────────────────

const DIRECT_CHANNEL_TYPE = 1 as const;

declare const _channelKeyBrand: unique symbol;

// ── Types ──────────────────────────────────────────────────────────────────

export type ChannelKey = string & { readonly [_channelKeyBrand]: "ChannelKey" };

export type ChannelContext =
  | (ChannelContextBase & { type: "channel"; guildId: string; selfId?: string; channelName?: string; guildName?: string })
  | (ChannelContextBase & { type: "guild"; guildId: string; selfId?: string; guildName?: string })
  | (ChannelContextBase & { type: "direct"; selfId: string; userId: string; userName?: string });

interface ChannelContextBase {
  type: "channel" | "guild" | "direct";
  platform: string;
  channelId: string;
}

/** Partial shape of a record that may carry guild info (EventRecord / MessageRecord). */
interface RecordWithGuild {
  guild?: { id?: string; name?: string };
  user?: { id?: string; name?: string };
}

// ── Key derivation ──────────────────────────────────────────────────────────

export function deriveChannelKey(ctx: ChannelContext): ChannelKey {
  switch (ctx.type) {
    case "channel":
      if (!ctx.platform || !ctx.guildId || !ctx.channelId) {
        throw new AppError(CHANNEL_ERRORS.channel_context_invalid, {
          detail: `deriveChannelKey: missing required fields for type "channel" (platform=${ctx.platform}, guildId=${ctx.guildId}, channelId=${ctx.channelId})`,
        });
      }
      return (
        ctx.selfId
          ? JSON.stringify(["channel-v2", ctx.platform, ctx.selfId, ctx.guildId, ctx.channelId])
          : `channel:${ctx.platform}:${ctx.guildId}:${ctx.channelId}`
      ) as ChannelKey;

    case "guild":
      if (!ctx.platform || !ctx.guildId) {
        throw new AppError(CHANNEL_ERRORS.channel_context_invalid, {
          detail: `deriveChannelKey: missing required fields for type "guild" (platform=${ctx.platform}, guildId=${ctx.guildId})`,
        });
      }
      return (ctx.selfId ? JSON.stringify(["guild-v2", ctx.platform, ctx.selfId, ctx.guildId]) : `guild:${ctx.platform}:${ctx.guildId}`) as ChannelKey;

    case "direct":
      if (!ctx.platform || !ctx.userId || !ctx.selfId) {
        throw new AppError(CHANNEL_ERRORS.channel_context_invalid, {
          detail: `deriveChannelKey: missing required fields for type "direct" (platform=${ctx.platform}, userId=${ctx.userId}, selfId=${ctx.selfId})`,
        });
      }
      return JSON.stringify(["direct-v2", ctx.platform, ctx.selfId, ctx.userId]) as ChannelKey;

    default: {
      const _exhaustive: never = ctx;
      throw new AppError(CHANNEL_ERRORS.channel_context_invalid, { detail: `deriveChannelKey: unknown type "${(_exhaustive as ChannelContext).type}"` });
    }
  }
}

export function contextFromRecord(record: MessageRecord | EventRecord): ChannelContext | undefined {
  const platform = record.platform;
  const channelId = record.channel?.id;

  if (!platform || !channelId) return undefined;

  const isDirect = record.channel?.type === DIRECT_CHANNEL_TYPE;
  const extra = record as MessageRecord & RecordWithGuild;

  if (isDirect) {
    const selfId = record.selfId;
    const userId = extra.user?.id ?? record.channel?.id;
    if (!selfId || !userId) return undefined;
    return { type: "direct", platform, channelId, selfId, userId, userName: extra.user?.name };
  }

  const guildId: string | undefined = extra.guild?.id;
  const self = record.selfId ? { selfId: record.selfId } : {};

  if (guildId && guildId !== channelId) {
    return { type: "channel", platform, channelId, guildId, ...self, channelName: record.channel?.name, guildName: extra.guild?.name };
  }

  return { type: "guild", platform, channelId, guildId: guildId ?? channelId, ...self, guildName: extra.guild?.name };
}

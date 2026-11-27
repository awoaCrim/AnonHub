import { partView, type ChannelContext, type WillPlugin } from "koishi-plugin-yesimbot/kernel";

/** A message record's channel types, as Core stores them (Satori's `Channel.Type`). */
const CHANNEL_TEXT = 0;

const CHANNEL_DIRECT = 1;

/** Elements a person sends; anything else (a notice the adapter wrote) never starts a reply by itself. */
const SPOKEN = new Set(["text", "img", "at", "quote"]);

export interface AutoReplyConfig {
  readonly allowedRooms: readonly string[];
  readonly allowedPeers: readonly string[];
  readonly autoReply?: { readonly group?: boolean; readonly direct?: boolean };
}

/**
 * Both context types are claimed, including disabled ones, so default private-chat triggering cannot bypass this
 * policy. `selfId` is the logged-in WeChat account, which is only known once the daemon reports it.
 */
export function createAutoReplyWill(config: AutoReplyConfig, selfId: () => string | undefined): WillPlugin {
  const allowed = (direct: boolean, channelId: string) => (direct ? config.allowedPeers : config.allowedRooms).includes(channelId);
  const matches = (context: ChannelContext) =>
    context.platform === "wechat-bridge" &&
    !!selfId() &&
    context.selfId === selfId() &&
    (context.type === "direct" || context.type === "guild") &&
    allowed(context.type === "direct", context.channelId);
  return {
    priority: -1000,
    match: matches,
    setup: (context) => ({
      decide(input) {
        if (!matches(context) || input.type !== "yesimbot.message") return "wait";
        const direct = context.type === "direct",
          data = input.data;
        if (!(direct ? config.autoReply?.direct : config.autoReply?.group)) return "wait";
        return data.platform === "wechat-bridge" &&
          data.selfId === selfId() &&
          data.channel.id === context.channelId &&
          data.channel.type === (direct ? CHANNEL_DIRECT : CHANNEL_TEXT) &&
          data.parts.length > 0 &&
          data.parts.every((part) => SPOKEN.has(partView(part).type))
          ? "trigger"
          : "wait";
      },
      debug: () => ({ engine: "routing", config: { direct: config.autoReply?.direct === true, group: config.autoReply?.group === true } }),
    }),
  };
}

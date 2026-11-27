/** One private transport identity per isolated runtime; never supplied by a browser. */
export const WEB_CHAT = Object.freeze({ platform: "web", selfId: "bot", userId: "owner", channelId: "owner" } as const);

/**
 * The web chat holds several conversations, each its own private chat (own history and runtime). The
 * first is `owner` (conversation ""), later ones `owner.<8 hex>`; user and channel ID are the same.
 */
export const WEB_CONVERSATION_ID = /^[0-9a-f]{8}$/;

/**
 * The OneBot 11 (NapCat) actions a QQ account declares as connector actions (spec 09 rule 6), each under
 * `oneBotActionName(action)`. An action takes the protocol's params (`oneBotArgs` applies) and resolves with the
 * answer's `data`; anything QQ refuses (retcode ≠ 0) throws. An account offers exactly what it declares.
 */
export const ONEBOT_ACTIONS = Object.freeze([
  "get_forward_msg",
  "get_image",
  "send_group_forward_msg",
  "send_private_forward_msg",
  "set_essence_msg",
  "set_msg_emoji_like",
  "ocr_image",
  "set_qq_profile",
  "set_qq_avatar",
  "set_group_ban",
  "set_group_kick",
  "get_group_member_info",
] as const);

export type OneBotAction = (typeof ONEBOT_ACTIONS)[number];
export function webChatUser(conversation: string): string {
  if (conversation && !WEB_CONVERSATION_ID.test(conversation)) throw new Error("invalid_web_conversation");
  return conversation ? `${WEB_CHAT.userId}.${conversation}` : WEB_CHAT.userId;
}
/** The conversation a web chat user/channel ID belongs to, or undefined for anything else. */
export function webChatConversation(userId: string | undefined): string | undefined {
  if (userId === WEB_CHAT.userId) return "";
  const match = /^owner\.([0-9a-f]{8})$/.exec(userId ?? "");
  return match?.[1];
}

/**
 * The chat and community platforms the product supports, in display order. Every module that
 * needs a platform's name, its adapter plugin or how it is authorized reads this list instead of
 * comparing platform IDs itself. Platforms not listed here keep generic behavior.
 */
export interface PlatformDefinition {
  /** Platform ID (`ChatAccount.platform`, a record's `platform`). */
  readonly id: string;
  readonly label: string;
  /** Plugin (base name) that connects the platform's accounts. */
  readonly adapter: string;
  /** How an account comes online: QR login through NapCat, QR login through the agent-wechat daemon, or the adapter plugin's own settings. */
  readonly login: "napcat" | "wechat" | "plugin";
  /** Plugins that only make sense on this platform (their tools are hidden elsewhere). */
  readonly plugins: readonly string[];
  /** Words for the IDs people type: a group's ID and a person's ID. */
  readonly ids: { readonly group: string; readonly direct: string };
  /** Prefix of a direct chat's channel ID, when the platform has one (`private:` on OneBot). */
  readonly directChannelPrefix?: string;
  /** A prefix the model may write before a group's channel ID (`group:` on OneBot, the form its history shows); a reply drops it. */
  readonly groupChannelPrefix?: string;
  /** Schedules may run heartbeats in its chats. */
  readonly heartbeat?: boolean;
  /**
   * Its direct chat is the owner's own chat in the console: Markdown messages with choices, tool preambles shown as
   * activity, conversations kept until the owner starts another, and heartbeats that may look across the instance.
   */
  readonly ownerChat?: boolean;
}

export const PLATFORMS: readonly PlatformDefinition[] = Object.freeze([
  {
    id: "onebot",
    label: "QQ",
    adapter: "adapter-onebot",
    login: "napcat",
    plugins: ["yesimbot-onebot-utils"],
    ids: { group: "群号", direct: "QQ 号" },
    directChannelPrefix: "private:",
    groupChannelPrefix: "group:",
    heartbeat: true,
  },
  {
    id: "wechat-bridge",
    label: "微信",
    adapter: "adapter-wechat-bridge",
    login: "wechat",
    plugins: [],
    ids: { group: "群 ID", direct: "微信号" },
  },
  {
    id: "web",
    label: "网页",
    adapter: "yesimbot-console",
    login: "plugin",
    plugins: [],
    ids: { group: "不支持群聊", direct: "账号本人" },
    ownerChat: true,
  },
] satisfies PlatformDefinition[]);

export function platformDefinition(id: string): PlatformDefinition | undefined {
  return PLATFORMS.find((platform) => platform.id === id);
}

/**
 * Platform IDs that no longer exist as platforms. Xiaoheihe became an extension (user, 2026-11-18), but the
 * conversation records it wrote stay on disk and stay readable; nothing may run on, reply to or list them as chats.
 */
const RETIRED_PLATFORMS: Readonly<Record<string, string>> = Object.freeze({ xiaoheihe: "小黑盒（旧记录）" });

export function isRetiredPlatform(id: string): boolean {
  return Object.hasOwn(RETIRED_PLATFORMS, id);
}

/** The platform's name for people, or its ID when it is not registered. */
export function platformLabel(id: string): string {
  return platformDefinition(id)?.label ?? (isRetiredPlatform(id) ? RETIRED_PLATFORMS[id] : undefined) ?? id;
}

/** The platform whose adapter is this plugin. */
export function platformOfAdapter(plugin: string): PlatformDefinition | undefined {
  return PLATFORMS.find((platform) => platform.adapter === plugin);
}

/** Whether a plugin's tools apply on a platform: platform-only plugins apply only on their own. */
export function pluginAppliesTo(plugin: string, platform: string): boolean {
  const owner = PLATFORMS.find((item) => item.plugins.includes(plugin));
  return !owner || owner.id === platform;
}

/** The channel ID of a direct chat with a user. */
export function directChannelId(platform: string, userId: string): string {
  return `${platformDefinition(platform)?.directChannelPrefix ?? ""}${userId}`;
}

/** The user ID shown for a channel ID (drops the direct-chat prefix). */
export function displayChannelId(platform: string, channelId: string): string {
  const prefix = platformDefinition(platform)?.directChannelPrefix;
  return prefix && channelId.startsWith(prefix) ? channelId.slice(prefix.length) : channelId;
}

/** The channel a reply goes to: what the model wrote, without the group prefix its history shows. */
export function replyChannelId(platform: string | undefined, channel: string): string {
  const prefix = platform === undefined ? undefined : platformDefinition(platform)?.groupChannelPrefix;
  return prefix && channel.startsWith(prefix) ? channel.slice(prefix.length) : channel;
}

/** Whether a chat is the owner's own chat in the console (`ownerChat`). */
export function isOwnerChat(platform: string, type: string): boolean {
  return platformDefinition(platform)?.ownerChat === true && type === "direct";
}

/** Whether schedules may run heartbeats in a chat: on a platform that has them, and in the owner's own chat. */
export function supportsHeartbeat(platform: string, type: string): boolean {
  return platformDefinition(platform)?.heartbeat === true || isOwnerChat(platform, type);
}

/** Structural shape of a tool policy grant rule (`ScopeRule`); kept here so this module stays dependency-free. */
export interface ToolGrantRule {
  readonly kind: "direct" | "group" | "any";
  readonly platform: string;
  readonly userId?: string;
}

/**
 * Chat tools are configured per chat kind (group or direct) only. Conversation and bot IDs in
 * older rules are ignored; a sender restriction applies when every matching rule names a user.
 * Returns undefined when everyone in that chat kind may use the enabled tools. Tool authorization
 * applies the result to group chats only; private chats are gated by the channel allowlist.
 */
export function allowedUsers(rules: readonly ToolGrantRule[], platform: string, kind: "direct" | "group"): string[] | undefined {
  const matching = rules.filter((rule) => (rule.kind === "any" || rule.kind === kind) && (rule.platform === "*" || rule.platform === platform));
  if (!matching.length || matching.some((rule) => rule.userId === undefined || rule.userId === "*")) return undefined;
  return [...new Set(matching.map((rule) => rule.userId!))];
}

/** The name a OneBot action has among an account's actions. */
export function oneBotActionName(action: OneBotAction): `onebot.${OneBotAction}` {
  return `onebot.${action}`;
}

/** adapter-onebot's argument conversion: an `*_id` that reads as a number below 2³² goes as that number, except for guild actions. */
export function oneBotArgs(action: string, params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fixed = { ...params };
  if (action.includes("guild")) return fixed;
  for (const key of Object.keys(fixed)) {
    if (!key.endsWith("_id")) continue;
    const value = Number(fixed[key]);
    if (Math.abs(value) < 4294967296) fixed[key] = value;
  }
  return fixed;
}

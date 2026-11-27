import { PLATFORMS } from "./platforms.js";

/** Platforms the fixed triggers can be turned on for: those with group chats, not the owner's own web chat. */
export const REPLY_TRIGGER_PLATFORMS = PLATFORMS.filter((platform) => !platform.ownerChat);

/** Fixed triggers only; absent configuration preserves the existing default engine. */
export const REPLY_TRIGGER_DEFAULTS = { direct: true, mention: true, all: false, online: false, quote: false, image: false, poke: false, group: false };

export type ReplyTriggerKey = keyof typeof REPLY_TRIGGER_DEFAULTS;

export interface ReplyTriggerConfig {
  platforms: string[];
  rules?: Partial<Record<ReplyTriggerKey, boolean>>;
}

export const REPLY_TRIGGER_LABELS: Record<ReplyTriggerKey, string> = {
  direct: "私聊消息",
  mention: "@机器人（QQ）",
  all: "@所有人（QQ）",
  online: "@在线成员（QQ）",
  quote: "引用 / 回复消息（QQ）",
  image: "图片消息",
  poke: "戳一戳（QQ）",
  group: "普通群消息",
};

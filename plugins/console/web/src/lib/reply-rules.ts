import { platformDefinition } from "@yesimbot/contracts/platforms";

export type RuleType = "" | "group" | "direct";

/** One Core `allowedChannels` rule: a chat (or `*`) on a platform (or `*`), optionally only its group or direct side. */
export interface ReplyRule {
  platform: string;
  channelId: string;
  isDirect?: boolean;
  [key: string]: unknown;
}

export const ruleType = (rule: ReplyRule): RuleType => (rule.isDirect === undefined ? "" : rule.isDirect ? "direct" : "group");

export const sameRule = (a: ReplyRule, b: ReplyRule) => a.platform === b.platform && a.channelId === b.channelId && ruleType(a) === ruleType(b);

/** Core `allowedChannels` as saved; entries that are not rules are kept in the list but never shown. */
export function readRules(value: unknown): unknown[] {
  return Array.isArray(value) ? (structuredClone(value) as unknown[]) : [];
}

/** The rules a platform's page lists: its own and those for every platform, in saved order. */
export function platformRules(list: unknown[], platform: string): ReplyRule[] {
  return list.filter(isRule).filter((rule) => rule.platform === platform || rule.platform === "*");
}

export function makeRule(platform: string, channelId: string, type: RuleType): ReplyRule {
  return type ? { platform, channelId, isDirect: type === "direct" } : { platform, channelId };
}

/** Checks a rule typed into 添加规则. Returns the rule, or why it cannot be added. */
export function checkRule(platform: string, input: string, type: RuleType, existing: ReplyRule[]): { rule: ReplyRule } | { error: string } {
  const channelId = input.trim();
  if (!channelId) return { error: "请填写群或联系人。" };
  if (/\s/.test(channelId)) return { error: "ID 里不能有空格。" };
  if (channelId.length > 256) return { error: "ID 太长。" };
  const rule = makeRule(platform, channelId, type);
  if (existing.some((item) => sameRule(item, rule))) return { error: "这条规则已经在列表里了。" };
  return { rule };
}

/** Adds to the latest saved list (no-op when already there); every other entry is kept as it is. */
export function withRule(list: unknown[], rule: ReplyRule, index = list.length): unknown[] {
  if (list.some((item) => isRule(item) && sameRule(item, rule))) return list;
  const next = [...list];
  next.splice(Math.min(index, next.length), 0, rule);
  return next;
}

export function withoutRule(list: unknown[], rule: ReplyRule): unknown[] {
  return list.filter((item) => !(isRule(item) && sameRule(item, rule)));
}

/** "群 100200300", "私聊 1049700117": the ID with what kind it is, without the platform's prefix. */
export function readableRule(rule: ReplyRule): string {
  if (rule.channelId === "*") return rule.isDirect === undefined ? "全部群和私聊" : rule.isDirect ? "全部私聊" : "全部群聊";
  const prefix = platformDefinition(rule.platform)?.directChannelPrefix;
  if (prefix && rule.channelId.startsWith(prefix)) return `私聊 ${rule.channelId.slice(prefix.length)}`;
  return `${rule.isDirect ? "私聊" : "群"} ${rule.channelId}`;
}

const isRule = (item: unknown): item is ReplyRule =>
  !!item && typeof item === "object" && typeof (item as ReplyRule).platform === "string" && typeof (item as ReplyRule).channelId === "string";

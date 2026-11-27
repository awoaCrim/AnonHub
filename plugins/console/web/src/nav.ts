import type { WebUIFeatures } from "../../src/shared/webui";

export type IconName =
  | "home"
  | "qq"
  | "bot"
  | "plugin"
  | "chat"
  | "chart"
  | "users"
  | "settings"
  | "spark"
  | "device"
  | "sliders"
  | "server"
  | "platform"
  | "role"
  | "history"
  | "blocks";

export type Role = "owner" | "member";

export interface NavItem {
  name: string;
  path: string;
  label: string;
  icon: IconName;
  ownerOnly?: boolean;
  feature?: keyof WebUIFeatures;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The sidebar. The product is one bot per account: every conversation it has (and the web chat with it)
 * beside its computer, friends' own bots, and how it runs. Everything that configures it is under 设置.
 */
export const pages = {
  home: { name: "home", path: "/", label: "对话", icon: "chat" },
  conversations: { name: "conversations", path: "/conversations", label: "会话管理", icon: "history" },
  friends: {
    name: "friends",
    path: "/instances",
    label: "实例",
    icon: "users",
    ownerOnly: true,
    feature: "accounts",
  },
  system: { name: "settings-system", path: "/settings/system", label: "系统", icon: "server" },
  settings: { name: "settings", path: "/settings", label: "设置", icon: "settings" },
} satisfies Record<string, NavItem>;

/**
 * 设置's own categories, in order (user, 2026-11-21: five, each answering one question). 对话 is when and how it
 * replies and how long chats are kept; 能力 holds every capability with its own connections (Google, 小黑盒) and
 * computer; 模型 the models and how they are reached. Paths are kept from earlier names for links.
 */
export const settingsPages = {
  platforms: {
    name: "settings-platforms",
    path: "/settings/platforms",
    label: "平台",
    icon: "platform",
  },
  reply: { name: "settings-reply", path: "/settings/reply", label: "对话", icon: "sliders" },
  /** 能力: what it can do and who may have it do it. The path is kept from when it was 扩展. */
  extensions: { name: "settings-extensions", path: "/settings/extensions", label: "能力", icon: "blocks" },
  models: { name: "settings-models", path: "/settings/models", label: "模型", icon: "spark" },
  system: pages.system,
} satisfies Record<string, NavItem>;

/** 设置 categories this session may open. */
export function visibleSettings(features: WebUIFeatures, role: Role): NavItem[] {
  return Object.values(settingsPages).filter((item: NavItem) => (!item.feature || features[item.feature]) && (!item.ownerOnly || role === "owner"));
}

export function sessionTopics(_features: WebUIFeatures): string[] {
  // Only sidebar data stays live. Conversations and usage belong to their visible pages.
  return ["panel", "plugins"];
}

export function visibleGroups(features: WebUIFeatures, role: Role): NavGroup[] {
  return groupsFor(role)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => (!item.feature || features[item.feature]) && (!item.ownerOnly || role === "owner")),
    }))
    .filter((group) => group.items.length);
}

function groupsFor(_role: Role): NavGroup[] {
  return [{ label: "", items: [pages.home, pages.conversations, pages.settings, pages.friends] }];
}

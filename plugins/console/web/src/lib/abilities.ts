import type { GoogleSnapshot } from "../../../src/shared/google";
import type { PluginConfigEntry } from "../../../src/shared/plugin-config";

/**
 * 能力 (user, 2026-11-21): each built-in capability is one card that says who may have the bot use it. Who may is
 * declared in code (`@yesimbot/contracts` capabilities), never configured: `admin` cards are the ones whose tools are
 * all sensitive, so only registered admins can have the bot use them. A test keeps `level` equal to the declarations.
 */
export type AbilityLevel = "all" | "admin";

/** What an opened card shows besides its switch. */
export type AbilityBody = "settings" | "memory" | "computer" | "google" | "xiaoheihe" | "image" | "none";

export interface Ability {
  readonly plugin: string;
  readonly title: string;
  readonly level: AbilityLevel;
  readonly body: AbilityBody;
}

export const ABILITIES: readonly Ability[] = [
  { plugin: "yesimbot-memorizer", title: "长期记忆", level: "all", body: "memory" },
  { plugin: "yesimbot-search-service", title: "上网搜索", level: "all", body: "settings" },
  { plugin: "yesimbot-schedule", title: "定时任务", level: "all", body: "none" },
  // Its models are chosen with it (user, 2026-11-23: 「咋不能配置生图了？」 — it had no switch anywhere).
  { plugin: "yesimbot-image-tools", title: "画图", level: "all", body: "image" },
  { plugin: "yesimbot-sticker-manager", title: "表情包", level: "all", body: "settings" },
  {
    plugin: "yesimbot-onebot-utils",
    title: "QQ 工具",

    level: "all",
    body: "settings",
  },
  { plugin: "yesimbot-xiaoheihe", title: "小黑盒", level: "all", body: "xiaoheihe" },
  { plugin: "yesimbot-workspace", title: "用电脑", level: "admin", body: "computer" },
  { plugin: "yesimbot-google", title: "Google 邮箱和日历", level: "admin", body: "google" },
  { plugin: "yesimbot-mcp-client", title: "MCP 服务", level: "admin", body: "settings" },
];

export const ABILITY_LEVELS: Record<AbilityLevel, string> = { all: "所有人能用", admin: "仅管理员" };

/** A problem the owner has to act on; shown at the top of 能力 and as a dot beside it in the settings list. */
export function abilityIssue(ability: Ability, entry: PluginConfigEntry | undefined, google?: GoogleSnapshot): string | undefined {
  if (!entry?.enabled) return;
  if (entry.status === "failed") return "出错";
  if (entry.needsConfig) return "需要设置";
  if (ability.plugin !== "yesimbot-google" || !google?.available) return;
  if (!google.configured) return "还没设置 Google 应用";
  const broken = google.accounts.filter((account) => account.needsReconnect).length;
  if (broken) return `${broken} 个账号需要重新连接`;
  if (!google.accounts.length) return "还没连接 Google 账号";
}

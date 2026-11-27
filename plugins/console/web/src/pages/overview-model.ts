import type { DeviceView } from "@yesimbot/contracts";
import { platformDefinition } from "@yesimbot/contracts/platforms";

import type { PanelPayload } from "../../../src/shared/panel";
import type { WebUIFeatures } from "../../../src/shared/webui";
import type { ConversationChannelSummary, ConversationIndex } from "../state/history-types";
import { ADAPTER_STATE, platformOff, platformSummary, presentPlatforms } from "./platforms-model";
import { optionalSetupLink } from "./setup-model";

export type Tone = "ok" | "warn" | "danger" | "";

/** One line of the bot status card on the 对话 page. */
export interface StatusRow {
  id: "platforms" | "model" | "computer";
  label: string;
  value: string;
  detail: string;
  tone: Tone;
  to: string;
}

export interface RecentConversation {
  key: string;
  label: string;
  /** Platform name shown under the conversation (QQ, 微信…). */
  platform: string;
  type: ConversationChannelSummary["type"];
  lastActivityAt: number;
  to: string;
}

/** Whether the bot can reply at all, as one tone and a short sentence. */
export function botHealth(panel: PanelPayload | undefined | null): { tone: Tone | "idle"; title: string } {
  if (!panel) return { tone: "idle", title: "正在读取" };
  const error = panel.health.botErrorCount > 0 || panel.attention.some((issue) => issue.level === "error");
  if (error) return { tone: "danger", title: panel.health.online ? "机器人有错误" : "机器人离线" };
  if (!panel.health.online) return { tone: "danger", title: "机器人离线" };
  return panel.attention.length ? { tone: "warn", title: "运行中，有事项需要处理" } : { tone: "ok", title: "运行正常" };
}

/**
 * The bot's chat platforms, reply model and computer. `computers` are the bound computers (not
 * bridges); `undefined` means the device list is unknown or this runtime has no device gateway, and
 * the computer line is then left out rather than shown as a problem.
 */
export function statusRows(panel: PanelPayload, features: Pick<WebUIFeatures, "napcat"> = { napcat: true }, computers?: readonly DeviceView[]): StatusRow[] {
  const known = presentPlatforms(panel, [], features).filter((platform) => platform.state);
  // Platforms switched off are named in the detail but are neither counted nor a problem.
  const platforms = known.filter((platform) => !platformOff(platform));
  const summary = platformSummary(known);
  const online = platforms.filter((platform) => platform.state === "online").length;
  const failing = platforms.find((platform) => platform.state === "error");
  // The link opens the platform that needs a look first.
  const focus = failing ?? platforms.find((platform) => platform.state !== "online");
  const model = modelIdentity(panel.model.chatModel);
  const rows: StatusRow[] = [
    {
      id: "platforms",
      label: "聊天平台",
      value: !summary ? "还没有接入" : platforms.length === 1 ? ADAPTER_STATE[platforms[0]!.state!] : `${online}/${platforms.length} 个在线`,
      detail: (failing && panel.adapters.find((adapter) => adapter.platform === failing.id && adapter.error)?.error) ?? summary?.label ?? "",
      tone: summary?.tone ?? "warn",
      to: focus ? `/settings/platforms?platform=${encodeURIComponent(focus.id)}` : "/settings/platforms",
    },
    {
      id: "model",
      label: "回复模型",
      value: model.modelId ?? "还没有选择",
      detail: model.provider ?? "",
      tone: panel.model.chatModel ? "ok" : "warn",
      to: "/settings/models",
    },
  ];
  if (computers) {
    const live = computers.filter((device) => !device.revokedAt);
    const up = live.filter((device) => device.online);
    rows.push({
      id: "computer",
      label: "电脑",
      value: !live.length ? "还没有接入" : !up.length ? "离线" : live.length === 1 ? "在线" : `${up.length}/${live.length} 台在线`,
      // State only, no guidance (user, 2026-11-21).
      detail: live.map((device) => device.name).join("、"),
      tone: !live.length ? "" : up.length ? "ok" : "warn",
      to: "/settings/extensions?section=yesimbot-workspace",
    });
  }
  return rows;
}

export function onboardingSteps(panel: PanelPayload, features: Pick<WebUIFeatures, "napcat"> = { napcat: true }) {
  if (panel.onboarding.complete) return [];
  // Model setup stays in the wizard; optional steps use their permanent editor.
  return panel.onboarding.steps
    .filter((step) => step.id !== "adapter" || features.napcat)
    .map((step) => ({ ...step, to: optionalSetupLink(step.id) ?? `/setup?step=${step.id}` }));
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600),
    minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

// The panel API reports memory fractions, rather than byte counts.
export function formatMemoryRatio(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? `${(value * 100).toFixed(1)}%` : "未知";
}

export function modelIdentity(value: string | null): { provider?: string; modelId?: string } {
  if (!value) return {};
  const separator = value.indexOf(":");
  return separator > 0 && separator < value.length - 1 ? { provider: value.slice(0, separator), modelId: value.slice(separator + 1) } : { modelId: value };
}

/** Most recently active sources, linked to their newest session. */
export function recentConversations(
  index: ConversationIndex | undefined,
  limit = 5,
  name?: (channel: ConversationChannelSummary) => string,
): RecentConversation[] {
  return (index?.channels ?? [])
    .filter((channel) => channel.lastActivityAt !== null && Number.isFinite(channel.lastActivityAt) && channel.sessions.length)
    .sort((a, b) => b.lastActivityAt! - a.lastActivityAt! || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((channel) => {
      const newest = [...channel.sessions].sort((a, b) => b.filename.localeCompare(a.filename))[0];
      return {
        key: channel.key,
        label: name ? name(channel) : channel.type === "direct" ? channel.userId || channel.channelId : channel.guildId || channel.channelId,
        platform: platformDefinition(channel.platform)?.label ?? channel.platform,
        type: channel.type,
        lastActivityAt: channel.lastActivityAt!,
        to: `/history/${encodeURIComponent(channel.key)}/${encodeURIComponent(newest.filename)}`,
      };
    });
}

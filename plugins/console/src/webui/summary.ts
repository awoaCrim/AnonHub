import { platformDefinition } from "@yesimbot/contracts/platforms";

import type { AdminAuth, AdminSession } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { BotSummary } from "../shared/accounts.js";
import type { PanelPayload } from "../shared/panel.js";
import type { CallCounter } from "./call-counter.js";
import { authorizeOwner } from "./plugins.js";
import type { TopicRegistry } from "./topics.js";

export const SUMMARY_PATH = "/yesimbot/api/v1/bot/summary";

interface UsageLike {
  today?: { calls?: unknown; inputTokens?: unknown; outputTokens?: unknown };
}

interface HistoryLike {
  channels?: { lastActivityAt?: unknown; type?: unknown; channelId?: unknown }[];
}

/**
 * This runtime's health for the owner's account list. The parent reads it through the
 * runtime manager, which signs in as this runtime's own administrator.
 */
export function installSummary(ctx: Host, auth: AdminAuth, topics: TopicRegistry, calls?: CallCounter) {
  ctx.server.get(SUMMARY_PATH, async (http) => {
    if (!authorizeOwner(http, auth)) return;
    http.body = await readSummary(topics, auth.sessionFromCookie(http.get("cookie"))!, calls);
  });
}

export async function readSummary(topics: TopicRegistry, session: AdminSession, calls?: CallCounter): Promise<BotSummary> {
  const read = async <T>(name: string): Promise<T | undefined> => {
    const topic = topics.get(name);
    if (!topic?.authorize(session)) return undefined;
    try {
      return (await topic.get(session)) as T;
    } catch {
      return undefined;
    }
  };
  const [panel, usage, history] = await Promise.all([read<PanelPayload | null>("panel"), read<UsageLike>("usage"), read<HistoryLike>("conversations")]);
  return projectSummary(panel ?? undefined, usage, history, calls?.today());
}

export function projectSummary(
  panel: PanelPayload | undefined,
  usage: UsageLike | undefined,
  history: HistoryLike | undefined,
  /** Counted by the console itself; used when the usage plugin is not running. */
  countedCalls?: number,
): BotSummary {
  const step = (id: string) => panel?.onboarding.steps.find((item) => item.id === id);
  const onebot = panel?.adapters.find((adapter) => platformDefinition(adapter.platform)?.login === "napcat");
  const calls = number(usage?.today?.calls) ?? countedCalls ?? null;
  const input = number(usage?.today?.inputTokens),
    output = number(usage?.today?.outputTokens);
  const channels = history?.channels ?? [];
  const times = channels.map((channel) => channel.lastActivityAt).filter((value): value is number => number(value) !== null);
  const recent = channels
    .filter((channel) => number(channel.lastActivityAt) !== null && typeof channel.channelId === "string")
    .sort((a, b) => (b.lastActivityAt as number) - (a.lastActivityAt as number))
    .slice(0, 5)
    .map((channel) => ({
      type: (["channel", "guild", "direct"].includes(channel.type as string) ? channel.type : "channel") as "channel" | "guild" | "direct",
      channelId: (channel.channelId as string).slice(0, 64),
      at: channel.lastActivityAt as number,
    }));
  return {
    qqOnline: panel ? onebot?.state === "online" : null,
    modelReady: step("model")?.done ?? null,
    roleReady: step("role")?.done ?? null,
    allowedChannels: panel ? panel.config.allowedChannels : null,
    todayCalls: calls,
    lastActivityAt: history ? (times.length ? Math.max(...times) : null) : null,
    attention: panel ? panel.attention.length : null,
    chatModel: panel ? panel.model.chatModel : null,
    todayTokens: input === null && output === null ? null : (input ?? 0) + (output ?? 0),
    ...(panel
      ? {
          plugins: panel.plugins
            .filter((plugin) => plugin.enabled)
            .map((plugin) => plugin.label.slice(0, 40))
            .slice(0, 40),
          issues: panel.attention.map((issue) => issue.message.slice(0, 120)).slice(0, 5),
        }
      : {}),
    failures: panel ? panel.recent.length : null,
    conversations: history ? channels.length : null,
    uptimeSeconds: panel ? panel.health.uptimeSeconds : null,
    ...(history ? { recent } : {}),
  };
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

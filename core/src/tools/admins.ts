import type { AgentMessage } from "@yesimbot/agent-runtime";
import { WEB_CHAT } from "@yesimbot/contracts/platforms";

import type { ChannelContext } from "../channels/context.js";
import type { AdminAccount } from "../config.js";

/**
 * Who may have the bot run a sensitive tool (user, 2026-11-18: 「只有系统维护的平台的那个管理员可以调用敏感工具」).
 * Admins are the accounts the account holder registered per platform in the console (Core `admins`); whoever is
 * logged in to the web chat always is one. The model and chat content can never add one.
 */
export const ADMIN_ONLY_REASON =
  "这是敏感操作，只有管理员（账号持有人在控制台登记的账号，或网页对话里登录的人）能让你执行，这一轮的发起人不是管理员。不要换别的工具或交给后台绕过，简短告诉对方这件事需要管理员来要求。";

type AdminScope = Pick<ChannelContext, "platform" | "type"> & { readonly userId?: string };

function registered(admins: readonly AdminAccount[] | undefined, platform: string): Set<string> {
  return new Set(
    (admins ?? [])
      .filter((admin) => admin?.platform === platform && typeof admin.userId === "string")
      .map((admin) => admin.userId.trim())
      .filter(Boolean),
  );
}

/** With no speaker (a scheduled check, a task report), only an admin's own private chat counts as the admin asking. */
function adminConversation(scope: AdminScope, ids: Set<string>): boolean {
  return scope.type === "direct" && !!scope.userId && ids.has(scope.userId);
}

/**
 * Whether everyone behind the current turn is an admin. The speakers are the senders of this turn's chat messages;
 * a message without a sender fails closed. The account holder's private word from the console is an admin's.
 */
export function adminTurn(scope: AdminScope, admins: readonly AdminAccount[] | undefined, messages: readonly AgentMessage[]): boolean {
  if (scope.platform === WEB_CHAT.platform) return true;
  const ids = registered(admins, scope.platform);
  const speakers = new Set<string>();
  let whisper = false;
  for (const message of messages) {
    if (message.role !== "custom" || message.type !== "yesimbot.message") continue;
    const data = message.data as { readonly user?: { readonly id?: unknown }; readonly whisper?: unknown } | undefined;
    if (data?.whisper === true) {
      whisper = true;
      continue;
    }
    const id = data?.user?.id;
    if (typeof id !== "string" || !id) return false;
    speakers.add(id);
  }
  if (speakers.size) return [...speakers].every((id) => ids.has(id));
  return whisper || adminConversation(scope, ids);
}

/** A background task acts for the request that created it; without one, for its conversation. */
export function adminSource(
  scope: AdminScope,
  admins: readonly AdminAccount[] | undefined,
  source: { readonly actorIds: readonly string[] } | undefined,
): boolean {
  if (scope.platform === WEB_CHAT.platform) return true;
  const ids = registered(admins, scope.platform);
  if (source?.actorIds.length) return source.actorIds.every((id) => ids.has(id));
  return adminConversation(scope, ids);
}

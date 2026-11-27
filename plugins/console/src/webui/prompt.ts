import { isRetiredPlatform, WEB_CHAT } from "@yesimbot/contracts/platforms";

import type { AdminAuth } from "../admin-auth.js";
import { buildConversationIndex } from "../conversation-history.js";
import type { Host } from "../host.js";
import type { PromptOverview } from "../shared/prompt.js";
import { channelContext, Conversations } from "./global-brain.js";
import { chatHistory } from "./history.js";
import { authorizeOwner } from "./plugins.js";

export const PROMPT_PATH = "/yesimbot/api/v1/prompt";

/**
 * Read-only: the prompt one conversation's model receives, section by section with its source, as its
 * runtime froze it. Without `channel`, the most recently active conversation. Nothing here writes.
 */
export function installPromptOverview(ctx: Host, auth: AdminAuth) {
  const conversations = new Conversations(ctx);
  ctx.server.get(PROMPT_PATH, async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const index = await buildConversationIndex(ctx, chatHistory, false);
    const names = new Map((await conversations.list().catch(() => [])).map((item) => [item.summary.key, item.name]));
    const choices = index.channels
      .filter((channel) => !isRetiredPlatform(channel.platform) && channelContext(channel))
      .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
    const requested = typeof http.query.channel === "string" ? http.query.channel : "";
    const chosen = requested ? choices.find((channel) => channel.key === requested) : choices[0];
    if (!chosen) {
      http.status = requested ? 404 : 409;
      http.body = { message: requested ? "conversation_not_found" : "no_conversation" };
      return;
    }
    try {
      const preview = await ctx.yesimbot.conversation.prompt(channelContext(chosen)!);
      http.body = {
        conversation: chosen.key,
        conversations: choices.slice(0, 50).map((channel) => ({
          key: channel.key,
          label: channel.platform === WEB_CHAT.platform ? "网页对话" : (names.get(channel.key) ?? channel.channelId),
          kind: channel.type === "direct" ? "私聊" : "群聊",
          platform: channel.platform,
        })),
        ...preview,
      } satisfies PromptOverview;
    } catch (cause) {
      http.status = 503;
      http.body = { message: cause instanceof Error && cause.message === "bot_unavailable" ? "bot_unavailable" : "runtime_not_ready" };
    }
  });
}

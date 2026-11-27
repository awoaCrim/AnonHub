import type { ScopeRule, ToolPolicy } from "@yesimbot/contracts";
import type { ChannelContext } from "koishi-plugin-yesimbot";
export const identity = {
  conversation: async (scope: ChannelContext) => ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    botId: scope.selfId || "bot",
    platform: scope.platform,
    kind: scope.type === "direct" ? ("direct" as const) : ("group" as const),
    conversationId: scope.channelId,
  }),
};
export function policy(actors: ScopeRule[] = [{ kind: "any", platform: "*", conversationId: "*" }], tools = ["*"]): ToolPolicy {
  return { version: 1, direct: { enabled: true, tools }, group: { enabled: true, tools }, actors };
}

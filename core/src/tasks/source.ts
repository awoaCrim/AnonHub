import type { AgentMessage } from "@yesimbot/agent-runtime";

import type { ChannelContext } from "../channels/index.js";

/** Host-captured identity only. No message body, model arguments or cross-conversation target. */
export interface TaskSource {
  readonly platform: string;
  readonly selfId: string;
  readonly channelId: string;
  readonly kind: "direct" | "group";
  readonly actorIds: readonly string[];
  readonly messageIds: readonly string[];
}

export function isTaskSource(value: unknown): value is TaskSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as TaskSource;
  return (
    identifier(source.platform) &&
    identifier(source.selfId) &&
    identifier(source.channelId) &&
    ["direct", "group"].includes(source.kind) &&
    Array.isArray(source.actorIds) &&
    source.actorIds.length > 0 &&
    source.actorIds.length <= 32 &&
    source.actorIds.every(identifier) &&
    Array.isArray(source.messageIds) &&
    source.messageIds.length > 0 &&
    source.messageIds.length <= 32 &&
    source.messageIds.every(identifier)
  );
}

export function taskSourceMatchesScope(source: TaskSource, scope: ChannelContext): boolean {
  return (
    isTaskSource(source) &&
    source.platform === scope.platform &&
    source.selfId === scope.selfId &&
    source.channelId === scope.channelId &&
    source.kind === (scope.type === "direct" ? "direct" : "group") &&
    (source.kind !== "direct" || (scope.type === "direct" && !!scope.userId && source.actorIds.every((actor) => actor === scope.userId)))
  );
}

/** Capture only a real request in the host's fixed origin. Events cannot borrow earlier actors. */
export function captureTaskSource(scope: ChannelContext | undefined, messages: readonly AgentMessage[]): TaskSource | undefined {
  if (!scope?.selfId || !messages.length || messages.length > 32) return;
  const actors = new Set<string>(),
    ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "custom" || message.type !== "yesimbot.message") return;
    const input = message.data;
    if (
      input.whisper ||
      input.platform !== scope.platform ||
      input.selfId !== scope.selfId ||
      input.channel.id !== scope.channelId ||
      (input.channel.type === 1) !== (scope.type === "direct") ||
      !identifier(input.user.id) ||
      !identifier(input.messageId)
    )
      return;
    actors.add(input.user.id);
    ids.add(input.messageId);
  }
  const source: TaskSource = {
    platform: scope.platform,
    selfId: scope.selfId,
    channelId: scope.channelId,
    kind: scope.type === "direct" ? "direct" : "group",
    actorIds: [...actors],
    messageIds: [...ids],
  };
  return taskSourceMatchesScope(source, scope) ? source : undefined;
}

const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;

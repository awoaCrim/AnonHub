/** Stable filesystem names shared by runtime and explicit offline migration. */
export function encodeStorageSegment(value: string): string {
  return [...value].map((char) => (/[A-Za-z0-9]/.test(char) ? char : `%${char.codePointAt(0)!.toString(16)}%`)).join("");
}
export interface ChannelStorageIdentity {
  type: "channel" | "guild" | "direct";
  platform: string;
  channelId: string;
  guildId?: string;
  selfId?: string;
  userId?: string;
}
export function channelStorageDirectory(scope: ChannelStorageIdentity): string {
  const e = encodeStorageSegment;
  if (!scope.platform || !scope.channelId) throw new Error("invalid_channel_storage_identity");
  if (scope.type === "direct") {
    if (!scope.userId || !scope.selfId) throw new Error("invalid_direct_storage_identity");
    return ["direct", e(scope.platform), e(scope.userId), e(scope.selfId)].join("-");
  }
  if (!scope.guildId) throw new Error("invalid_group_storage_identity");
  return [
    scope.type,
    e(scope.platform),
    e(scope.guildId),
    ...(scope.type === "channel" ? [e(scope.channelId)] : []),
    ...(scope.selfId ? ["bot", e(scope.selfId)] : []),
  ].join("-");
}

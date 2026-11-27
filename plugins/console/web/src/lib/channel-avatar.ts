import type { ConversationChannelSummary } from "../state/history-types";

/** QQ shows its own picture for a group or a person; other platforms (and odd ids) get none. */
export function channelAvatar(channel?: ConversationChannelSummary): string {
  if (!channel || channel.platform !== "onebot") return "";
  if (channel.type === "direct") {
    const id = channel.userId ?? channel.channelId.replace(/^private:/, "");
    return /^[1-9]\d{4,11}$/.test(id) ? `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=100` : "";
  }
  const id = channel.guildId ?? channel.channelId;
  return /^[1-9]\d{4,11}$/.test(id) ? `https://p.qlogo.cn/gh/${id}/${id}/100` : "";
}

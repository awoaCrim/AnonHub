import { formatPart, type ChannelContext, type MessageRecord } from "koishi-plugin-yesimbot/kernel";

/** Exact transport ownership; a name, matching numeric ID or group membership grants nothing. */
export function sameConversation(left: ChannelContext, right: ChannelContext): boolean {
  return (
    left.type === right.type &&
    left.platform === right.platform &&
    left.selfId === right.selfId &&
    left.channelId === right.channelId &&
    (left.type === "direct" ? right.type === "direct" && left.userId === right.userId : right.type !== "direct" && left.guildId === right.guildId)
  );
}

export function messageInConversation(message: MessageRecord, context: ChannelContext): boolean {
  if (!message.messageId || !message.user?.id || !Array.isArray(message.parts) || !Number.isFinite(message.timestamp)) return false;
  if (message.whisper || message.platform !== context.platform || message.selfId !== context.selfId || message.channel?.id !== context.channelId) return false;
  if ((message.channel.type === 1) !== (context.type === "direct")) return false;
  // A direct conversation's input may include the bot's actual delivered messages.
  return context.type !== "direct" || message.user?.id === context.userId || message.user?.id === context.selfId;
}

export function normalizedContent(content: string): string {
  return content.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function containsCredential(text: string): boolean {
  return /-----BEGIN .*PRIVATE KEY-----|\bsk-[a-z\d_-]{12,}|\bBearer\s+[a-z\d._-]{12,}|(?:password|passwd|api[_ -]?key|access[_ -]?token|密码|密钥)\s*(?:[:=：]|是)\s*["']?\S{4,}/i.test(
    text,
  );
}

/** Readable text of a stored message, by Core's own renderer so placeholders match model history. */
export function messageText(message: Pick<MessageRecord, "parts">): string {
  return message.parts
    .map((part) => {
      try {
        return formatPart(part);
      } catch {
        return "[内容无法显示]";
      }
    })
    .join("");
}

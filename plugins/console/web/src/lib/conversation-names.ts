import { platformDefinition, webChatConversation } from "@yesimbot/contracts/platforms";

import type { ContactsResponse } from "../../../src/shared/contacts";
import type { ConversationChannelSummary } from "../state/history-types";
import { isWebPlatform } from "./web-platform";

/** Presentation only: never rewrite a persisted source key or merge history. */
export function conversationName(channel: ConversationChannelSummary, contacts?: ContactsResponse, webTitles?: ReadonlyMap<string, string>): string {
  // The web chat is the account holder's own private chats with the bot: the first one, then named ones.
  if (isWebPlatform(channel.platform)) {
    const conversation = webChatConversation(channel.userId);
    return conversation ? `网页对话 · ${webTitles?.get(conversation) || "新对话"}` : "网页对话";
  }
  const fallback = (channel.type === "direct" ? channel.userId : channel.guildId) || channel.channelId;
  const prefix = platformDefinition(channel.platform)?.directChannelPrefix;
  const normalize = (id: string) => (channel.type === "direct" && prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id);
  const ids = new Set([fallback, channel.channelId].map(normalize));
  const names = new Set(
    (contacts?.bots ?? [])
      .filter((bot) => bot.platform === channel.platform && (!channel.selfId || bot.selfId === channel.selfId))
      .flatMap((bot) => bot.contacts)
      .filter((contact) => contact.direct === (channel.type === "direct") && ids.has(normalize(contact.channelId)))
      .map((contact) => contact.name.trim())
      .filter(Boolean),
  );
  // Without a contact list (WeChat, an offline QQ), a direct chat is named as the other side names themselves.
  return names.size === 1 ? [...names][0]! : (channel.type === "direct" && channel.peerName) || fallback;
}

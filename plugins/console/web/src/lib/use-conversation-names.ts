import { onBeforeUnmount, shallowRef } from "vue";

import type { ChatSnapshot } from "../../../src/shared/chat";
import type { ContactsResponse } from "../../../src/shared/contacts";
import type { ConversationChannelSummary } from "../state/history-types";
import { api } from "./api";
import { conversationName } from "./conversation-names";

export function useConversationNames() {
  const contacts = shallowRef<ContactsResponse>();
  let disposed = false;
  onBeforeUnmount(() => {
    disposed = true;
  });
  // Uses the same contact endpoint as reply scope; it never blocks history.
  void api<ContactsResponse>("/yesimbot/api/v1/bot/contacts")
    .then((value) => {
      if (!disposed) contacts.value = value;
    })
    .catch(() => {});
  // Web conversations are named by their titles; members and older servers simply have none.
  const webTitles = shallowRef<Map<string, string>>();
  void api<ChatSnapshot>("/yesimbot/api/v1/chat")
    .then((value) => {
      if (!disposed) webTitles.value = new Map((value.conversations ?? []).map((item) => [item.id, item.title]));
    })
    .catch(() => {});
  return (channel: ConversationChannelSummary) => conversationName(channel, contacts.value, webTitles.value);
}

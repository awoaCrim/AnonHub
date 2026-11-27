/** Reply-scope picker DTOs. `channelId` is exactly what the core allow rules match against. */
export interface ContactEntry {
  channelId: string;
  name: string;
  direct: boolean;
}

export interface BotContacts {
  platform: string;
  selfId: string;
  name: string;
  contacts: ContactEntry[];
  /** True when listing stopped at the cap or timed out. */
  partial: boolean;
}

export interface ContactsResponse {
  bots: BotContacts[];
}

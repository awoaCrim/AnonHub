export interface ConversationRequest {
  channel: string;
  session: string;
  limit?: number;
  cursor?: string;
}

export interface ConversationSessionSummary {
  filename: string;
  isActive: boolean;
  size: number;
  createdAt: string;
  lastActivityAt: number;
  /** A web session's own latest visible message (web sessions are listed one by one). */
  preview?: { text: string; sender?: string; fromBot: boolean; at: number };
}

export interface ConversationChannelSummary {
  key: string;
  type: "channel" | "guild" | "direct";
  platform: string;
  channelId: string;
  guildId?: string;
  userId?: string;
  selfId?: string;
  createdAt: string;
  activeSession: string | null;
  sessions: ConversationSessionSummary[];
  totalSizeBytes: number;
  lastActivityAt: number | null;
  /** The latest message someone could see (the bot's own replies included). */
  preview?: { text: string; sender?: string; fromBot: boolean; at: number };
  /** A direct chat's other side as their messages name them. */
  peerName?: string;
}

export interface ConversationIndex {
  generatedAt: string;
  channels: ConversationChannelSummary[];
  totalChannels: number;
  totalSessions: number;
  totalSizeBytes: number;
}

export interface ConversationEntryView {
  id: string;
  timestamp: number;
  kind: "user" | "assistant" | "thought" | "tool-call" | "tool-result" | "event" | "will";
  text?: string;
  sender?: string;
  /** The account holder's private word (`user`) or the bot's private answer to it (`assistant`). */
  whisper?: boolean;
  messageId?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  error?: { name?: string; message?: string };
  assets?: ConversationAssetView[];
  usage?: unknown;
  finishReason?: string;
  turnId?: string;
  eventType?: string;
  decision?: string;
  willDebug?: unknown;
  groupKey?: string;
  sourceSession?: string;
}

export interface ConversationAssetView {
  id: string;
  kind: "image" | "file";
  title?: string;
  size: number;
  dataUrl?: string;
}

export interface ConversationDetail {
  channel: string;
  session: string;
  entries: ConversationEntryView[];
  hasMore: boolean;
  nextCursor?: string;
  summary: {
    messageCount: number;
    thoughtCount: number;
    toolCallCount: number;
    errorCount: number;
    sizeBytes: number;
  };
}

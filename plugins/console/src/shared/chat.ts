/** Changes to the list of conversations or to one conversation's choices. */
export type ChatConversationRequest =
  | { action: "create" }
  | { action: "select"; id: string }
  | { action: "update"; id: string; title?: string; roleCard?: string | null; chatModel?: string | null }
  | { action: "remove"; id: string };

/** Standalone WebUI chat DTOs. This module has no server dependencies. */
export interface ChatAttachment {
  kind: "image" | "file";
  name: string;
  /** Where the console shows it (same-origin, owner-only); absent when it was not kept. */
  url?: string;
  size?: number;
}

/** `GET /yesimbot/api/v1/chat/uploads`: images can be sent whenever Core runs; other files need the conversation's computer. */
export interface ChatUploadStatus {
  available: boolean;
  /** A connected computer takes other files (and keeps a copy of images). */
  files?: boolean;
  /** The computer's limit for one file. */
  maxBytes: number;
  imageMaxBytes?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  at: number;
  status?: "sending" | "sent" | "failed";
  attachments?: ChatAttachment[];
  /** A bot message's clickable replies; a click sends the option as the user's next message. */
  choices?: string[];
  /** The bot's emoji reaction to a user message. */
  reaction?: string;
}

/** One of the web chat's conversations, each its own private chat with the bot. */
export interface ChatConversation {
  /** "" is the first conversation. */
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Absent: the current role card from 设置. "": no role card. Otherwise a role card ID. */
  roleCard?: string;
  /** Absent: the reply model from 设置. Otherwise a full model ID. */
  chatModel?: string;
  /** It is replying in this conversation right now. */
  typing?: boolean;
}

export interface ChatModelChoice {
  id: string;
  label: string;
}

export interface ChatSnapshot {
  /** Computer resolved by the same workspace binding used by the bot. */
  computerDeviceId?: string;
  /** The open conversation (`id`) and where its history is. */
  conversation: { platform: "web"; channel: string; session: string; id?: string };
  messages: ChatMessage[];
  typing: boolean;
  /** Ephemeral public action description; never a persisted message. */
  activity?: string;
  /** This conversation's recent computer and browser work. */
  /** Every conversation, newest first. Absent from servers with a single web chat. */
  conversations?: ChatConversation[];
  /** Reply models a conversation can choose. */
  models?: ChatModelChoice[];
  /** The reply model from 设置, which conversations without their own choice use. */
  defaultModel?: string;
}

export interface ChatSendRequest {
  uploads?: string[];
  text: string;
  clientId: string;
  /** The conversation the message is for; the open one when absent. */
  conversation?: string;
}

export interface ChatSendResponse {
  messageId: string;
}

/** `POST /yesimbot/api/v1/conversations/whisper`: the account holder's private word to the bot in one conversation. */
export interface WhisperRequest {
  /** The conversation's history key, as listed on the 对话 page. */
  channel: string;
  text: string;
  /** UUID; a repeat within ten minutes is accepted again without a second word. */
  clientId: string;
}

export interface WhisperResponse {
  accepted: true;
}

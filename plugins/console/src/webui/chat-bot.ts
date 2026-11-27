import { WEB_CHAT, webChatUser } from "@yesimbot/contracts/platforms";
import type { ChannelContext, CoreService } from "koishi-plugin-yesimbot/kernel";

import type { ChatAttachment } from "../shared/chat.js";

export const webChatContext: ChannelContext = { type: "direct", ...WEB_CHAT };

export const WEB_CHAT_TRANSPORT = Symbol.for("yesimbot.console.web-chat-transport");

/** An attachment as the transport saw it. `src` and `uri` stay on the server: only names and console URLs are shown. */
export interface ProjectedAttachment {
  kind: ChatAttachment["kind"];
  name: string;
  /** The source of an image or file Core read for a send. */
  src?: string;
  /** A chat upload's `workspace:///` reference. */
  uri?: string;
}

export interface ProjectedChat {
  text: string;
  attachments: ProjectedAttachment[];
  choices: string[];
}

/** The web chat's account in Core: the only way a console message becomes an inbound message. */
export interface WebChatTransport {
  readonly [WEB_CHAT_TRANSPORT]: true;
  isOnline(): boolean;
  /** One owner message: resolves once Core has admitted and stored it, and rethrows a refusal. */
  receive(
    username: string,
    text: string,
    messageId: string,
    timestamp: number,
    conversation?: string,
    files?: readonly { uri?: string; asset?: string; name: string; kind: string }[],
    authenticated?: () => boolean,
  ): Promise<void>;
  /** Fresh authentication check shared by instance services and private owner memory. */
  isAuthenticatedContext(context: ChannelContext): boolean;
  /** Bind one operation to the ingress session that authorized it, even if a later login sends another message. */
  captureAuthentication(context: ChannelContext): () => boolean;
  /** A transport from another runtime cannot administer this ConfigStore. */
  belongsToRuntime(core: CoreService): boolean;
}

export function isWebChatTransport(value: unknown): value is WebChatTransport {
  return typeof value === "object" && value !== null && (value as Partial<WebChatTransport>)[WEB_CHAT_TRANSPORT] === true;
}

/** The private chat of one web conversation ("" is the first). */
export function webConversationContext(conversation: string): ChannelContext {
  const userId = webChatUser(conversation);
  return { type: "direct", platform: WEB_CHAT.platform, selfId: WEB_CHAT.selfId, userId, channelId: userId };
}

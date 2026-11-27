/** Shapes of the agent-wechat daemon's `/v1` API (pinned v3.0.0-beta.3) that YesImBot reads. Unknown fields are ignored. */

export type LoginState =
  | "starting"
  | "resuming"
  | "awaiting_scan"
  | "awaiting_approval"
  | "authenticating"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "rejected"
  | "needs_login";

export type SendState = "queued" | "submitting" | "accepted" | "failed" | "needs_review" | "cancelled";

export interface AgentWechatAccount {
  readonly id: string;
  readonly alias: string | null;
  /** The logged-in user's own wxid; null until the account has logged in once. */
  readonly ownUsername: string | null;
  readonly authenticated: boolean;
  readonly connection: "online" | "reconnecting" | "disconnected";
}

export interface AgentWechatOperation {
  readonly id: string;
  readonly accountId: string;
  readonly kind: string;
  readonly state: string;
  readonly result: Record<string, unknown> | null;
}

export interface AgentWechatEvent {
  /** Decimal, per account, monotonic. */
  readonly cursor: string;
  readonly kind: string;
  readonly data: Record<string, unknown>;
  readonly createdAt: string;
}

export interface AgentWechatMentions {
  readonly state: "known" | "unknown";
  readonly userIds: readonly string[];
  readonly self: boolean | null;
  readonly all: boolean | null;
}

export interface AgentWechatQuote {
  readonly serverId: string;
  readonly type: number;
  readonly state?: "embedded" | "missing" | "unsupported" | "recalled";
  readonly senderId?: string;
  readonly senderName?: string;
  readonly embeddedText?: string;
  readonly embeddedImage?: boolean;
  readonly embeddedLink?: AgentWechatLink | null;
  readonly embeddedSticker?: boolean;
  readonly appMessageType?: number;
}

export interface AgentWechatLink {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly url?: string | null;
}

export interface AgentWechatMessage {
  /** Opaque daemon ID ("msg_…"); not the WeChat server ID. */
  readonly id: string;
  readonly threadId: string;
  /** WeChat's message ID as a decimal string. */
  readonly serverId: string | null;
  readonly senderId: string | null;
  /** 1 text, 3 image, 34 voice, 43 video, 47 sticker, 48 location, 49 app message, 10000 system. */
  readonly type: number;
  readonly appMessageType?: number;
  readonly quote?: AgentWechatQuote;
  readonly link?: AgentWechatLink;
  readonly recall?: unknown;
  readonly direction: "incoming" | "outgoing" | null;
  readonly body: string | null;
  readonly createdAt: string | null;
  readonly mentions?: AgentWechatMentions;
}

export interface AgentWechatThread {
  readonly id: string;
  readonly kind?: "direct" | "group" | "system";
  readonly displayName?: string | null;
}

export interface AgentWechatGroupMember {
  readonly username: string;
  /** The account's remark for them, else their name in the group, else their nickname. */
  readonly displayName?: string | null;
  readonly roomDisplayName?: string | null;
  readonly nickname?: string | null;
}

/** A group's saved profile. */
export interface AgentWechatGroup {
  readonly id: string;
  readonly displayName?: string | null;
  readonly ownerId?: string | null;
  /** Null when the saved data cannot say; the owner is listed only when WeChat lists them too. */
  readonly administratorIds?: readonly string[] | null;
}

export interface AgentWechatContact {
  readonly username: string;
  readonly displayName?: string | null;
}

export interface AgentWechatMediaAsset {
  readonly id: string;
  readonly kind: "image" | "file" | "video" | "voice" | "sticker";
  readonly variant: string;
  readonly state: "pending" | "available" | "expired" | "unsupported";
  readonly contentType: string | null;
  readonly byteLength: number | null;
  /** The size WeChat announced before the download, when known. */
  readonly advertisedByteLength?: number | null;
  readonly filename?: string | null;
  readonly jobId: string | null;
}

/** A text send. */
export interface AgentWechatSendIntent {
  readonly id: string;
  readonly state: SendState;
  /** WeChat's message ID once accepted. */
  readonly serverId: string | null;
  readonly errorCode: string | null;
  /** The daemon's stored copy of the outgoing message, once projected. */
  readonly localMessageId?: string;
}

/** A media send or download. */
export interface AgentWechatMediaJob {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly reason: string | null;
  readonly assetId: string | null;
  /** WeChat's message ID once a send is accepted. */
  readonly serverMessageId: string | null;
}

export interface AgentWechatUpload {
  readonly id: string;
  readonly byteLength: number;
}

export interface TextSendRequest {
  readonly kind: "text";
  readonly threadId: string;
  readonly text: string;
  readonly quote?: { readonly messageId: string; readonly serverId: string };
  readonly mentions?: { readonly userIds?: readonly string[]; readonly all?: boolean };
}

export interface MediaSendRequest {
  readonly kind: "image" | "file" | "video";
  readonly threadId: string;
  readonly sourceId: string;
}

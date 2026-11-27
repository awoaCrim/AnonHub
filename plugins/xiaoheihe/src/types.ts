export type ReplyPreflightError = "reply_target_unavailable" | "reply_target_changed" | "reply_preflight_failed";

export type PublicationVerification =
  | { kind: "comment"; postId: string; contentHash: string; replyTarget?: { id: string; rootId: string; authorId: string; textHash: string } }
  | { kind: "post"; contentHash: string; titleHash: string; topicIds?: string[] };

export interface PostSummary {
  id: string;
  authorId: string;
  title: string;
  text: string;
  source?: string;
  /** Publication time from upstream create_at (Unix seconds), normalized to ISO 8601 UTC. Absent means unknown. */
  publishedAt?: string;
}

export interface Comment {
  id: string;
  authorId: string;
  text: string;
  rootId: string;
  /** Same publication-time contract as PostSummary; never the notification or fetch time. */
  publishedAt?: string;
  replyToId?: string;
  replyToAuthorId?: string;
  /** Set on a floor's root when the post page shows only part of its 楼中楼; read them with read_replies. */
  moreReplies?: true;
}

export interface Community {
  id: string;
  name: string;
  description?: string;
}

export interface PostDetail extends PostSummary {
  comments: Comment[];
  commentsComplete?: boolean;
  /** Https image URLs of the post body; never shown to the model, which sees downloaded assets. */
  imageUrls?: string[];
}

export interface ReplyTarget {
  id: string;
  rootId: string;
  authorId: string;
  text: string;
}

export interface Receipt {
  notSent?: true;
  errorCode?: ReplyPreflightError | "authentication_required" | "captcha_required" | "rate_limited" | "publication_verification_pending";
  accepted: boolean;
  verified: boolean;
  id?: string;
  /** Exact evidence for later read-only verification; never contains the publication body. */
  verification?: PublicationVerification;
}

export interface XiaoheiheApi {
  emojis?(): Promise<unknown>;
  login(): Promise<{ userId: string; username?: string }>;
  /** The account's home recommendation feed. */
  feed(limit: number): Promise<PostSummary[]>;
  /** Hot posts of one community (topic id). */
  community(id: string, limit: number): Promise<PostSummary[]>;
  findCommunities(keyword: string, limit: number): Promise<Community[]>;
  search(keyword: string, limit: number): Promise<PostSummary[]>;
  post(id: string): Promise<PostDetail>;
  /** One page of a floor: its root comment followed by its 楼中楼. */
  thread(postId: string, rootId: string, cursor?: string): Promise<{ detail: PostDetail; nextCursor?: string }>;
  publish(title: string, content: string, communities: string[]): Promise<Receipt>;
  comment(postId: string, content: string, target?: ReplyTarget): Promise<Receipt>;
  /** Bounded GET-only verification of an existing publication receipt. */
  verifyPublication?(id: string, verification: PublicationVerification): Promise<boolean>;
  close(): Promise<void>;
}

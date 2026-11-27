import { contentHash } from "@yesimbot/foundation";

import { errorCodeOf } from "./errors.js";
import type { PostDetail, PublicationVerification, ReplyTarget } from "./types.js";

export const publicationHash = (text: string): string => contentHash(text);

export function commentVerification(postId: string, content: string, target?: ReplyTarget): Extract<PublicationVerification, { kind: "comment" }> {
  return {
    kind: "comment",
    postId,
    contentHash: publicationHash(content),
    ...(target ? { replyTarget: { id: target.id, rootId: target.rootId, authorId: target.authorId, textHash: publicationHash(target.text) } } : {}),
  };
}

/** A different own reply, an edited target, or an incomplete relationship is never proof. */
export function matchesComment(detail: PostDetail, selfId: string, id: string, evidence: Extract<PublicationVerification, { kind: "comment" }>): boolean {
  if (detail.id !== evidence.postId) return false;
  const own = detail.comments.filter((comment) => comment.id === id);
  if (own.length !== 1 || own[0]!.text.length > 2000 || own[0]!.authorId !== selfId || publicationHash(own[0]!.text) !== evidence.contentHash) return false;
  const target = evidence.replyTarget;
  if (!target) return own[0]!.rootId === id && own[0]!.replyToId === undefined;
  const targets = detail.comments.filter((comment) => comment.id === target.id);
  return (
    targets.length === 1 &&
    targets[0]!.text.length <= 2000 &&
    targets[0]!.rootId === target.rootId &&
    targets[0]!.authorId === target.authorId &&
    publicationHash(targets[0]!.text) === target.textHash &&
    own[0]!.rootId === target.rootId &&
    own[0]!.replyToId === target.id &&
    (own[0]!.replyToAuthorId === undefined || own[0]!.replyToAuthorId === target.authorId)
  );
}

export function publicationError(error: unknown): string {
  const code = errorCodeOf(error);
  return [
    "authentication_required",
    "captcha_required",
    "rate_limited",
    "publication_receipt_missing",
    "publication_verification_pending",
    "target_quarantined",
    "new_post_quarantined",
    "reply_target_unavailable",
    "reply_target_changed",
    "reply_preflight_failed",
    "account_paused",
    "account_closed",
    "account_identity_mismatch",
    "daily_limit",
    "duplicate_action",
    "read_only",
    "read_post_first",
    "already_commented",
    "invalid_target",
    "invalid_publication_text",
    "unknown_reply_target",
    "ambiguous_reply_target",
    "post_requires_title_and_body",
    "invalid_post_title_or_body",
  ].includes(code)
    ? code
    : "publication_request_failed";
}

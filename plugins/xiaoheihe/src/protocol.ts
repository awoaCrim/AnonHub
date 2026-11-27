import { AppError, systemClock, type Clock } from "@yesimbot/foundation";

import type { Comment, PostDetail, PostSummary } from "./types.js";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_upstream_response", { effect: "none" });
  return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new AppError("invalid_identifier", { effect: "none" });
  if (typeof value !== "string" && typeof value !== "number") throw new AppError("invalid_identifier", { effect: "none" });
  const id = String(value);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new AppError("invalid_identifier", { effect: "none" });
  return id;
}

export function normalizePosts(value: unknown, clock: Clock = systemClock()): PostSummary[] {
  const data = record(value);
  const result = data.result === undefined ? data : record(data.result);
  const items = data.posts ?? result.links ?? result.link_list ?? result.list ?? result.items;
  if (!Array.isArray(items)) throw new AppError("invalid_post_list", { effect: "none" });
  return items.slice(0, 100).flatMap((value) => {
    const item = record(value);
    const post = item.link ? record(item.link) : item.info ? record(item.info) : item;
    return post.linkid === undefined && post.link_id === undefined ? [] : [summary(post, clock)];
  });
}

export function normalizePost(value: unknown, expectedId: string, clock: Clock = systemClock()): PostDetail {
  const result = record(record(value).result);
  const link = record(result.link);
  const post = summary(link, clock);
  if (post.id !== expectedId) throw new AppError("post_identity_mismatch", { effect: "none" });
  assertBinding(link, ["linkid", "link_id"], expectedId, "post_identity_mismatch");
  let body = text(link.text);
  const images: unknown[] = Array.isArray(link.imgs) ? [...link.imgs] : [];
  if (body.startsWith("[")) {
    try {
      const blocks: unknown = JSON.parse(body);
      if (Array.isArray(blocks))
        body = blocks
          .slice(0, 100)
          .map((value) => {
            const block = record(value);
            if (block.type === "img") images.push(block.url ?? block.src);
            if (block.type === "html") images.push(...htmlImages(text(block.text)));
            return block.type === "text" ? text(block.text) : block.type === "html" ? plainText(text(block.text)) : "";
          })
          .filter(Boolean)
          .join("\n")
          .slice(0, 20000);
    } catch {
      /* The original string remains untrusted post text. */
    }
  } else if (/<\/?[a-z][^>]*>/i.test(body)) {
    images.push(...htmlImages(body));
    body = plainText(body);
  }
  const comments: Comment[] = [];
  const scoped = result.current_comment;
  if (!Array.isArray(result.comments) && !(result.comments === undefined && scoped != null)) throw new AppError("invalid_comment_list", { effect: "none" });
  // A scoped floor can be absent from every ordinary page, including the latest page.
  const floors = [...(scoped == null ? [] : [scoped]), ...(Array.isArray(result.comments) ? result.comments.slice(0, 100) : [])];
  const seen = new Map<string, Comment>();
  const conflictingTimes = new Set<string>();
  let complete = scoped == null && result.has_more_floors === 0 && result.total_page === 1;
  for (const value of floors) {
    const floor = record(value);
    if (!Array.isArray(floor.comment) || !floor.comment.length) continue;
    const rootId = identifier(record(floor.comment[0]).commentid);
    assertBinding(floor, ["linkid", "link_id"], expectedId, "post_identity_mismatch");
    assertBinding(floor, ["root_id", "root_comment_id"], rootId, "reply_root_mismatch");
    let floorMore = false;
    for (const value of floor.comment.slice(0, 100)) {
      const c = record(value);
      const id = identifier(c.commentid);
      assertBinding(c, ["linkid", "link_id"], expectedId, "post_identity_mismatch");
      // Root comments may explicitly use the same -1 sentinel as the create endpoint.
      for (const field of ["root_id", "root_comment_id"])
        if (c[field] != null && !(id === rootId && String(c[field]) === "-1") && String(c[field]) !== rootId)
          throw new AppError("reply_root_mismatch", { effect: "none" });
      if (c.has_more) {
        complete = false;
        floorMore = true;
      }
      const reply = c.replyid ?? c.reply_id;
      if (c.replyid != null && c.reply_id != null && String(c.replyid) !== String(c.reply_id)) throw new AppError("reply_target_mismatch", { effect: "none" });
      const replyUser = c.replyuser && typeof c.replyuser === "object" ? record(c.replyuser).userid : undefined;
      const publishedAt = publicationTime(c.create_at, clock);
      const comment: Comment = {
        id,
        authorId: identifier(c.userid ?? record(c.user).userid),
        // Preserve one overflow character so a 2000-char publication cannot match a truncated prefix.
        text: text(c.text, 2001),
        rootId,
        ...(publishedAt ? { publishedAt } : {}),
        ...(reply === undefined || reply === null || String(reply) === "-1" ? {} : { replyToId: identifier(reply) }),
        ...(replyUser === undefined || replyUser === null ? {} : { replyToAuthorId: identifier(replyUser) }),
      };
      if (c.user != null) assertBinding(record(c.user), ["userid"], comment.authorId, "comment_author_mismatch");
      const previous = seen.get(id);
      if (previous) {
        if (
          previous.authorId !== comment.authorId ||
          previous.text !== comment.text ||
          previous.rootId !== comment.rootId ||
          previous.replyToId !== comment.replyToId ||
          previous.replyToAuthorId !== comment.replyToAuthorId
        )
          throw new AppError("conflicting_comment", { effect: "none" });
        if (!conflictingTimes.has(id)) {
          if (previous.publishedAt && comment.publishedAt && previous.publishedAt !== comment.publishedAt) {
            delete previous.publishedAt;
            conflictingTimes.add(id);
          } else if (!previous.publishedAt && comment.publishedAt) previous.publishedAt = comment.publishedAt;
        }
      } else if (comments.length < 100) {
        seen.set(id, comment);
        comments.push(comment);
      } else complete = false;
    }
    const root = seen.get(rootId);
    if (floorMore && root?.id === rootId) root.moreReplies = true;
  }
  const imageUrls = imageList(images);
  return { ...post, text: body, comments, commentsComplete: complete, ...(imageUrls.length ? { imageUrls } : {}) };
}

function assertBinding(value: Record<string, unknown>, fields: readonly string[], expected: string, error: string): void {
  if (fields.some((field) => value[field] != null && String(value[field]) !== expected)) throw new AppError(error, { effect: "none" });
}

function text(value: unknown, max = 20000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function summary(value: unknown, clock: Clock): PostSummary {
  const p = record(value);
  const publishedAt = publicationTime(p.create_at, clock);
  return {
    id: identifier(p.linkid ?? p.link_id),
    authorId: identifier(p.userid ?? record(p.user).userid),
    title: text(p.title, 200),
    text: readable(text(p.description ?? p.text, 1000)),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

/** The upstream CLI reads post/comment create_at as Unix seconds. Do not guess other fields or units. */
function publicationTime(value: unknown, clock: Clock): string | undefined {
  const seconds = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > clock.now() / 1000) return;
  return new Date(seconds * 1000).toISOString();
}

function readable(value: string): string {
  return /<\/?[a-z][^>]*>/i.test(value) ? plainText(value) : value;
}

/** Readable text of a rich-text body: block tags become line breaks, other tags are dropped. */
function plainText(html: string): string {
  return html
    .replace(/<(?:br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `<img src>` / `data-original` of rich-text bodies. */
function htmlImages(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*?\b(?:data-original|src)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]!);
}

/** Distinct https image URLs (strings or `{url}` objects), bounded. */
function imageList(values: readonly unknown[]): string[] {
  const urls = new Set<string>();
  for (const value of values) {
    const raw = typeof value === "string" ? value : value && typeof value === "object" ? (value as { url?: unknown }).url : undefined;
    if (typeof raw !== "string" || raw.length > 1000) continue;
    try {
      const url = new URL(raw.replace(/&amp;/g, "&"));
      if (url.protocol === "https:") urls.add(url.href);
    } catch {
      /* Not a URL. */
    }
    if (urls.size >= 9) break;
  }
  return [...urls];
}

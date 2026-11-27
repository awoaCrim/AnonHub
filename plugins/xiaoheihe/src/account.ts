import { AppError, contentHash, formatForModel, systemClock, type Clock } from "@yesimbot/foundation";

import type { Config } from "./config.js";
import { commentVerification, matchesComment, publicationError, publicationHash } from "./delivery.js";
import { EmojiCatalog, emojiPrompt, normalizeEmojiText } from "./emojis.js";
import { errorCodeOf } from "./errors.js";
import { identifier } from "./protocol.js";
import { AccountStore, canIsolateUncertain, dayKey, quarantineSummary, type Activity } from "./store.js";
import type { Community, PostDetail, PostSummary, Receipt, ReplyTarget, XiaoheiheApi } from "./types.js";

/** Posts fetched from the home feed, one community or one search. */
const LIST_POSTS = 10;

/** Posts kept in memory for publication targeting. */
const MAX_OBSERVED_POSTS = 50;

/** Pauses that stop reads too; an uncertain-delivery pause only guards publishing. */
const READ_SAFE_PAUSES = new Set(["uncertain_delivery", "operator"]);

type PublishRequest = { kind: "post"; title: string; body: string } | { kind: "comment"; postId: string; body: string; quoteId?: string };

/**
 * The bound Xiaoheihe account as an on-demand toolbox. It never runs on its own: reading is for any
 * conversation, publishing is serialized, limited per day and quarantines an uncertain result so the
 * same text is never sent twice.
 */
export class Account {
  private readonly emojiCatalog: EmojiCatalog;
  private readonly observed = new Map<string, PostDetail>();
  /** Communities seen in search results this session, so browse_community can name them. */
  private readonly communities = new Map<string, Community>();
  private sends: Promise<unknown> = Promise.resolve();
  private closed = false;
  private halted = false;
  private reconcileCursor = 0;
  /** Notified after the account pauses itself, e.g. when the login is no longer valid. */
  onPaused?: (reason: string) => void;

  constructor(
    readonly config: Config,
    private readonly api: XiaoheiheApi,
    readonly store: AccountStore,
    private readonly clock: Clock = systemClock(),
  ) {
    this.emojiCatalog = new EmojiCatalog(
      () => (api.emojis ? api.emojis() : Promise.reject(new AppError("emoji_catalog_unavailable", { effect: "none" }))),
      clock,
    );
  }

  async nativeEmojiPrompt(): Promise<string> {
    return this.config.nativeEmojis === false ? "" : emojiPrompt(await this.emojiCatalog.get());
  }

  async normalizePublication(text: string): Promise<string> {
    return normalizeEmojiText(text, this.config.nativeEmojis === false ? [] : await this.emojiCatalog.get());
  }

  get readOnly(): boolean {
    return this.config.dailyPostLimit === 0 && this.config.dailyInteractionLimit === 0;
  }

  /** The session is no longer accepted upstream; reading and publishing wait for a new login. */
  get loginRequired(): boolean {
    return this.store.snapshot().paused === "authentication_required";
  }

  recordActivity(activity: Omit<Activity, "id" | "at">): Promise<void> {
    return this.store.recordActivity(activity, this.clock.now());
  }

  async checkIdentity(): Promise<void> {
    const login = await this.remote(() => this.api.login());
    if (login.userId !== this.config.selfId) {
      await this.pause("account_identity_mismatch");
      throw new AppError("account_identity_mismatch", { effect: "none" });
    }
    // Recover only the old uncertainty pause with a known target ledger. Other pauses stay global.
    if (this.store.snapshot().paused === "uncertain_delivery" && canIsolateUncertain(this.store.snapshot())) {
      await this.store.update((state) => {
        if (state.paused === "uncertain_delivery" && canIsolateUncertain(state)) state.paused = null;
      });
      await this.recordActivity({ kind: "resume", outcome: "ok", source: "targeted_isolation" });
    }
  }

  /**
   * Exact receipt-bound read-only follow-up of publications whose result was uncertain, run once at
   * startup. Legacy rows without evidence stay isolated. Rotates so one invisible publication cannot
   * starve the rest.
   */
  async reconcileUncertain(): Promise<void> {
    if (this.closed || this.halted) return;
    const uncertain = this.store.snapshot().actions.filter((action) => action.status === "uncertain" && action.id && action.verification);
    if (!uncertain.length) return;
    const selected = Array.from({ length: Math.min(3, uncertain.length) }, (_, index) => uncertain[(this.reconcileCursor + index) % uncertain.length]!);
    this.reconcileCursor = (this.reconcileCursor + selected.length) % uncertain.length;
    for (const action of selected) {
      if (this.closed) return;
      try {
        const evidence = action.verification!;
        if (evidence.kind === "comment" && (action.kind !== "interaction" || action.target !== `post:${this.config.selfId}:${evidence.postId}`)) continue;
        if (evidence.kind === "post" && (action.kind !== "post" || action.target !== `account:${this.config.selfId}`)) continue;
        let verified = false;
        if (this.api.verifyPublication) verified = await this.remote(() => this.api.verifyPublication!(action.id!, evidence));
        else if (evidence.kind === "comment") {
          const detail = evidence.replyTarget
            ? (await this.remote(() => this.api.thread(evidence.postId, evidence.replyTarget!.rootId))).detail
            : await this.remote(() => this.api.post(evidence.postId));
          verified = matchesComment(detail, this.config.selfId, action.id!, evidence);
        }
        if (!verified) continue;
        await this.store.update((state) => {
          const current = state.actions.find((item) => item.key === action.key && item.status === "uncertain" && item.id === action.id);
          if (!current) return;
          current.status = "sent";
          if (evidence.kind === "comment" && !evidence.replyTarget)
            state.commentedPostIds = [...new Set([...state.commentedPostIds, evidence.postId])].slice(-2000);
        });
        await this.recordActivity({
          kind: "reconcile",
          outcome: "ok",
          postId: evidence.kind === "comment" ? evidence.postId : action.id,
          source: evidence.kind === "post" ? "uncertain_post" : evidence.replyTarget ? "uncertain_reply" : "uncertain_comment",
        });
      } catch {
        /* Stays quarantined. */
      }
    }
  }

  /**
   * A post as the model reads it: the freshly read post (with 楼中楼 it expanded earlier), up to four of its
   * pictures stored through `loadImages`, and how to treat them.
   */
  async readPostView(id: string, loadImages?: (urls: readonly string[]) => Promise<string[]>) {
    const detail = await this.readPost(id);
    const count = detail.imageUrls?.length ?? 0;
    let images: string[] = [];
    if (count && loadImages) images = await loadImages(detail.imageUrls!.slice(0, 4)).catch(() => []);
    return {
      ...this.view(this.observed.get(detail.id) ?? detail, images),
      ...(count
        ? {
            imageNote: images.length
              ? `帖子带 ${count} 张图，images 里是其中 ${images.length} 张；要说图里的内容，先用 read 看过。没看过的图不要描述或评价。`
              : `帖子带 ${count} 张图，这次看不到；不要描述或评价图片内容。`,
          }
        : {}),
    };
  }

  /** What the model sees of a post: image URLs are replaced by a count and any loaded assets. */
  view(detail: PostDetail, images: readonly string[] = []) {
    const { imageUrls, ...shown } = detail;
    return {
      ...shown,
      currentTime: formatForModel(this.clock.now(), this.clock),
      publishedAt: this.shownTime(detail.publishedAt),
      comments: detail.comments.map((comment) => ({ ...comment, publishedAt: this.shownTime(comment.publishedAt) })),
      ...(imageUrls?.length ? { imageCount: imageUrls.length, ...(images.length ? { images } : {}) } : {}),
    };
  }

  /** A publication time as the model reads it (one format with `currentTime`); unknown stays an explicit null. */
  private shownTime(publishedAt: string | undefined): string | null {
    return publishedAt ? formatForModel(Date.parse(publishedAt), this.clock) : null;
  }

  /** Keep unknown publication times explicit in every model-facing discovery tool. */
  viewPosts(posts: readonly PostSummary[]) {
    return posts.map((post) => ({ ...post, publishedAt: this.shownTime(post.publishedAt) }));
  }

  async readPost(id: string): Promise<PostDetail> {
    this.assertReadable();
    identifier(id);
    const post = await this.remote(() => this.api.post(id));
    if (post.id !== id) throw new AppError("post_identity_mismatch", { effect: "none" });
    this.remember(post);
    return post;
  }

  /**
   * The current view of a post for reply targeting. 楼中楼 loaded through read_replies stay
   * known when the post page is read again, because that page only previews each floor.
   */
  private remember(post: PostDetail): void {
    const previous = this.observed.get(post.id);
    const known = new Set(post.comments.map((comment) => comment.id));
    const expanded = previous?.comments.filter((comment) => !known.has(comment.id) && comment.id !== comment.rootId && known.has(comment.rootId)) ?? [];
    const merged = expanded.length ? { ...post, comments: [...post.comments, ...expanded] } : post;
    this.observed.delete(post.id);
    this.observed.set(post.id, merged);
    if (this.observed.size > MAX_OBSERVED_POSTS) this.observed.delete(this.observed.keys().next().value!);
  }

  /** One page of a floor's 楼中楼, for a post already read with read_post. */
  async readReplies(postId: string, commentId: string, cursor?: string) {
    this.assertReadable();
    const observed = this.observed.get(identifier(postId));
    if (!observed) throw new AppError("read_post_first", { effect: "none" });
    const anchor = observed.comments.find((comment) => comment.id === identifier(commentId));
    if (!anchor) throw new AppError("unknown_comment", { effect: "none" });
    const page = await this.remote(() => this.api.thread(postId, anchor.rootId, cursor === undefined ? undefined : identifier(cursor)));
    // The post may have been re-read while this page loaded; merge into the newest view.
    const current = this.observed.get(postId) ?? observed;
    const known = new Set(current.comments.map((comment) => comment.id));
    this.remember({ ...current, comments: [...current.comments, ...page.detail.comments.filter((comment) => !known.has(comment.id))] });
    return {
      postId,
      rootId: anchor.rootId,
      currentTime: formatForModel(this.clock.now(), this.clock),
      postPublishedAt: this.shownTime(page.detail.publishedAt),
      replies: this.view(page.detail).comments,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : { complete: true }),
    };
  }

  /** The account's home recommendation feed. */
  async feed(): Promise<PostSummary[]> {
    this.assertReadable();
    return this.remote(() => this.api.feed(LIST_POSTS));
  }

  async findCommunities(keyword: string): Promise<Community[]> {
    this.assertReadable();
    const found = await this.remote(() => this.api.findCommunities(keyword, 10));
    for (const community of found) this.communities.set(community.id, community);
    return found;
  }

  /** Hot posts of a community. */
  async browseCommunity(id: string): Promise<{ community: Community; posts: PostSummary[] }> {
    this.assertReadable();
    const known = this.communities.get(identifier(id));
    const community: Community = { id, name: known?.name ?? id };
    const posts = (await this.remote(() => this.api.community(id, LIST_POSTS))).map((post) => ({ ...post, source: `community:${community.name}` }));
    return { community, posts };
  }

  async search(keyword: string): Promise<PostSummary[]> {
    this.assertReadable();
    if (!keyword.trim() || keyword.length > 200) throw new AppError("invalid_keyword", { effect: "none" });
    return this.remote(() => this.api.search(keyword, LIST_POSTS));
  }

  /** Recorded locally or visible on the freshly read post (covers comments made before this record existed). */
  private hasTopLevelComment(post: PostDetail): boolean {
    if (this.store.snapshot().commentedPostIds.includes(post.id)) return true;
    return post.comments.some((comment) => comment.authorId === this.config.selfId && comment.rootId === comment.id && comment.replyToId === undefined);
  }

  /** A new post. The id is the upstream post id. */
  publishPost(title: string, content: string): Promise<{ id: string }> {
    return this.publish({ kind: "post", title: title.trim(), body: content.trim() });
  }

  /** A top-level comment, or (with `replyToCommentId`) a reply under another account's comment. The post must have been read first. */
  publishComment(postId: string, text: string, replyToCommentId?: string): Promise<{ id: string }> {
    return this.publish({ kind: "comment", postId, body: text.trim(), ...(replyToCommentId ? { quoteId: replyToCommentId } : {}) });
  }

  private publish(request: PublishRequest): Promise<{ id: string }> {
    const isPost = request.kind === "post";
    const quoted = request.kind === "comment" && request.quoteId !== undefined;
    const source = isPost ? "post" : quoted ? "reply" : "comment";
    const postId = request.kind === "comment" ? request.postId : undefined;
    const work = this.sends.then(async () => {
      if (this.readOnly) {
        await this.recordActivity({ kind: "send", outcome: "blocked", source, errorCode: "read_only" });
        throw new AppError("read_only", { effect: "none" });
      }
      try {
        const id = await this.publishOnce(request);
        await this.recordActivity({ kind: "send", outcome: "ok", postId: isPost ? id : postId, source, count: 1 });
        return { id };
      } catch (error) {
        // The uncertainty branch records its precise cause once, before returning the generic tool error.
        if (errorCodeOf(error) !== "uncertain_delivery")
          await this.recordActivity({ kind: "send", outcome: "failed", postId, source, errorCode: publicationError(error) });
        throw error;
      }
    });
    this.sends = work.catch(() => {});
    return work;
  }

  private async publishOnce(request: PublishRequest): Promise<string> {
    this.assertWritable();
    const isPost = request.kind === "post";
    const channelId = isPost ? `account:${this.config.selfId}` : `post:${this.config.selfId}:${request.postId}`;
    const quoteId = request.kind === "comment" ? request.quoteId : undefined;
    if (isPost && this.store.snapshot().actions.some((action) => action.kind === "post" && action.status !== "sent"))
      throw new AppError("new_post_quarantined", { effect: "none" });
    if (!isPost && this.postQuarantined(request.postId)) throw new AppError("target_quarantined", { effect: "none" });
    const body = await this.normalizePublication(request.body);
    if (!body.trim() || body.length > (isPost ? 20000 : 2000)) throw new AppError("invalid_publication_text", { effect: "none" });
    const title = isPost ? request.title : "";
    if (isPost && (!title || title.length > 120)) throw new AppError("invalid_post_title_or_body", { effect: "none" });
    let replyTarget: ReplyTarget | undefined;
    let postId: string | undefined;
    if (request.kind === "comment") {
      postId = identifier(request.postId);
      const observed = this.observed.get(postId);
      if (!observed) throw new AppError("read_post_first", { effect: "none" });
      // One top-level comment per post; 楼中楼 replies stay open.
      if (quoteId === undefined && this.hasTopLevelComment(observed)) throw new AppError("already_commented", { effect: "none" });
      if (quoteId !== undefined) {
        const target = observed.comments.find((c) => c.id === quoteId);
        if (!target || target.authorId === this.config.selfId) throw new AppError("unknown_reply_target", { effect: "none" });
        if (target.text.length > 2000) throw new AppError("ambiguous_reply_target", { effect: "none" });
        let matches = (await this.readPost(postId)).comments.filter((c) => c.id === quoteId);
        // A 楼中楼 outside the post page's floor preview is re-read from its own floor.
        if (!matches.length && target.id !== target.rootId) matches = await this.freshFloorMatches(postId, target);
        if (matches.length !== 1 || !matches.some((c) => c.text === target.text && c.authorId === target.authorId && c.rootId === target.rootId))
          throw new AppError("ambiguous_reply_target", { effect: "none" });
        replyTarget = { id: target.id, rootId: target.rootId, authorId: target.authorId, text: target.text };
      }
    }
    const key = contentHash(JSON.stringify(quoteId ? [channelId, quoteId] : [channelId, title, body]));
    await this.checkIdentity();
    this.assertWritable();
    await this.store.reserve(
      key,
      isPost ? "post" : "interaction",
      isPost ? this.config.dailyPostLimit : this.config.dailyInteractionLimit,
      this.clock.now(),
      channelId,
      isPost ? { kind: "post", titleHash: publicationHash(title), contentHash: publicationHash(body) } : commentVerification(postId!, body, replyTarget),
    );
    this.assertWritable();
    let receipt: Receipt;
    try {
      receipt = isPost ? await this.api.publish(title, body, this.config.communities) : await this.api.comment(postId!, body, replyTarget);
      if (
        receipt.notSent === true &&
        replyTarget &&
        receipt.accepted === false &&
        receipt.verified === false &&
        receipt.id === undefined &&
        Object.keys(receipt).every((field) => ["notSent", "accepted", "verified", "errorCode"].includes(field)) &&
        ["reply_target_unavailable", "reply_target_changed", "reply_preflight_failed"].includes(receipt.errorCode ?? "")
      ) {
        // Only an explicit, validated pre-write receipt can release this reservation.
      } else if (receipt.notSent || !receipt.accepted || !receipt.verified || !receipt.id)
        throw new AppError(receipt.errorCode ?? (!receipt.id ? "publication_receipt_missing" : "publication_verification_pending"), { effect: "unknown" });
      if (!receipt.notSent) identifier(receipt.id);
    } catch (error) {
      const errorCode = publicationError(error);
      const global = errorCode === "authentication_required" || errorCode === "captcha_required";
      try {
        await this.store.update((state) => {
          const action = state.actions.find((action) => action.key === key)!;
          action.status = "uncertain";
          try {
            if (receipt?.id) action.id = identifier(receipt.id);
          } catch {
            /* Invalid receipt IDs are never saved as evidence. */
          }
          if (
            receipt?.verification?.kind === "post" &&
            action.verification?.kind === "post" &&
            receipt.verification.contentHash === action.verification.contentHash &&
            receipt.verification.titleHash === action.verification.titleHash
          )
            action.verification = receipt.verification;
          if (global && !state.paused) state.paused = errorCode;
        });
      } catch (writeError) {
        this.halted = true;
        throw new AppError("uncertain_delivery", { effect: "unknown", cause: writeError });
      }
      await this.recordActivity({ kind: "send", outcome: "failed", postId, source: isPost ? "post" : quoteId ? "reply" : "comment", errorCode });
      if (global) this.onPaused?.(errorCode);
      throw new AppError("uncertain_delivery", { effect: "unknown" });
    }
    if (receipt.notSent === true) {
      try {
        await this.store.update((state) => {
          const index = state.actions.findIndex(
            (action) => action.key === key && action.status === "pending" && action.target === channelId && action.kind === "interaction",
          );
          if (index < 0) throw new AppError("reservation_changed", { effect: "none" });
          state.actions.splice(index, 1);
          state.activities.push({ id: key, at: this.clock.now(), kind: "send", outcome: "failed", postId, errorCode: receipt.errorCode });
        });
      } catch (writeError) {
        this.halted = true;
        throw new AppError("uncertain_delivery", { effect: "unknown", cause: writeError });
      }
      throw new AppError(receipt.errorCode ?? "reply_preflight_failed", { effect: "none" });
    }
    try {
      await this.store.update((state) => {
        const action = state.actions.find((action) => action.key === key)!;
        action.status = "sent";
        action.id = receipt.id;
        // A confirmed comment must survive a later failure too.
        if (postId && quoteId === undefined) state.commentedPostIds = [...new Set([...state.commentedPostIds, postId])].slice(-2000);
      });
    } catch (writeError) {
      this.halted = true;
      throw new AppError("uncertain_delivery", { effect: "unknown", cause: writeError });
    }
    return receipt.id!;
  }

  /** Fresh copy of a 楼中楼 target from its own floor (bounded), since post pages only preview floors. */
  private async freshFloorMatches(postId: string, target: ReplyTarget): Promise<PostDetail["comments"]> {
    const found: PostDetail["comments"] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const result = await this.remote(() => this.api.thread(postId, target.rootId, cursor));
      found.push(...result.detail.comments.filter((comment) => comment.id === target.id));
      if (found.length || !result.nextCursor || cursors.has(result.nextCursor)) break;
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return found;
  }

  budget() {
    const today = this.store.snapshot().actions.filter((action) => action.day === dayKey(this.clock.now()));
    return {
      postsRemaining: Math.max(0, this.config.dailyPostLimit - today.filter((a) => a.kind === "post").length),
      interactionsRemaining: Math.max(0, this.config.dailyInteractionLimit - today.filter((a) => a.kind === "interaction").length),
    };
  }

  /** Safe summary for the console and for the tools' own error text; never carries post bodies. */
  status() {
    const state = this.store.snapshot();
    return {
      accountId: state.accountId,
      paused: this.halted ? "state_write_failed" : state.paused,
      ...quarantineSummary(state),
      ...this.budget(),
      readOnly: this.readOnly,
    };
  }

  async pause(reason = "operator"): Promise<void> {
    await this.store.update((state) => {
      state.paused = reason;
    });
    const errorCode = [
      "operator",
      "authentication_required",
      "captcha_required",
      "account_identity_mismatch",
      "upstream_failed",
      "uncertain_delivery",
    ].includes(reason)
      ? reason
      : "account_paused";
    await this.recordActivity({ kind: "pause", outcome: "ok", errorCode });
    this.onPaused?.(reason);
  }

  async resume(acknowledgeUncertain = false): Promise<void> {
    try {
      if (this.closed || this.halted) throw new AppError("reconnect_required", { effect: "none" });
      const legacyUnproven = this.store.snapshot().paused === "uncertain_delivery" && !canIsolateUncertain(this.store.snapshot());
      if (legacyUnproven && !acknowledgeUncertain) throw new AppError("inspect_uncertain_delivery_first", { effect: "none" });
      await this.checkIdentity();
      await this.store.update((state) => {
        state.paused = null;
      });
      await this.recordActivity({ kind: "resume", outcome: "ok" });
    } catch (error) {
      await this.recordActivity({ kind: "resume", outcome: "failed", errorCode: "resume_failed" });
      throw error;
    }
  }

  private assertReadable(): void {
    if (this.closed) throw new AppError("account_closed", { effect: "none" });
    const paused = this.store.snapshot().paused;
    if (this.halted || (paused && !READ_SAFE_PAUSES.has(paused))) throw new AppError("account_paused", { effect: "none" });
  }

  private assertWritable(): void {
    if (this.closed) throw new AppError("account_closed", { effect: "none" });
    if (this.halted || this.store.snapshot().paused) throw new AppError("account_paused", { effect: "none" });
  }

  private postQuarantined(postId: string): boolean {
    return this.store
      .snapshot()
      .actions.some((action) => action.kind === "interaction" && action.status !== "sent" && action.target === `post:${this.config.selfId}:${postId}`);
  }

  private async remote<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!this.closed && ["authentication_required", "captcha_required"].includes(errorCodeOf(error))) await this.pause(errorCodeOf(error));
      throw new AppError("xiaoheihe_upstream_failed", { effect: "none", cause: error });
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.api.close();
    } finally {
      await this.sends.catch(() => {});
      await this.store.close();
    }
  }
}

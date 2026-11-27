import { AppError, retry, systemClock, type Clock } from "@yesimbot/foundation";

import { commentVerification, matchesComment, publicationError, publicationHash } from "./delivery.js";
import { HeyboxHttp, type HeyboxRequest } from "./heybox/http.js";
import { identifier, normalizePost, normalizePosts, record } from "./protocol.js";
import type { Community, PublicationVerification, Receipt, ReplyTarget, XiaoheiheApi } from "./types.js";

/** The implicit "动态" community the web client uses for image-text posts without a topic. */
const DYNAMIC_TOPIC = "58144";

/** Refusals that end the read-back looks at once. */
const REFUSALS: ReadonlySet<string> = new Set(["authentication_required", "captcha_required", "rate_limited"]);

type Http = Pick<HeyboxHttp, "request">;

/** Account identity from `/account/restore_login` or a QR login result. */
export function identity(data: Record<string, unknown>): string {
  const result = record(data.result ?? {});
  const profile = result.profile === undefined || result.profile === null ? {} : record(result.profile);
  const detail = result.account_detail === undefined || result.account_detail === null ? {} : record(result.account_detail);
  for (const value of [profile.heybox_id, detail.userid, result.heybox_id]) {
    if (value === undefined || value === null || value === 0 || value === "0") continue;
    if (typeof value !== "string" && typeof value !== "number") throw new AppError("invalid_identity", { effect: "none" });
    if (String(value).trim()) return identifier(String(value).trim());
  }
  throw new AppError("authentication_required", { effect: "none" });
}

/**
 * Direct client of the xiaoheihe web API. Read shapes follow what the former xiaoheihe-cli MCP
 * passed through, so the existing normalizers keep their validation. Writes are never retried;
 * any failure after a write request was sent is surfaced as an error (uncertain delivery).
 */
export function createXiaoheiheApi(http: Http, selfId: string, clock: Clock = systemClock()): XiaoheiheApi {
  const get = (path: string, params: HeyboxRequest["params"] = {}) => http.request(path, { params });

  async function post(id: string) {
    return get("/bbs/app/link/tree", { link_id: identifier(id), page: 1, is_first: 1, index: 1, owner_only: 0, offset: 0, limit: 20, sort_filter: "hot" });
  }

  /** One floor (root comment) with one page of its 楼中楼, in the post-tree shape. */
  async function replyContext(postId: string, rootId: string, cursor: string | undefined, limit: number) {
    const tree = await get("/bbs/app/link/tree", { link_id: postId, h_src: "" });
    const floor = await get("/bbs/app/link/tree", { link_id: postId, root_comment_id: rootId, h_src: "" });
    const page = await get("/bbs/app/comment/sub/comments", { link_id: postId, root_comment_id: rootId, limit, ...(cursor ? { lastval: cursor } : {}) });
    const link = record(record(tree.result).link);
    if (String(link.linkid ?? link.link_id) !== postId || ["linkid", "link_id"].some((field) => link[field] != null && String(link[field]) !== postId))
      throw new AppError("post_identity_mismatch", { effect: "none" });
    const floorResult = record(floor.result);
    const scopedLink = floorResult.link ?? link;
    const scoped = normalizePost({ result: { ...floorResult, link: scopedLink } }, postId, clock);
    const root = scoped.comments.find((comment) => comment.id === rootId && comment.rootId === rootId);
    if (!root) throw new AppError("reply_root_unavailable", { effect: "none" });
    const result = record(page.result);
    if (!Array.isArray(result.comments)) throw new AppError("invalid_reply_context", { effect: "none" });
    for (const value of result.comments) {
      const item = record(value);
      if (
        ["link_id", "linkid"].some((field) => item[field] !== undefined && String(item[field]) !== postId) ||
        ["root_id", "root_comment_id"].some((field) => item[field] !== undefined && String(item[field]) !== rootId)
      )
        throw new AppError("reply_root_mismatch", { effect: "none" });
    }
    // Keep the known floor's preview as well as its subcomment page. normalizePost owns
    // duplicate/conflict checks across all three sources, including current_comment.
    const rawRoot = {
      commentid: root.id,
      userid: root.authorId,
      text: root.text,
      ...(root.replyToId === undefined ? {} : { reply_id: root.replyToId }),
      ...(root.replyToAuthorId === undefined ? {} : { replyuser: { userid: root.replyToAuthorId } }),
    };
    const detail = normalizePost(
      {
        result: {
          ...floorResult,
          link: scopedLink,
          comments: [...(Array.isArray(floorResult.comments) ? floorResult.comments : []), { comment: [rawRoot, ...result.comments.slice(0, limit)] }],
          has_more_floors: 1,
        },
      },
      postId,
      clock,
    );
    detail.comments = detail.comments.filter((comment) => comment.rootId === rootId);
    let nextCursor: string | undefined;
    if ([true, 1, "1", "true"].includes(result.has_more as never)) {
      const last = result.comments.at(-1) as { commentid?: unknown } | undefined;
      nextCursor = identifier(result.lastval || last?.commentid || "");
      if (nextCursor === cursor) throw new AppError("reply_cursor_not_advanced", { effect: "none" });
    }
    return { detail, nextCursor };
  }

  async function resolveCommunities(names: readonly string[]): Promise<string> {
    const ids: string[] = [];
    for (const name of names) {
      const matches = (await communitySearch(name)).filter((community) => community.name === name);
      if (matches.length !== 1) throw new AppError("community_not_found", { effect: "none" });
      ids.push(matches[0]!.id);
    }
    return ids.join(",");
  }

  async function communitySearch(keyword: string): Promise<Community[]> {
    const response = await get("/bbs/app/api/post_editor/topic_selection/search", { q: keyword, only_hashtag: "0" });
    const items = record(response.result ?? {}).search_result;
    if (!Array.isArray(items)) throw new AppError("invalid_community_search", { effect: "none" });
    return items.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const name = typeof item.name === "string" ? item.name : typeof item.title === "string" ? item.title : "";
      if (item.search_type !== "topic" || !name || (typeof item.topic_id !== "string" && typeof item.topic_id !== "number")) return [];
      const description = [item.desc, item.description, item.intro].find((text): text is string => typeof text === "string" && !!text.trim());
      return [{ id: identifier(item.topic_id), name: name.slice(0, 100), ...(description ? { description: description.slice(0, 200) } : {}) }];
    });
  }

  async function verifyPublication(id: string, evidence: PublicationVerification): Promise<boolean> {
    identifier(id);
    if (evidence.kind === "comment") {
      const postId = identifier(evidence.postId);
      const detail = evidence.replyTarget
        ? (await replyContext(postId, identifier(evidence.replyTarget.rootId), undefined, 50)).detail
        : normalizePost(await get("/bbs/app/link/tree", { link_id: postId, root_comment_id: id, h_src: "" }), postId, clock);
      return matchesComment(detail, selfId, id, evidence);
    }
    // Legacy post attempts without a resolved community binding remain isolated.
    if (!evidence.topicIds?.length) return false;
    const link = record(record((await post(id)).result).link);
    const body: unknown = JSON.parse(String(link.text ?? ""));
    const topics = Array.isArray(link.topics) ? link.topics.map((topic) => String((topic as { topic_id?: unknown })?.topic_id)) : [];
    const sameTopics =
      evidence.topicIds.every((topic) => topics.includes(topic)) ||
      (evidence.topicIds.length === 1 && evidence.topicIds[0] === DYNAMIC_TOPIC && ["28", "21"].includes(String(link.link_tag)));
    return (
      sameTopics &&
      findLinkId(link) === id &&
      String(link.userid ?? record(link.user ?? {}).userid) === selfId &&
      publicationHash(String(link.title ?? "")) === evidence.titleHash &&
      Array.isArray(body) &&
      body.length === 1 &&
      body[0]?.type === "text" &&
      typeof body[0].text === "string" &&
      publicationHash(body[0].text) === evidence.contentHash
    );
  }

  async function createComment(postId: string, content: string, target?: ReplyTarget): Promise<Receipt> {
    const form = { link_id: postId, text: content, root_id: target ? target.rootId : "-1", reply_id: target ? target.id : "-1", is_cy: "0" };
    // From here on any failure is ambiguous: the request may have been accepted.
    const receipt = await http.request("/bbs/app/comment/create", { form });
    const id = findCommentId(receipt);
    if (!id) return { accepted: true, verified: false };
    const evidence = commentVerification(postId, content, target);
    const outcome = await confirm(id, evidence);
    return { accepted: true, verified: outcome.verified, id, ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}) };
  }

  /**
   * Up to four read-only looks for a publication, the first at once and the others after 2, 4 and 8 seconds. The write
   * itself is never repeated. A login, captcha or rate-limit refusal ends the looks with its own code.
   */
  async function confirm(id: string, evidence: PublicationVerification): Promise<{ verified: boolean; errorCode?: NonNullable<Receipt["errorCode"]> }> {
    try {
      await retry(
        async () => {
          if (!(await verifyPublication(id, evidence))) throw new AppError("publication_verification_pending", { effect: "none" });
        },
        {
          attempts: 4,
          effect: "idempotent",
          backoff: { baseMs: 2000, factor: 2, maxMs: 8000, jitter: false },
          classify: (error) => (isRefusal(publicationError(error)) ? "fatal" : "transient"),
        },
      );
      return { verified: true };
    } catch (error) {
      const code = publicationError(error);
      return { verified: false, errorCode: isRefusal(code) ? code : "publication_verification_pending" };
    }
  }

  return {
    verifyPublication,
    emojis: () => get("/bbs/app/api/emojis/list"),
    async login() {
      const data = await get("/account/restore_login");
      const userId = identity(data);
      const result = record(data.result ?? {});
      const profile = (result.profile ?? result.account_detail ?? {}) as Record<string, unknown>;
      const username = typeof profile.username === "string" ? profile.username : typeof profile.nickname === "string" ? profile.nickname : undefined;
      return { userId, ...(username ? { username: username.slice(0, 100) } : {}) };
    },
    async feed(limit) {
      return normalizePosts(await get("/bbs/app/feeds", { offset: 0, limit, pull: "0", dw: 604 }), clock).slice(0, limit);
    },
    async community(id, limit) {
      const topicId = identifier(id);
      const response = await get("/bbs/app/topic/feeds", { topic_id: topicId, lastval: "", dw: 720, offset: 0, limit });
      const links = record(response.result).links;
      if (!Array.isArray(links)) throw new AppError("invalid_community_feed", { effect: "none" });
      // The topic feed can mix in other topics; keep only posts that belong to the community.
      const own = links.filter((item) => {
        const link = item && typeof item === "object" ? ((item as { link?: unknown }).link ?? item) : undefined;
        const topics = link && typeof link === "object" ? (link as { topics?: unknown }).topics : undefined;
        return (
          Array.isArray(topics) && topics.some((topic) => topic && typeof topic === "object" && String((topic as { topic_id?: unknown }).topic_id) === topicId)
        );
      });
      return normalizePosts({ result: { links: own } }, clock).slice(0, limit);
    },
    async findCommunities(keyword, limit) {
      if (!keyword.trim() || keyword.length > 100) throw new AppError("invalid_keyword", { effect: "none" });
      return (await communitySearch(keyword)).slice(0, limit);
    },
    async search(keyword, limit) {
      return normalizePosts(await get("/bbs/app/api/general/search/v1", { q: keyword, search_type: "link", offset: 0, limit }), clock).slice(0, limit);
    },
    async post(id) {
      return normalizePost(await post(id), id, clock);
    },
    async thread(postId, rootId, cursor) {
      const { detail, nextCursor } = await replyContext(identifier(postId), identifier(rootId), cursor === undefined ? undefined : identifier(cursor), 50);
      if (!detail.comments.length || detail.comments.some((comment) => comment.rootId !== rootId))
        throw new AppError("reply_root_mismatch", { effect: "none" });
      return { detail, ...(nextCursor ? { nextCursor } : {}) };
    },
    async publish(title, content, communities) {
      const topicIds = (await resolveCommunities(communities)) || DYNAMIC_TOPIC;
      const blocks = [{ type: "text", text: content }];
      const form = {
        title,
        text: JSON.stringify(blocks),
        post_type: "1",
        link_tag: topicIds === DYNAMIC_TOPIC ? "28" : "27",
        draft: "0",
        view_limit: "1",
        original: "1",
        words_count: String(content.length),
        topic_ids: topicIds,
      };
      const receipt = await http.request("/bbs/app/api/link/post", { form });
      const id = findLinkId(receipt);
      if (!id) return { accepted: true, verified: false };
      const verification: PublicationVerification = {
        kind: "post",
        titleHash: publicationHash(title),
        contentHash: publicationHash(content),
        topicIds: topicIds.split(","),
      };
      const outcome = await confirm(id, verification);
      return { accepted: true, verified: outcome.verified, id, ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}), verification };
    },
    async comment(postId, content, target) {
      const id = identifier(postId);
      if (!content.trim() || content.length > 2000) throw new AppError("invalid_publication_text", { effect: "none" });
      if (!target) return createComment(id, content);
      // Pre-write check of the exact target inside its own floor (at most five pages); a failure
      // here is a proven "not sent" and releases the reservation upstream.
      let found: ReplyTarget | undefined;
      try {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (let page = 0; page < 5 && !found; page++) {
          const context = await replyContext(id, identifier(target.rootId), cursor, 50);
          found = context.detail.comments.find((item) => item.id === target.id);
          if (found || !context.nextCursor || cursors.has(context.nextCursor)) break;
          cursors.add(context.nextCursor);
          cursor = context.nextCursor;
        }
      } catch (error) {
        const code = publicationError(error);
        // Keep authentication/captcha visible to the account-wide blocker even before writing.
        if (code === "authentication_required" || code === "captcha_required") throw error;
        return { accepted: false, verified: false, notSent: true, errorCode: "reply_preflight_failed" };
      }
      if (!found) return { accepted: false, verified: false, notSent: true, errorCode: "reply_target_unavailable" };
      if (
        found.text.length > 2000 ||
        found.authorId !== target.authorId ||
        found.authorId === selfId ||
        found.text !== target.text ||
        found.rootId !== target.rootId
      )
        return { accepted: false, verified: false, notSent: true, errorCode: "reply_target_changed" };
      return createComment(id, content, target);
    },
    async close() {},
  };
}

function isRefusal(code: string): code is "authentication_required" | "captcha_required" | "rate_limited" {
  return REFUSALS.has(code);
}

function findLinkId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  for (const key of ["link_id", "linkid"]) if (item[key]) return identifier(item[key]);
  for (const key of ["link", "comment", "data", "result"]) {
    const found = findLinkId(item[key]);
    if (found) return found;
  }
  return undefined;
}

/** Accept only bounded known receipt containers; conflicting aliases are not a receipt. */
function findCommentId(value: unknown): string | undefined {
  const ids = new Set<string>();
  function collect(item: unknown, depth: number): void {
    if (!item || typeof item !== "object" || Array.isArray(item) || depth > 4) return;
    const data = item as Record<string, unknown>;
    for (const key of ["commentid", "comment_id"]) if (data[key] !== undefined && data[key] !== null) ids.add(identifier(data[key]));
    for (const key of ["result", "comment", "data"]) collect(data[key], depth + 1);
  }
  collect(value, 0);
  return ids.size === 1 ? [...ids][0] : undefined;
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppError, formatForModel, manualClock } from "@yesimbot/foundation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Account } from "../src/account.js";
import type { Config } from "../src/config.js";
import { commentVerification } from "../src/delivery.js";
import { AccountStore } from "../src/store.js";
import type { PostDetail, XiaoheiheApi } from "../src/types.js";

const NOW = Date.parse("2026-10-26T10:00:00Z");
const clock = manualClock(NOW);
/** A stored ISO publication time as the model reads it. */
const shown = (iso: string) => formatForModel(Date.parse(iso), clock);
const config: Config = { selfId: "bot", nativeEmojis: true, dailyPostLimit: 1, dailyInteractionLimit: 10, communities: [] };
const resources: { account: Account; dir: string }[] = [];
const detail: PostDetail = {
  id: "p",
  authorId: "other",
  title: "A post",
  text: "body",
  comments: [{ id: "c", authorId: "other", text: "question", rootId: "c" }],
};
async function fixture(patch: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "xhh-account-"));
  const store = await AccountStore.open(dir, "bot");
  const api = {
    login: vi.fn(async () => ({ userId: "bot" })),
    emojis: vi.fn<NonNullable<XiaoheiheApi["emojis"]>>(async () => ({
      status: "ok",
      result: { emoji_groups: [{ group_code: "cube", emojis: [{ code: "抱拳", img: "https://imgheybox.max-c.com/heybox/emoji/cube_191.png" }] }] },
    })),
    feed: vi.fn(async () => [detail]),
    community: vi.fn<XiaoheiheApi["community"]>(async () => [{ ...detail, id: "q", title: "Community post" }]),
    findCommunities: vi.fn<XiaoheiheApi["findCommunities"]>(async () => [{ id: "7", name: "单机游戏" }]),
    search: vi.fn(async () => [detail]),
    post: vi.fn<XiaoheiheApi["post"]>(async () => structuredClone(detail)),
    thread: vi.fn<XiaoheiheApi["thread"]>(async () => ({ detail: structuredClone(detail) })),
    publish: vi.fn(async () => ({ accepted: true, verified: true, id: "new" })),
    comment: vi.fn<XiaoheiheApi["comment"]>(async () => ({ accepted: true, verified: true, id: "sent" })),
    close: vi.fn(async () => {}),
  } satisfies XiaoheiheApi;
  const account = new Account({ ...config, ...patch }, api, store, manualClock(NOW));
  resources.push({ account, dir });
  return { account, store, api, dir };
}
afterEach(async () => {
  for (const { account, dir } of resources.splice(0)) {
    await account.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
describe("on-demand account", () => {
  it("reads posts, floors and lists without filtering what an earlier call returned", async () => {
    const { account, api } = await fixture();
    const oldPost = {
      ...detail,
      publishedAt: "2020-01-02T03:04:05.000Z",
      comments: [
        { ...detail.comments[0], publishedAt: "2026-10-26T09:59:00.000Z" },
        { id: "unknown", rootId: "unknown", authorId: "u", text: "no timestamp" },
      ],
    };
    api.post.mockResolvedValue(oldPost);
    api.feed.mockResolvedValue([oldPost, { ...detail, authorId: "bot", id: "mine" }]);
    const view = await account.readPostView("p");
    expect(view).toMatchObject({ currentTime: shown("2026-10-26T10:00:00.000Z"), publishedAt: shown("2020-01-02T03:04:05.000Z") });
    expect(view.comments.map((comment: { publishedAt: string | null }) => comment.publishedAt)).toEqual([shown("2026-10-26T09:59:00.000Z"), null]);
    expect(account.view(detail)).toMatchObject({ publishedAt: null, currentTime: shown("2026-10-26T10:00:00.000Z"), comments: [{ publishedAt: null }] });
    // The same answers every time, including the account's own posts: it is a lookup, not a patrol.
    for (let call = 0; call < 2; call++) expect((await account.feed()).map((post) => post.id)).toEqual(["p", "mine"]);
    for (let call = 0; call < 2; call++) expect((await account.search("phone")).map((post) => post.id)).toEqual(["p"]);
    for (let call = 0; call < 2; call++) expect((await account.browseCommunity("7")).posts.map((post) => post.id)).toEqual(["q"]);
  });

  it("names communities found earlier and records no activity or state for plain reads", async () => {
    const { account, store } = await fixture();
    const before = store.snapshot();
    expect(await account.findCommunities("单机")).toEqual([{ id: "7", name: "单机游戏" }]);
    expect((await account.browseCommunity("7")).community).toEqual({ id: "7", name: "单机游戏" });
    await account.readPost("p");
    await account.feed();
    expect(store.snapshot()).toEqual(before);
  });

  it("stores a post's images through the caller and says so when none loaded", async () => {
    const { account, api } = await fixture();
    api.post.mockResolvedValue({ ...detail, imageUrls: ["https://imgheybox.max-c.com/a.png", "https://imgheybox.max-c.com/b.png"] });
    const loaded = await account.readPostView("p", async (urls) => urls.map((_, index) => `asset://i${index}`));
    expect(loaded).toMatchObject({ imageCount: 2, images: ["asset://i0", "asset://i1"] });
    expect(loaded).not.toHaveProperty("imageUrls");
    expect(loaded.imageNote).toContain("先用 read 看过");
    expect((await account.readPostView("p")).imageNote).toContain("不要描述或评价图片内容");
    expect((await account.readPostView("p", async () => Promise.reject(new Error("fail")))).imageNote).toContain("不要描述");
  });

  it("does not stop reading after failed reads, but a lost login blocks everything until a new one", async () => {
    const { account, api, store } = await fixture();
    api.search.mockRejectedValueOnce(new Error("temporary search error"));
    await expect(account.search("topic")).rejects.toThrow("xiaoheihe_upstream_failed");
    await expect(account.search("topic")).resolves.toHaveLength(1);
    expect(store.snapshot().paused).toBeNull();
    api.feed.mockRejectedValueOnce(new AppError("authentication_required"));
    await expect(account.feed()).rejects.toThrow("xiaoheihe_upstream_failed");
    expect(account.loginRequired).toBe(true);
    await expect(account.readPost("p")).rejects.toThrow("account_paused");
    await expect(account.publishPost("Title", "Body")).rejects.toThrow("account_paused");
  });

  it("only an uncertain-delivery pause leaves reading open", async () => {
    const { account, api, store } = await fixture();
    await store.update((state) => {
      state.paused = "uncertain_delivery";
    });
    await expect(account.readPost("p")).resolves.toMatchObject({ id: "p" });
    await expect(account.publishPost("Title", "Body")).rejects.toThrow("account_paused");
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("settles an uncertain reply at startup only when its own reply is visible, without sending", async () => {
    const { account, api, store } = await fixture();
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256")
      .update(JSON.stringify(["post:bot:p", "c"]))
      .digest("hex");
    await store.update((state) => {
      state.actions.push({
        key,
        kind: "interaction",
        day: "2026-10-26",
        at: 1,
        status: "uncertain",
        target: "post:bot:p",
        id: "mine",
        verification: commentVerification("p", "回", detail.comments[0]),
      });
    });
    await account.reconcileUncertain();
    expect(store.snapshot().actions.find((action) => action.key === key)).toMatchObject({ status: "uncertain" });
    api.thread.mockResolvedValue({
      detail: { ...structuredClone(detail), comments: [...detail.comments, { id: "mine", authorId: "bot", text: "回", rootId: "c", replyToId: "c" }] },
    });
    await account.reconcileUncertain();
    expect(store.snapshot().actions.find((action) => action.key === key)).toMatchObject({ status: "sent", id: "mine" });
    expect(api.comment).not.toHaveBeenCalled();
  });

  it("preserves discovery timestamps from home, community and search without treating them as newness filters", async () => {
    const { account, api } = await fixture();
    const publishedAt = "2020-01-02T03:04:05.000Z";
    api.feed.mockResolvedValue([{ ...detail, publishedAt }]);
    expect((await account.feed())[0]!.publishedAt).toBe(publishedAt);
    api.community.mockResolvedValue([{ ...detail, id: "community", publishedAt }]);
    expect((await account.browseCommunity("7")).posts[0]!.publishedAt).toBe(publishedAt);
    api.search.mockResolvedValue([{ ...detail, id: "search", publishedAt }]);
    const found = await account.search("phone");
    expect(account.viewPosts(found)).toEqual([expect.objectContaining({ id: "search", publishedAt: shown(publishedAt) })]);
    expect(account.viewPosts([detail])[0]!.publishedAt).toBeNull();
  });

  it("exposes the original post time and individual publication times in expanded replies", async () => {
    const { account, api } = await fixture();
    const post = { ...detail, publishedAt: "2020-01-02T03:04:05.000Z" };
    const reply = { id: "deep", rootId: "c", authorId: "u", text: "recent", publishedAt: "2026-10-26T09:59:00.000Z" };
    api.post.mockResolvedValue(post);
    api.thread.mockResolvedValue({ detail: { ...post, comments: [detail.comments[0], reply] } });
    await account.readPost("p");
    const result = await account.readReplies("p", "c");
    expect(result).toMatchObject({ currentTime: shown("2026-10-26T10:00:00.000Z"), postPublishedAt: shown("2020-01-02T03:04:05.000Z") });
    expect(result.replies.map((comment) => comment.publishedAt)).toEqual([null, shown("2026-10-26T09:59:00.000Z")]);
  });

  it("validates native codes before reservation and sends one immutable normalized body", async () => {
    const { account, api, store } = await fixture();
    await account.readPost("p");
    const reserve = vi.spyOn(store, "reserve");
    await expect(account.publishComment("p", "bad[cube_unknown]")).rejects.toThrow("unknown_native_emoji");
    expect(reserve).not.toHaveBeenCalled();
    expect(api.comment).not.toHaveBeenCalled();
    expect(store.snapshot().paused).toBeNull();
    await account.publishComment("p", "好[cube_191][普通文字]", "c");
    expect(api.comment).toHaveBeenCalledExactlyOnceWith("p", "好[cube_抱拳][普通文字]", expect.objectContaining({ text: "question" }));
    expect(api.emojis).toHaveBeenCalledTimes(1);
  });

  it("degrades catalog errors to plain text without pausing, and can disable native emojis", async () => {
    const { account, api, store } = await fixture();
    api.emojis.mockRejectedValue(new AppError("authentication_required"));
    expect(await account.nativeEmojiPrompt()).toBe("");
    await account.readPost("p");
    await account.publishComment("p", "文字[cube_抱拳][literal]");
    expect(api.comment).toHaveBeenCalledWith("p", "文字[literal]", undefined);
    expect(store.snapshot().paused).toBeNull();
    const disabled = await fixture({ nativeEmojis: false });
    expect(await disabled.account.nativeEmojiPrompt()).toBe("");
    await disabled.account.readPost("p");
    await disabled.account.publishComment("p", "文字[cube_抱拳]");
    expect(disabled.api.emojis).not.toHaveBeenCalled();
    expect(disabled.api.comment).toHaveBeenCalledWith("p", "文字", undefined);
  });

  it("rechecks pause after quota persistence and before calling the upstream writer", async () => {
    const { account, store, api } = await fixture();
    const reserve = store.reserve.bind(store);
    vi.spyOn(store, "reserve").mockImplementationOnce(async (...args) => {
      await reserve(...args);
      await account.pause();
    });
    await expect(account.publishPost("Title", "Body")).rejects.toThrow("account_paused");
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("sends only verified publications and enforces separate quotas", async () => {
    const { account, api } = await fixture({ dailyInteractionLimit: 1 });
    expect(await account.publishPost("Title", "Body")).toEqual({ id: "new" });
    await expect(account.publishPost("Other", "Post")).rejects.toThrow("daily_limit");
    await account.readPost("p");
    expect(await account.publishComment("p", "comment")).toEqual({ id: "sent" });
    // A 楼中楼 reply is still an interaction and hits the daily quota.
    await expect(account.publishComment("p", "second", "c")).rejects.toThrow("daily_limit");
    expect(api.publish).toHaveBeenCalledTimes(1);
    expect(api.comment).toHaveBeenCalledTimes(1);
  });

  it("validates the exact observed reply target and prevents duplicate replies", async () => {
    const { account, api } = await fixture();
    await account.readPost("p");
    await expect(account.publishComment("p", "reply", "missing")).rejects.toThrow("unknown_reply_target");
    await account.publishComment("p", "answer", "c");
    expect(api.comment).toHaveBeenCalledWith("p", "answer", { id: "c", rootId: "c", authorId: "other", text: "question" });
    await expect(account.publishComment("p", "different answer", "c")).rejects.toThrow("duplicate_action");
    expect(api.comment).toHaveBeenCalledTimes(1);
  });

  it("binds replies by ID even when another comment has identical text", async () => {
    const { account, api } = await fixture();
    api.post.mockResolvedValue({ ...detail, comments: [...detail.comments, { ...detail.comments[0], id: "duplicate" }] });
    await account.readPost("p");
    await expect(account.publishComment("p", "answer", "c")).resolves.toEqual({ id: "sent" });
    expect(api.comment).toHaveBeenCalledWith("p", "answer", detail.comments[0]);
  });

  it("expands a floor's 楼中楼, keeps them across re-reads, and replies to a deep one after re-checking its floor", async () => {
    const { account, api } = await fixture();
    const deep = { id: "d", authorId: "carol", text: "楼中楼", rootId: "c", replyToId: "c" };
    api.post.mockResolvedValue({ ...detail, comments: [{ ...detail.comments[0], moreReplies: true }] });
    api.thread.mockResolvedValueOnce({ detail: { ...detail, comments: [detail.comments[0], deep] }, nextCursor: "n1" });
    await account.readPost("p");
    await expect(account.readReplies("p", "c")).resolves.toEqual({
      postId: "p",
      rootId: "c",
      currentTime: shown("2026-10-26T10:00:00.000Z"),
      postPublishedAt: null,
      replies: [detail.comments[0], deep].map((comment) => ({ ...comment, publishedAt: null })),
      nextCursor: "n1",
    });
    expect(api.thread).toHaveBeenLastCalledWith("p", "c", undefined);
    // The post page only previews the floor; the deep reply must stay targetable after a re-read.
    await account.readPost("p");
    api.thread.mockResolvedValueOnce({ detail: { ...detail, comments: [detail.comments[0]] }, nextCursor: "n2" });
    api.thread.mockResolvedValueOnce({ detail: { ...detail, comments: [deep] } });
    await expect(account.publishComment("p", "接一句", "d")).resolves.toEqual({ id: "sent" });
    expect(api.comment).toHaveBeenCalledWith("p", "接一句", { id: "d", rootId: "c", authorId: "carol", text: "楼中楼" });
    expect(api.thread).toHaveBeenLastCalledWith("p", "c", "n2");
  });

  it("refuses a deep reply whose fresh floor copy changed, and replies need a read post", async () => {
    const { account, api, store } = await fixture();
    const deep = { id: "d", authorId: "carol", text: "楼中楼", rootId: "c" };
    await expect(account.readReplies("p", "c")).rejects.toThrow("read_post_first");
    await account.readPost("p");
    await expect(account.readReplies("p", "nope")).rejects.toThrow("unknown_comment");
    api.thread.mockResolvedValueOnce({ detail: { ...detail, comments: [detail.comments[0], deep] } });
    await account.readReplies("p", "c");
    api.thread.mockResolvedValue({ detail: { ...detail, comments: [detail.comments[0], { ...deep, text: "已编辑" }] } });
    await expect(account.publishComment("p", "接一句", "d")).rejects.toThrow("ambiguous_reply_target");
    expect(api.comment).not.toHaveBeenCalled();
    expect(store.snapshot().actions).toEqual([]);
  });

  it.each(["authorId", "rootId", "text"] as const)("rejects changed target %s before reserving or writing", async (field) => {
    const { account, api, store } = await fixture();
    await account.readPost("p");
    api.post.mockResolvedValue({ ...detail, comments: [{ ...detail.comments[0], [field]: "changed" }] });
    await expect(account.publishComment("p", "answer", "c")).rejects.toThrow("ambiguous_reply_target");
    expect(api.comment).not.toHaveBeenCalled();
    expect(store.snapshot().actions).toEqual([]);
  });

  it("halts if releasing the pre-write reservation cannot be persisted", async () => {
    const { account, api, store } = await fixture();
    await account.readPost("p");
    api.comment.mockImplementationOnce(async () => {
      vi.spyOn(store, "update").mockRejectedValueOnce(new Error("disk failed"));
      return { accepted: false, verified: false, notSent: true, errorCode: "reply_preflight_failed" };
    });
    await expect(account.publishComment("p", "answer", "c")).rejects.toThrow("uncertain_delivery");
    expect(store.snapshot().actions).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(account.status().paused).toBe("state_write_failed");
    await expect(account.publishComment("p", "answer", "c")).rejects.toThrow();
    expect(api.comment).toHaveBeenCalledOnce();
  });

  it.each([
    { accepted: true, verified: false, notSent: true, errorCode: "reply_preflight_failed" },
    { accepted: false, verified: false, notSent: true, errorCode: "reply_preflight_failed", id: "sent" },
    { accepted: false, verified: false, notSent: true, errorCode: "unknown" },
    { accepted: false, verified: false, notSent: true, errorCode: "reply_preflight_failed", message: "untrusted" },
  ])("retains uncertainty for contradictory internal receipts %#", async (receipt) => {
    const { account, api, store } = await fixture();
    await account.readPost("p");
    api.comment.mockResolvedValueOnce(receipt as never);
    await expect(account.publishComment("p", "answer", "c")).rejects.toThrow("uncertain_delivery");
    expect(store.snapshot().actions[0].status).toBe("uncertain");
    expect(store.snapshot().paused).toBeNull();
  });

  it("keeps timed out replies isolated with quota and deduplication intact", async () => {
    const { account, api, store } = await fixture();
    await account.readPost("p");
    api.comment.mockRejectedValueOnce(new Error("timeout"));
    await expect(account.publishComment("p", "answer", "c")).rejects.toThrow("uncertain_delivery");
    expect(store.snapshot().paused).toBeNull();
    expect(store.snapshot().actions).toEqual([expect.objectContaining({ status: "uncertain" })]);
  });

  it("quarantines uncertain new posts without stopping other activity or inventing message IDs", async () => {
    const { account, store, api } = await fixture();
    api.publish.mockResolvedValue({ accepted: true, verified: false, id: "new" });
    await expect(account.publishPost("Title", "Body")).rejects.toThrow("uncertain_delivery");
    expect(store.snapshot().paused).toBeNull();
    expect(store.snapshot().actions[0].status).toBe("uncertain");
    await account.resume();
    expect(store.snapshot().actions).toHaveLength(1);
    await expect(account.publishPost("Other", "Text")).rejects.toThrow("new_post_quarantined");
    expect(api.publish).toHaveBeenCalledTimes(1);
  });

  it("allows one top-level comment per post while 楼中楼 replies stay open", async () => {
    const { account, api, store } = await fixture();
    await account.readPost("p");
    await account.publishComment("p", "第一条评论");
    expect(store.snapshot().commentedPostIds).toEqual(["p"]);
    await account.readPost("p");
    await expect(account.publishComment("p", "又一条顶层评论")).rejects.toThrow("already_commented");
    expect(api.comment).toHaveBeenCalledTimes(1);
    await account.publishComment("p", "接一句", "c");
    expect(api.comment).toHaveBeenCalledTimes(2);
  });

  it("treats an own top-level comment already on the post as commented, even without a local record", async () => {
    const { account, api, store } = await fixture();
    api.post.mockResolvedValue({ ...structuredClone(detail), comments: [...detail.comments, { id: "mine", authorId: "bot", text: "旧评论", rootId: "mine" }] });
    await account.readPost("p");
    await expect(account.publishComment("p", "再来一条")).rejects.toThrow("already_commented");
    expect(api.comment).not.toHaveBeenCalled();
    expect(store.snapshot().actions).toEqual([]);
  });

  it("rejects account changes, unread targets, and paused writes", async () => {
    const { account, api } = await fixture();
    await expect(account.publishComment("other:p", "text")).rejects.toThrow();
    await expect(account.publishComment("p", "text")).rejects.toThrow("read_post_first");
    api.login.mockResolvedValue({ userId: "someone-else" });
    await expect(account.publishPost("Title", "Body")).rejects.toThrow("account_identity_mismatch");
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("zero post quota forbids new posts while permitting an observed comment", async () => {
    const { account, api } = await fixture({ dailyPostLimit: 0, dailyInteractionLimit: 20 });
    await expect(account.publishPost("Title", "Body")).rejects.toThrow("daily_limit");
    await account.readPost("p");
    await account.publishComment("p", "comment");
    expect(api.publish).not.toHaveBeenCalled();
    expect(api.comment).toHaveBeenCalledOnce();
  });

  it("zero quotas still permit reading but never publish", async () => {
    const { account, api } = await fixture({ dailyPostLimit: 0, dailyInteractionLimit: 0 });
    await expect(account.feed()).resolves.toHaveLength(1);
    await expect(account.publishPost("Title", "Body")).rejects.toThrow("read_only");
    await account.readPost("p");
    await expect(account.publishComment("p", "text")).rejects.toThrow("read_only");
    expect(account.store.snapshot().actions).toEqual([]);
    expect(api.publish).not.toHaveBeenCalled();
    expect(api.comment).not.toHaveBeenCalled();
  });

  it("requires login for authentication loss and refuses a changed login identity", async () => {
    const expired = await fixture();
    expired.api.login.mockRejectedValueOnce(new AppError("authentication_required"));
    await expect(expired.account.publishPost("Title", "Body")).rejects.toThrow("xiaoheihe_upstream_failed");
    expect(expired.store.snapshot().paused).toBe("authentication_required");
    expect(expired.api.publish).not.toHaveBeenCalled();
    const changed = await fixture();
    changed.api.login.mockResolvedValueOnce({ userId: "someone-else" });
    await expect(changed.account.checkIdentity()).rejects.toThrow("account_identity_mismatch");
    expect(changed.store.snapshot().paused).toBe("account_identity_mismatch");
  });

  it("serializes publications and never sends the same post twice", async () => {
    const { account, api } = await fixture({ dailyPostLimit: 5 });
    const results = await Promise.allSettled([account.publishPost("Same", "Text"), account.publishPost("Same", "Text")]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(api.publish).toHaveBeenCalledOnce();
  });
});

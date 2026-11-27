import { describe, expect, it } from "vitest";

import { identifier, normalizePost, normalizePosts } from "../src/protocol.js";

describe("upstream response boundary", () => {
  it("preserves create_at publication times across wrapped lists, the post and individual floors", () => {
    const postTime = Date.parse("2020-01-02T03:04:05Z") / 1000;
    const commentTime = Date.parse("2026-01-02T03:04:05Z") / 1000;
    const link = { linkid: "p", userid: "author", create_at: String(postTime), time: "刚刚", modify_at: commentTime };
    for (const item of [link, { link }, { info: link }]) {
      expect(normalizePosts({ result: { links: [item] } })[0]!.publishedAt).toBe("2020-01-02T03:04:05.000Z");
    }
    const detail = normalizePost(
      {
        result: {
          link,
          comments: [
            {
              comment: [
                { commentid: "root", userid: "u", create_at: postTime },
                { commentid: "reply", userid: "v", create_at: commentTime },
              ],
            },
          ],
        },
      },
      "p",
    );
    expect(detail.publishedAt).toBe("2020-01-02T03:04:05.000Z");
    expect(detail.comments.map((comment) => comment.publishedAt)).toEqual(["2020-01-02T03:04:05.000Z", "2026-01-02T03:04:05.000Z"]);
  });

  it.each([undefined, null, "", "刚刚", "2020-01-02", "1e9", 0, -1, 1.5, NaN, Infinity, 1577934245000, Number.MAX_SAFE_INTEGER + 1, 9999999999])(
    "keeps invalid or absent publication time unknown without losing the post/comment (%s)",
    (create_at) => {
      const link = { linkid: "p", userid: "author", create_at, timestamp: 1577934245, modify_at: 1577934245, time: "刚刚" };
      const post = normalizePost({ result: { link, comments: [{ comment: [{ ...link, commentid: "c" }] }] } }, "p");
      expect(post.publishedAt).toBeUndefined();
      expect(post.comments[0]).toMatchObject({ id: "c", authorId: "author" });
      expect(post.comments[0]!.publishedAt).toBeUndefined();
      expect(normalizePosts({ posts: [link] })[0]!.publishedAt).toBeUndefined();
    },
  );

  it("retains publication time when an identical scoped comment omits it", () => {
    const comment = { commentid: "c", userid: "u", text: "same" };
    const post = normalizePost(
      {
        result: {
          link: { linkid: "p", userid: "u" },
          current_comment: { comment: [comment] },
          comments: [{ comment: [{ ...comment, create_at: 1577934245 }] }],
        },
      },
      "p",
    );
    expect(post.comments).toHaveLength(1);
    expect(post.comments[0]!.publishedAt).toBe("2020-01-02T03:04:05.000Z");
  });

  it("treats conflicting duplicate publication times as unknown while retaining the comment", () => {
    const comment = { commentid: "c", userid: "u", text: "same", create_at: 1577934245 };
    const post = normalizePost(
      {
        result: {
          link: { linkid: "p", userid: "u" },
          current_comment: { comment: [comment] },
          comments: [{ comment: [{ ...comment, create_at: 1767323045 }, comment] }],
        },
      },
      "p",
    );
    expect(post.comments).toEqual([{ id: "c", authorId: "u", text: "same", rootId: "c" }]);
  });

  it("merges the exact scoped floor before unrelated pages and deduplicates identical comments", () => {
    const own = { commentid: "988104402", userid: "bot", text: "hello", user: { userid: "bot" } };
    const group = { comment: [own] };
    const link = { linkid: "p", userid: "author", title: "t", text: "body" };
    const post = normalizePost(
      { result: { link, comments: [{ comment: [{ commentid: "older", userid: "other", text: "older" }] }, group], current_comment: group, total_page: 55 } },
      "p",
    );
    expect(post.comments).toEqual([
      { id: "988104402", authorId: "bot", text: "hello", rootId: "988104402" },
      { id: "older", authorId: "other", text: "older", rootId: "older" },
    ]);
    expect(post.commentsComplete).toBe(false);
    expect(normalizePost({ result: { link, current_comment: group } }, "p").comments).toEqual([post.comments[0]]);
    expect(normalizePost({ result: { link, comments: [], current_comment: null } }, "p").comments).toEqual([]);
  });

  it.each(["author", "text", "root", "reply", "reply-author"])("rejects conflicting %s across current_comment and ordinary comments", (conflict) => {
    const own = { commentid: "receipt", userid: "bot", text: "hello", reply_id: "-1", replyuser: { userid: "other" } };
    const duplicate = { ...own, replyuser: { ...own.replyuser } };
    if (conflict === "author") duplicate.userid = "other";
    if (conflict === "text") duplicate.text = "edited";
    if (conflict === "reply") duplicate.reply_id = "different";
    if (conflict === "reply-author") duplicate.replyuser.userid = "different";
    expect(() =>
      normalizePost(
        {
          result: {
            link: { linkid: "p", userid: "author" },
            current_comment: { comment: [own] },
            comments: [{ comment: [...(conflict === "root" ? [{ commentid: "other-root", userid: "author", text: "other" }] : []), duplicate] }],
          },
        },
        "p",
      ),
    ).toThrow("conflicting_comment");
  });

  it("retains the scoped receipt before the 100-comment cap and still rejects its later conflicting duplicate", () => {
    const own = { commentid: "receipt", userid: "bot", text: "hello" };
    const value = {
      result: {
        link: { linkid: "p", userid: "author" },
        current_comment: { comment: [own] },
        comments: Array.from({ length: 100 }, (_, i) => ({ comment: [{ commentid: `ordinary-${i}`, userid: "other", text: "older" }] })),
      },
    };
    const post = normalizePost(value, "p");
    expect(post.comments).toHaveLength(100);
    expect(post.comments[0]).toEqual({ id: "receipt", authorId: "bot", text: "hello", rootId: "receipt" });
    value.result.comments[99] = { comment: [{ ...own, text: "conflicting" }] };
    expect(() => normalizePost(value, "p")).toThrow("conflicting_comment");
  });

  it.each([
    { link_id: "wrong" },
    { linkid: "wrong" },
    { root_id: "wrong" },
    { root_comment_id: "wrong" },
    { replyid: "first", reply_id: "different" },
    { user: { userid: "wrong" } },
  ])("rejects contradictory explicit scoped identity/relationships %j", (binding) => {
    expect(() =>
      normalizePost(
        {
          result: {
            link: { linkid: "p", userid: "author" },
            comments: [],
            current_comment: { comment: [{ commentid: "receipt", userid: "bot", text: "hello", ...binding }] },
          },
        },
        "p",
      ),
    ).toThrow();
  });

  it("collects https post images and turns rich text into plain text", () => {
    const blocks = JSON.stringify([
      { type: "text", text: "看图" },
      { type: "img", url: "https://imgheybox.max-c.com/a.jpg" },
      { type: "html", text: '<p><b>粗体</b>&amp;正文</p><img data-original="https://imgheybox.max-c.com/b.png?x=1&amp;y=2" src="data:,">' },
      { type: "img", url: "http://insecure.example/c.jpg" },
    ]);
    const post = normalizePost(
      { result: { link: { linkid: 1, userid: 2, title: "t", text: blocks, imgs: ["https://imgheybox.max-c.com/a.jpg"] }, comments: [] } },
      "1",
    );
    expect(post.text).toBe("看图\n粗体&正文");
    expect(post.imageUrls).toEqual(["https://imgheybox.max-c.com/a.jpg", "https://imgheybox.max-c.com/b.png?x=1&y=2"]);
    const html = normalizePost({ result: { link: { linkid: 1, userid: 2, title: "t", text: "<p>第一段</p><p>第二段</p>" }, comments: [] } }, "1");
    expect(html.text).toBe("第一段\n第二段");
    expect(html.imageUrls).toBeUndefined();
    expect(normalizePosts({ result: { links: [{ linkid: 1, userid: 2, title: "t", description: "<p>摘要</p>" }] } })[0]!.text).toBe("摘要");
  });

  it("normalizes real feed shapes and rejects unsafe IDs", () => {
    expect(normalizePosts({ result: { links: [{ linkid: 12, userid: 34, title: "title", description: "body", cookie: "secret" }] } })).toEqual([
      { id: "12", authorId: "34", title: "title", text: "body" },
    ]);
    expect(normalizePosts({ posts: [{ linkid: "p", userid: "u" }] })).toHaveLength(1);
    expect(() => identifier(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => identifier("../private")).toThrow();
    expect(() => normalizePosts({ unexpected: [] })).toThrow();
  });
  it("preserves floor roots and checks the returned post identity", () => {
    const value = {
      result: {
        link: { linkid: 12, userid: 34, title: "title", text: '[{"type":"text","text":"hello"}]' },
        comments: [
          {
            comment: [
              { commentid: 1, userid: 2, text: "root" },
              { commentid: 3, userid: 4, text: "reply", reply_id: 1 },
            ],
          },
        ],
      },
    };
    expect(normalizePost(value, "12")).toMatchObject({
      id: "12",
      text: "hello",
      comments: [
        { id: "1", rootId: "1" },
        { id: "3", rootId: "1", replyToId: "1" },
      ],
    });
    expect(() => normalizePost(value, "13")).toThrow("post_identity_mismatch");
  });
  it("marks floors whose 楼中楼 are only previewed", () => {
    const value = {
      result: {
        link: { linkid: 12, userid: 34, title: "t", text: "x" },
        comments: [
          {
            comment: [
              { commentid: 1, userid: 2, text: "root", has_more: 1 },
              { commentid: 3, userid: 4, text: "reply", reply_id: 1 },
            ],
          },
          { comment: [{ commentid: 5, userid: 2, text: "closed floor", has_more: 0 }] },
        ],
        has_more_floors: 0,
        total_page: 1,
      },
    };
    const post = normalizePost(value, "12");
    expect(post.comments.map((comment) => [comment.id, comment.moreReplies])).toEqual([
      ["1", true],
      ["3", undefined],
      ["5", undefined],
    ]);
    expect(post.commentsComplete).toBe(false);
  });
});

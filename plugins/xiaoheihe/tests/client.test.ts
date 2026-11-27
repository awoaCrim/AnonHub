import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AppError } from "@yesimbot/foundation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createXiaoheiheApi, identity } from "../src/client.js";
import { commentVerification } from "../src/delivery.js";
import { HeyboxHttp, type HeyboxRequest } from "../src/heybox/http.js";
import { loadSession, normalizeCookies, saveSession } from "../src/heybox/session.js";
import { sign } from "../src/heybox/signing.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const task of cleanup.splice(0)) await task();
});

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, ...init });

describe("direct web client", () => {
  it("reads the official emoji catalog through the existing account HTTP queue", async () => {
    const response = { status: "ok", result: { emoji_groups: [] } };
    const request = vi.fn(async () => response);
    const api = createXiaoheiheApi({ request }, "bot");
    expect(await api.emojis!()).toBe(response);
    expect(request).toHaveBeenCalledExactlyOnceWith("/bbs/app/api/emojis/list", { params: {} });
  });
  it("signs every request, sends the session cookies and keeps refreshed cookies", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
      const response = json({ status: "ok", result: {} });
      response.headers.append("set-cookie", "x_xhh_tokenid=new; Domain=.xiaoheihe.cn; Path=/; Secure");
      response.headers.append("set-cookie", "tracker=1; Domain=.example.com");
      return response;
    });
    const onCookies = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const http = new HeyboxHttp(
      [
        { name: "pkey", value: "k", domain: ".xiaoheihe.cn" },
        { name: "other", value: "x", domain: "evil.test" },
      ],
      {
        intervalMs: 0,
        onCookies,
      },
    );
    await http.request("/bbs/app/feeds", { params: { limit: 5 } });
    const [url, init] = fetch.mock.calls[0]!;
    const query = new URL(url).searchParams;
    expect(new URL(url).origin + new URL(url).pathname).toBe("https://api.xiaoheihe.cn/bbs/app/feeds");
    expect(query.get("limit")).toBe("5");
    expect(query.get("hkey")).toBe(sign("/bbs/app/feeds", Number(query.get("_time")), query.get("nonce")!));
    expect(query.get("_rnd")).toBeNull();
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("cookie")).toBe("pkey=k");
    expect(init).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
    expect(onCookies).toHaveBeenCalledWith([expect.objectContaining({ name: "pkey" }), expect.objectContaining({ name: "x_xhh_tokenid", value: "new" })]);
  });

  it("adds the write signature to form posts and never echoes upstream errors", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => json({ status: "ok" }));
    vi.stubGlobal("fetch", fetch);
    const http = new HeyboxHttp([], { intervalMs: 0 });
    await http.request("/bbs/app/comment/create", { form: { link_id: "1", text: "hi" } });
    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("_rnd")).toMatch(/^15:[0-9a-f]{64}$/);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", body: "link_id=1&text=hi" });
    for (const [response, code] of [
      [json({}, { status: 401 }), "authentication_required"],
      [json({}, { status: 429 }), "rate_limited"],
      [json({ status: "relogin" }), "authentication_required"],
      [json({ status: "show_captcha" }), "captcha_required"],
      [json({ status: "failed", msg: "cookie=SECRET" }), "upstream_rejected"],
      [new Response("not json"), "invalid_upstream_response"],
    ] as const) {
      fetch.mockResolvedValueOnce(response);
      await expect(http.request("/x")).rejects.toThrow(code);
    }
    fetch.mockRejectedValueOnce(new Error("socket hang up SECRET"));
    await expect(http.request("/x", { form: {} })).rejects.toThrow(/^network_failed$/);
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(() => http.request("https://evil.test/x")).toThrow("invalid_api_path");
  });

  it("never follows a redirect, so the session cookies stay with the API host", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } }));
    vi.stubGlobal("fetch", fetch);
    const http = new HeyboxHttp([{ name: "pkey", value: "k", domain: ".xiaoheihe.cn" }], { intervalMs: 0 });
    await expect(http.request("/x")).rejects.toThrow("upstream_http_error");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reads the identity like the web login does", () => {
    expect(identity({ result: { profile: { heybox_id: 0 }, account_detail: { userid: 42 } } })).toBe("42");
    expect(() => identity({ result: {} })).toThrow("authentication_required");
  });
});

function fakeHttp(routes: Record<string, (request: HeyboxRequest) => unknown>) {
  const calls: Array<{ path: string; request: HeyboxRequest }> = [];
  return {
    calls,
    http: {
      request: vi.fn(async (path: string, request: HeyboxRequest = {}) => {
        calls.push({ path, request });
        const route = routes[path];
        if (!route) throw new Error(`unexpected ${path}`);
        return route(request) as Record<string, unknown>;
      }),
    },
  };
}

const tree = (comments: unknown[] = []) => ({ status: "ok", result: { link: { linkid: "p", userid: "author", title: "t", text: "body" }, comments } });

describe("API operations", () => {
  it("keeps post, root and nested-reply create_at through native reads and floor reconstruction", async () => {
    const root = { commentid: "r", userid: "u", text: "root", create_at: 1577934245 };
    const link = { ...tree().result.link, create_at: 1577934245, topics: [{ topic_id: "7" }] };
    const response = { result: { link, current_comment: { comment: [root] }, comments: [] } };
    const { http } = fakeHttp({
      "/bbs/app/feeds": () => ({ result: { links: [{ link }] } }),
      "/bbs/app/topic/feeds": () => ({ result: { links: [link] } }),
      "/bbs/app/api/general/search/v1": () => ({ result: { links: [{ info: link }] } }),
      "/bbs/app/link/tree": () => response,
      "/bbs/app/comment/sub/comments": () => ({
        result: { comments: [{ commentid: "reply", userid: "v", text: "reply", reply_id: "r", create_at: "1767323045" }], has_more: false },
      }),
    });
    const api = createXiaoheiheApi(http, "bot");
    for (const posts of [await api.feed(10), await api.community("7", 10), await api.search("phone", 10)])
      expect(posts[0]!.publishedAt).toBe("2020-01-02T03:04:05.000Z");
    expect((await api.post("p")).comments[0]!.publishedAt).toBe("2020-01-02T03:04:05.000Z");
    const floor = (await api.thread("p", "r")).detail;
    expect(floor.publishedAt).toBe("2020-01-02T03:04:05.000Z");
    expect(floor.comments.map((comment) => comment.publishedAt)).toEqual(["2020-01-02T03:04:05.000Z", "2026-01-02T03:04:05.000Z"]);
  });

  it("finds the exact receipt in current_comment even when ordinary latest/hot pages omit it", async () => {
    const { http, calls } = fakeHttp({
      "/bbs/app/comment/create": () => ({ result: { commentid: "988104402" } }),
      "/bbs/app/link/tree": (request) => ({
        ...tree([{ comment: [{ commentid: "unrelated", userid: "other", text: "older" }] }]),
        result: {
          ...tree().result,
          comments: [{ comment: [{ commentid: "unrelated", userid: "other", text: "older" }] }],
          total_page: 55,
          ...(request.params?.root_comment_id === "988104402"
            ? { current_comment: { comment: [{ commentid: "988104402", userid: "bot", text: "hello", user: { userid: "bot" } }] } }
            : {}),
        },
      }),
    });
    const api = createXiaoheiheApi(http, "bot");
    expect(await api.comment("p", "hello")).toEqual({ accepted: true, verified: true, id: "988104402" });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ path: "/bbs/app/link/tree", request: { params: { link_id: "p", root_comment_id: "988104402", h_src: "" } } });
    expect(calls.filter((call) => call.request.form)).toHaveLength(1);
  });

  it("keeps a known floor's current_comment replies when the subcomment page omits the receipt", async () => {
    let written = false;
    const root = { commentid: "r", userid: "author", text: "root", reply_id: "-1", replyuser: { userid: "root-metadata" } };
    const target = { commentid: "target", userid: "asker", text: "question", root_id: "r", reply_id: "r" };
    const own = { commentid: "receipt", userid: "bot", text: "answer", root_id: "r", reply_id: "target", replyuser: { userid: "asker" } };
    const { http, calls } = fakeHttp({
      "/bbs/app/link/tree": (request) =>
        request.params?.root_comment_id === "r"
          ? { result: { ...tree().result, comments: [], current_comment: { comment: [root, target, ...(written ? [own] : [])] } } }
          : tree(),
      "/bbs/app/comment/sub/comments": () => ({ result: { comments: [target], has_more: 1, lastval: "target" } }),
      "/bbs/app/comment/create": () => {
        written = true;
        return { result: { commentid: "receipt" } };
      },
    });
    expect(await createXiaoheiheApi(http, "bot").comment("p", "answer", { id: "target", rootId: "r", authorId: "asker", text: "question" })).toEqual({
      accepted: true,
      verified: true,
      id: "receipt",
    });
    expect(calls.filter((call) => call.request.form)).toHaveLength(1);
    expect(calls.filter((call) => call.request.params?.root_comment_id === "r")).toHaveLength(4);
    expect(calls.some((call) => call.request.params?.root_comment_id === "receipt")).toBe(false);
    expect(calls).toHaveLength(7);
  });

  it.each(["author", "text", "root", "reply", "reply-author", "target-author", "target-text", "conflict", "post"])(
    "rejects a scoped reply with mismatched %s evidence",
    async (mismatch) => {
      const root = { commentid: "r", userid: "author", text: "root" };
      const target = { commentid: "target", userid: "asker", text: "question", root_id: "r", reply_id: "r" };
      const own = { commentid: "receipt", userid: "bot", text: "answer", root_id: "r", reply_id: "target", replyuser: { userid: "asker" } };
      const evidence = commentVerification("p", "answer", { id: "target", rootId: "r", authorId: "asker", text: "question" });
      if (mismatch === "author") own.userid = "other";
      if (mismatch === "text") own.text = "edited";
      if (mismatch === "root") own.root_id = "other";
      if (mismatch === "reply") own.reply_id = "other";
      if (mismatch === "reply-author") own.replyuser.userid = "other";
      if (mismatch === "target-author") target.userid = "other";
      if (mismatch === "target-text") target.text = "edited";
      const { http, calls } = fakeHttp({
        "/bbs/app/link/tree": (request) =>
          request.params?.root_comment_id
            ? {
                result: {
                  ...tree().result,
                  link: { ...tree().result.link, linkid: mismatch === "post" ? "elsewhere" : "p" },
                  current_comment: { comment: [root, target, own] },
                },
              }
            : tree(),
        "/bbs/app/comment/sub/comments": () => ({
          result: { comments: [target, ...(mismatch === "conflict" ? [{ ...own, text: "conflicting" }] : [])], has_more: 0 },
        }),
      });
      const verified = await createXiaoheiheApi(http, "bot").verifyPublication!("receipt", evidence).catch(() => false);
      expect(verified).toBe(false);
      expect(calls).toHaveLength(3);
      expect(calls.every((call) => !call.request.form)).toBe(true);
    },
  );

  it("retries only GET verification for delayed visibility and accepts one unambiguous nested ID", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const { http, calls } = fakeHttp({
      "/bbs/app/comment/create": () => ({ status: "ok", data: { comment: { comment_id: "900" } } }),
      "/bbs/app/link/tree": () => tree(++reads < 3 ? [] : [{ comment: [{ commentid: 900, userid: "bot", text: "hello" }] }]),
    });
    const pending = createXiaoheiheApi(http, "bot").comment("p", "hello");
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ accepted: true, verified: true, id: "900" });
    expect(reads).toBe(3);
    expect(calls.filter((call) => call.request.form)).toHaveLength(1);
    expect(calls.filter((call) => !call.request.form)).toHaveLength(3);
  });

  it("looks for the receipt at once and again after 2, 4 and 8 seconds, never repeating the POST", async () => {
    vi.useFakeTimers();
    const { http, calls } = fakeHttp({
      "/bbs/app/comment/create": () => ({ commentid: "900" }),
      "/bbs/app/link/tree": () => tree([]),
    });
    const pending = createXiaoheiheApi(http, "bot").comment("p", "hello");
    const reads = () => calls.filter((call) => !call.request.form).length;
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(reads()).toBe(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(reads()).toBe(4);
    expect(await pending).toMatchObject({ verified: false, id: "900", errorCode: "publication_verification_pending" });
    expect(calls.filter((call) => call.request.form)).toHaveLength(1);
  });

  it.each(["id", "author", "text", "relationship", "post"])("rejects mismatched %s readback with bounded GETs and one POST", async (mismatch) => {
    vi.useFakeTimers();
    const own = {
      commentid: mismatch === "id" ? "other" : "900",
      userid: mismatch === "author" ? "other" : "bot",
      text: mismatch === "text" ? "different" : "hello",
      ...(mismatch === "relationship" ? { reply_id: "another" } : {}),
    };
    const { http, calls } = fakeHttp({
      "/bbs/app/comment/create": () => ({ result: { commentid: "900" } }),
      "/bbs/app/link/tree": () => {
        const data = tree([{ comment: [own] }]);
        if (mismatch === "post") data.result.link.linkid = "other";
        return data;
      },
    });
    const pending = createXiaoheiheApi(http, "bot").comment("p", "hello");
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ accepted: true, verified: false, id: "900", errorCode: "publication_verification_pending" });
    expect(calls.filter((call) => call.request.form)).toHaveLength(1);
    expect(calls.filter((call) => !call.request.form)).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{}, { commentid: "1", result: { comment_id: "2" } }])("does not guess a missing or conflicting receipt ID %#", async (receipt) => {
    const { http, calls } = fakeHttp({ "/bbs/app/comment/create": () => receipt });
    expect(await createXiaoheiheApi(http, "bot").comment("p", "hello")).toEqual({ accepted: true, verified: false });
    expect(calls).toHaveLength(1);
  });

  it("rejects a longer comment sharing the maximum-length publication prefix", async () => {
    vi.useFakeTimers();
    const body = "x".repeat(2000);
    const { http } = fakeHttp({
      "/bbs/app/comment/create": () => ({ commentid: "900" }),
      "/bbs/app/link/tree": () => tree([{ comment: [{ commentid: "900", userid: "bot", text: body + "extra" }] }]),
    });
    const pending = createXiaoheiheApi(http, "bot").comment("p", body);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ verified: false, id: "900", errorCode: "publication_verification_pending" });
  });

  it.each(["authentication_required", "captcha_required", "rate_limited"])("retains the receipt ID and safe %s on verification failure", async (code) => {
    const { http, calls } = fakeHttp({
      "/bbs/app/comment/create": () => ({ commentid: "900" }),
      "/bbs/app/link/tree": () => {
        throw new AppError(code);
      },
    });
    expect(await createXiaoheiheApi(http, "bot").comment("p", "hello")).toEqual({ accepted: true, verified: false, id: "900", errorCode: code });
    expect(calls).toHaveLength(2);
  });

  it("retains exact new-post topic evidence for later read-only reconciliation", async () => {
    vi.useFakeTimers();
    let visible = false;
    const { http, calls } = fakeHttp({
      "/bbs/app/api/link/post": () => ({ result: { linkid: "new" } }),
      "/bbs/app/link/tree": () => ({
        result: {
          link: {
            linkid: "new",
            userid: "bot",
            title: visible ? "Title" : "unrelated",
            text: JSON.stringify([{ type: "text", text: "Body" }]),
            link_tag: "28",
          },
        },
      }),
    });
    const api = createXiaoheiheApi(http, "bot");
    const pending = api.publish("Title", "Body", []);
    await vi.runAllTimersAsync();
    const receipt = await pending;
    expect(receipt).toMatchObject({ accepted: true, verified: false, id: "new", verification: { kind: "post", topicIds: ["58144"] } });
    expect(await api.verifyPublication!("new", receipt.verification!)).toBe(false);
    visible = true;
    expect(await api.verifyPublication!("new", receipt.verification!)).toBe(true);
    expect(calls.filter((call) => call.request.form)).toHaveLength(1);
    expect(JSON.stringify(receipt)).not.toContain("Body");
  });
  it("finds communities and keeps only that community's posts", async () => {
    const { http, calls } = fakeHttp({
      "/bbs/app/api/post_editor/topic_selection/search": () => ({
        result: {
          search_result: [
            { search_type: "topic", topic_id: 7, name: "单机游戏", desc: "聊单机" },
            { search_type: "hashtag", name: "单机" },
          ],
        },
      }),
      "/bbs/app/topic/feeds": () => ({
        result: {
          links: [
            { linkid: 1, userid: 2, title: "in", topics: [{ topic_id: 7 }] },
            { linkid: 3, userid: 2, title: "elsewhere", topics: [{ topic_id: 8 }] },
          ],
        },
      }),
    });
    const api = createXiaoheiheApi(http, "bot");
    expect(await api.findCommunities("单机", 10)).toEqual([{ id: "7", name: "单机游戏", description: "聊单机" }]);
    expect((await api.community("7", 10)).map((post) => post.title)).toEqual(["in"]);
    expect(calls[1]!.request.params).toMatchObject({ topic_id: "7", limit: 10 });
  });

  it("pages a floor's 楼中楼", async () => {
    const { http } = fakeHttp({
      "/bbs/app/link/tree": (request) =>
        request.params?.root_comment_id ? { result: { comments: [{ comment: [{ commentid: "r", userid: "u", text: "root" }] }] } } : tree(),
      "/bbs/app/comment/sub/comments": () => ({
        result: { comments: [{ commentid: "c", userid: "u2", text: "deep", reply_id: "r" }], has_more: 1, lastval: "c" },
      }),
    });
    const api = createXiaoheiheApi(http, "bot");
    const page = await api.thread("p", "r");
    expect(page.nextCursor).toBe("c");
    expect(page.detail.comments.map((comment) => [comment.id, comment.rootId])).toEqual([
      ["r", "r"],
      ["c", "r"],
    ]);
  });

  it("verifies a top-level comment by reading it back", async () => {
    const { http, calls } = fakeHttp({
      "/bbs/app/comment/create": () => ({ status: "ok", result: { commentid: 900 } }),
      "/bbs/app/link/tree": () => tree([{ comment: [{ commentid: 900, userid: "bot", text: "hello" }] }]),
    });
    const api = createXiaoheiheApi(http, "bot");
    expect(await api.comment("p", "hello")).toEqual({ accepted: true, verified: true, id: "900" });
    expect(calls[0]!.request.form).toEqual({ link_id: "p", text: "hello", root_id: "-1", reply_id: "-1", is_cy: "0" });
    expect(calls[1]!.request.params).toMatchObject({ link_id: "p", root_comment_id: "900" });
  });

  it("checks a reply target before writing and reports a changed target as not sent", async () => {
    let text = "question";
    let written = false;
    const { http, calls } = fakeHttp({
      "/bbs/app/link/tree": (request) =>
        request.params?.root_comment_id ? { result: { comments: [{ comment: [{ commentid: "r", userid: "u", text: "root" }] }] } } : tree(),
      "/bbs/app/comment/sub/comments": () => ({
        result: {
          comments: [{ commentid: "c", userid: "asker", text }, ...(written ? [{ commentid: 901, userid: "bot", text: "answer", reply_id: "c" }] : [])],
          has_more: 0,
        },
      }),
      "/bbs/app/comment/create": () => {
        written = true;
        return { status: "ok", result: { commentid: 901 } };
      },
    });
    const api = createXiaoheiheApi(http, "bot");
    const target = { id: "c", rootId: "r", authorId: "asker", text: "question" };
    expect(await api.comment("p", "answer", target)).toEqual({ accepted: true, verified: true, id: "901" });
    expect(calls.find((call) => call.path === "/bbs/app/comment/create")!.request.form).toMatchObject({ root_id: "r", reply_id: "c" });
    text = "edited";
    calls.length = 0;
    expect(await api.comment("p", "answer", target)).toEqual({ accepted: false, verified: false, notSent: true, errorCode: "reply_target_changed" });
    expect(calls.some((call) => call.path === "/bbs/app/comment/create")).toBe(false);
    expect(await api.comment("p", "answer", { ...target, id: "missing" })).toMatchObject({ notSent: true, errorCode: "reply_target_unavailable" });
  });

  it("does not publish against a truncated long target when the visible prefix matches", async () => {
    const text = "x".repeat(2010);
    const { http, calls } = fakeHttp({
      "/bbs/app/link/tree": (request) =>
        request.params?.root_comment_id ? { result: { comments: [{ comment: [{ commentid: "r", userid: "author", text: "root" }] }] } } : tree(),
      "/bbs/app/comment/sub/comments": () => ({ result: { comments: [{ commentid: "target", userid: "asker", text }], has_more: 0 } }),
    });
    expect(await createXiaoheiheApi(http, "bot").comment("p", "answer", { id: "target", rootId: "r", authorId: "asker", text: text.slice(0, 2001) })).toEqual({
      accepted: false,
      verified: false,
      notSent: true,
      errorCode: "reply_target_changed",
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => !call.request.form)).toBe(true);
  });

  it("lets an ambiguous write fail instead of claiming it was not sent", async () => {
    const { http } = fakeHttp({
      "/bbs/app/comment/create": () => {
        throw new AppError("network_failed");
      },
    });
    await expect(createXiaoheiheApi(http, "bot").comment("p", "hello")).rejects.toThrow("network_failed");
  });
});

describe("session file", () => {
  it("reads the xiaoheihe-cli layout, writes privately and refuses symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xhh-session-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "nested", "session.json");
    expect(await loadSession(file)).toBeUndefined();
    await saveSession(file, {
      user_id: "bot",
      cookies: [
        { name: "pkey", value: "k", domain: ".xiaoheihe.cn" },
        { name: "x", value: "y", domain: "evil.test" },
      ],
    });
    expect(((await lstat(file)).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(await readFile(file, "utf8")).cookies).toEqual([{ name: "pkey", value: "k", domain: ".xiaoheihe.cn" }]);
    expect(await loadSession(file)).toEqual({ user_id: "bot", cookies: [{ name: "pkey", value: "k", domain: ".xiaoheihe.cn" }] });
    await writeFile(join(dir, "bad.json"), JSON.stringify({ cookies: [] }));
    await expect(loadSession(join(dir, "bad.json"))).rejects.toThrow("session_invalid");
    await symlink(file, join(dir, "link.json"));
    await expect(loadSession(join(dir, "link.json"))).rejects.toThrow("session_file_symlink");
  });

  it("keeps the id and key cookie aliases in sync", () => {
    const cookies = normalizeCookies(
      [
        { name: "user_pkey", value: "k", domain: ".xiaoheihe.cn" },
        { name: "keep", value: "v", domain: "www.xiaoheihe.cn" },
      ],
      { heybox_id: 42 },
    );
    expect(Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value]))).toEqual({
      keep: "v",
      user_heybox_id: "42",
      heybox_id: "42",
      user_pkey: "k",
      pkey: "k",
    });
  });
});

import { afterEach, expect, it, vi } from "vitest";

import { api, ApiError, onUnauthorized } from "../web/src/lib/api";
import { clearCaches } from "../web/src/lib/cache";

afterEach(() => {
  clearCaches();
  onUnauthorized(undefined);
  vi.useRealTimers();
});

const path = "/yesimbot/api/v1/chat/uploads?name=notes.txt";
const json = (value: unknown) => new Response(JSON.stringify(value));

it.each([undefined, "PUT"] as const)("sends a native Blob as an uncached binary write with method %s", async (method) => {
  const bytes = new Uint8Array([0, 255, 10, 128]);
  const rawBody = new Blob([bytes], { type: "image/png" });
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.body).toBe(rawBody);
    expect(new Uint8Array(await (init!.body as Blob).arrayBuffer())).toEqual(bytes);
    return json({ id: "uploaded" });
  });
  expect(await api(path, undefined, { rawBody, method }, fetcher)).toEqual({ id: "uploaded" });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    path,
    expect.objectContaining({
      method: method ?? "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/octet-stream" },
      body: rawBody,
      signal: expect.any(AbortSignal),
    }),
  );
});

it("preserves the existing JSON write format", async () => {
  const fetcher = vi.fn(async () => json({ ok: true }));
  await api("/yesimbot/api/v1/chat/send", { text: "你好" }, {}, fetcher);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "/yesimbot/api/v1/chat/send",
    expect.objectContaining({ method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: '{"text":"你好"}' }),
  );
});

it("invalidates nearby cached reads for binary writes", async () => {
  const readPath = "/yesimbot/api/v1/plugins/config?path=yesimbot%3Amain";
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ revision: "old" }))
    .mockResolvedValueOnce(json({ ok: true }))
    .mockResolvedValueOnce(json({ revision: "latest" }));
  expect(await api(readPath, undefined, {}, fetcher)).toEqual({ revision: "old" });
  await api(readPath, undefined, {}, fetcher);
  expect(fetcher).toHaveBeenCalledOnce();
  await api("/yesimbot/api/v1/plugins/upload", undefined, { rawBody: new Blob(["data"]) }, fetcher);
  expect(await api(readPath, undefined, {}, fetcher)).toEqual({ revision: "latest" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each(["timeout", "abort"])("classifies a binary write %s as an unknown write outcome", async (reason) => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const fetcher = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      }),
  );
  const pending = api(path, undefined, { rawBody: new Blob(["data"]), signal: caller.signal }, fetcher);
  const failed = pending.catch((error: unknown) => error);
  if (reason === "timeout") await vi.advanceTimersByTimeAsync(5 * 60_000);
  else caller.abort();
  expect(await failed).toEqual(new ApiError(0, "write_unknown"));
});

it("classifies binary network failures as write_unknown while preserving read failures", async () => {
  const failure = new TypeError("offline");
  const fetcher = vi.fn(async () => {
    throw failure;
  });
  await expect(api(path, undefined, { rawBody: new Blob(["data"]) }, fetcher)).rejects.toEqual(new ApiError(0, "write_unknown"));
  await expect(api(path, undefined, {}, fetcher)).rejects.toBe(failure);
});

it("preserves binary HTTP error details and unauthorized handling", async () => {
  const unauthorized = vi.fn();
  onUnauthorized(unauthorized);
  const fetcher = vi.fn(
    async () => new Response('{"message":"expired","path":"uploads/notes.txt","restored":false}', { status: 401, headers: { "Retry-After": "5" } }),
  );
  const expected = new ApiError(401, "expired", 5, "uploads/notes.txt", false);
  await expect(api(path, undefined, { rawBody: new Blob(["data"]) }, fetcher)).rejects.toEqual(expected);
  expect(unauthorized).toHaveBeenCalledExactlyOnceWith(path);
  await expect(api(path, undefined, { rawBody: new Blob(["data"]), allowUnauthorized: true }, fetcher)).rejects.toEqual(expected);
  expect(unauthorized).toHaveBeenCalledOnce();
});

// An upload on a slow link takes longer than an ordinary write (user, 2026-11-27: 「我一个3m的图片上传不了」).
it("gives a native upload five minutes and an ordinary write thirty seconds", async () => {
  vi.useFakeTimers();
  const hang = (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const upload = api(path, undefined, { rawBody: new Blob([new Uint8Array([1])]) }, vi.fn(hang)).catch((error: unknown) => error);
  const write = api("/yesimbot/api/v1/chat/send", { text: "你好" }, {}, vi.fn(hang)).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await write).toMatchObject({ code: "write_unknown" });
  let settled = false;
  void upload.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(await upload).toBeInstanceOf(ApiError);
});

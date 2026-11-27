import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";

import { installFiles, MAX_UPLOAD_BYTES, safeName, UPLOAD_ROOT } from "../src/webui/files.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0)) await task();
});

interface TestHttp {
  status: number;
  body: unknown;
  query: Record<string, unknown>;
  request: { body?: unknown };
  req: PassThrough;
  set: ReturnType<typeof vi.fn>;
  get(name: string): string;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-files-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  await mkdir(join(base, "data/cards"), { recursive: true });
  await writeFile(join(base, "data/cards/alice.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "outside.png"), "secret");
  const routes = new Map<string, (http: TestHttp) => Promise<unknown>>();
  const ctx = {
    baseDir: base,
    server: {
      get: (path: string, fn: (http: TestHttp) => Promise<unknown>) => routes.set("GET " + path, fn),
      post: (path: string, fn: (http: TestHttp) => Promise<unknown>) => routes.set("POST " + path, fn),
    },
  };
  const current = { session: { role: "owner" } as { role: string } | undefined, sameOrigin: true };
  installFiles(ctx as never, { sessionFromCookie: () => current.session, sameOrigin: () => current.sameOrigin } as never);
  async function call(method: string, route: string, query: Record<string, unknown> = {}, upload?: { body: Buffer; type?: string }) {
    const headers: Record<string, string> = {
      "content-type": upload?.type ?? "application/octet-stream",
      ...(upload ? { "content-length": String(upload.body.length) } : {}),
    };
    const req = new PassThrough();
    const http: TestHttp = { status: 200, body: undefined, query, request: {}, req, set: vi.fn(), get: (name) => headers[name] ?? "" };
    const done = routes.get(`${method} /yesimbot/api/v1/files/${route}`)!(http);
    if (upload) req.end(upload.body);
    await done;
    return http;
  }
  return { root, base, current, call };
}

it("is owner-only and requires same origin for uploads", async () => {
  const { current, call } = await fixture();
  current.session = undefined;
  expect((await call("GET", "list", { dir: "" })).status).toBe(401);
  current.session = { role: "member" };
  expect((await call("GET", "stat", { path: "data" })).status).toBe(403);
  current.session = { role: "owner" };
  current.sameOrigin = false;
  const http = await call("POST", "upload", { name: "a.png" }, { body: Buffer.from("x") });
  expect([http.status, http.body]).toEqual([403, { message: "same_origin_required" }]);
});

it("lists and stats inside the base directory and refuses escapes", async () => {
  const { root, base, call } = await fixture();
  const listing = (await call("GET", "list", { dir: "data" })).body as {
    dir: string;
    parent: string;
    entries: Array<{ name: string; type: string; path: string }>;
  };
  expect(listing).toMatchObject({ dir: "data", parent: "." });
  expect(listing.entries).toEqual([expect.objectContaining({ name: "cards", type: "directory", path: "data/cards" })]);
  expect((await call("GET", "stat", { path: "data/cards/alice.png" })).body).toMatchObject({ exists: true, type: "file", size: 4 });
  expect((await call("GET", "stat", { path: "data/missing.png" })).body).toEqual({ path: "data/missing.png", exists: false });
  expect((await call("GET", "stat", { path: "../outside.png" })).body).toEqual({ path: "../outside.png", exists: false, outside: true });
  expect((await call("GET", "list", { dir: ".." })).status).toBe(403);
  await symlink(root, join(base, "data/escape"));
  expect((await call("GET", "list", { dir: "data/escape" })).status).toBe(403);
  expect((await call("GET", "preview", { path: "data/escape/outside.png" })).status).toBe(403);
});

it("previews images only", async () => {
  const { base, call } = await fixture();
  await writeFile(join(base, "data/koishi.yml"), "token: x");
  const image = await call("GET", "preview", { path: "data/cards/alice.png" });
  expect(image.set).toHaveBeenCalledWith("Content-Type", "image/png");
  expect(Buffer.isBuffer(image.body)).toBe(true);
  expect((await call("GET", "preview", { path: "data/koishi.yml" })).status).toBe(415);
});

it("stores uploads under the plugin scope with a content-hashed, sanitized name", async () => {
  const { base, call } = await fixture();
  const body = Buffer.from("card-bytes");
  const http = await call("POST", "upload", { name: "../../我的 角色<1>.PNG", scope: "yesimbot-roleplay" }, { body });
  const result = http.body as { path: string; size: number };
  expect(result.path).toMatch(new RegExp(`^${UPLOAD_ROOT}/yesimbot-roleplay/我的 角色_1_-[0-9a-f]{10}\\.png$`));
  expect(result.size).toBe(body.length);
  expect(await readFile(join(base, result.path), "utf8")).toBe("card-bytes");
  // Same bytes, same file; unknown scopes fall back to misc.
  expect(((await call("POST", "upload", { name: "我的 角色<1>.PNG", scope: "yesimbot-roleplay" }, { body })).body as { path: string }).path).toBe(result.path);
  expect(((await call("POST", "upload", { name: "a.png", scope: "../x" }, { body })).body as { path: string }).path).toMatch(
    /^data\/yesimbot\/uploads\/misc\//,
  );
});

it("rejects wrong content types, empty bodies and oversize uploads", async () => {
  const { call } = await fixture();
  expect((await call("POST", "upload", { name: "a.png" }, { body: Buffer.from("{}"), type: "application/json" })).status).toBe(415);
  expect((await call("POST", "upload", { name: "a.png" }, { body: Buffer.alloc(0) })).body).toEqual({ message: "empty_upload" });
  expect((await call("POST", "upload", { name: "a.png" }, { body: Buffer.alloc(MAX_UPLOAD_BYTES + 1) })).status).toBe(413);
  expect(safeName(".hidden")).toBe("hidden");
  expect(safeName("C:\\fakepath\\card.Png")).toBe("card.png");
});

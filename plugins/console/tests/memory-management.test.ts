import { expect, it, vi } from "vitest";

import type { AdminHttpContext, AdminSession } from "../src/admin-auth.js";
import { installMemory } from "../src/webui/memory.js";

interface MemoryHttp extends Pick<AdminHttpContext, "status" | "body" | "set" | "get"> {
  query: Record<string, string>;
  input?: unknown;
}

type MemoryRoute = (http: MemoryHttp) => Promise<void>;

vi.mock("../src/admin-auth.js", () => ({ readAdminLoginBody: async (http: { input: unknown }) => http.input }));
function harness() {
  const routes = new Map<string, MemoryRoute>();
  const service = {
    list: vi.fn(async () => ({ memories: [{ id: "a", content: "a fact" }] })),
    update: vi.fn(async (_input: unknown, _authorize: () => void): Promise<unknown> => ({ id: "a" })),
    delete: vi.fn(async (_input: unknown, _authorize: () => void): Promise<unknown> => ({ deleted: true })),
  };
  const session = { role: "owner" } as const;
  const auth = { sessionFromCookie: vi.fn((): Pick<AdminSession, "role"> | null => session), sameOrigin: vi.fn(() => true) };
  const ctx = {
    get: vi.fn(() => service),
    server: { get: (path: string, f: MemoryRoute) => routes.set("get" + path, f), post: (path: string, f: MemoryRoute) => routes.set("post" + path, f) },
  };
  installMemory(ctx as never, auth as never);
  const call = async (method: string, input?: unknown) => {
    const http: MemoryHttp = { query: {}, input, set() {}, get: () => "", status: 200, body: undefined };
    await routes.get(method + "/yesimbot/api/v1/memory")!(http);
    return http;
  };
  return { service, auth, ctx, call, routes };
}
it("uses only the current runtime memory service and rejects member access", async () => {
  const h = harness();
  expect(((await h.call("get")).body as { memories: unknown[] }).memories).toHaveLength(1);
  expect(h.ctx.get).toHaveBeenCalledWith("yesimbotMemory");
  h.auth.sessionFromCookie.mockReturnValue({ role: "member" });
  expect((await h.call("post", { action: "delete", id: "a", revision: 1 })).status).toBe(403);
  expect(h.service.delete).not.toHaveBeenCalled();
});
it("requires same origin, validates edits and reports revision conflicts", async () => {
  const h = harness();
  h.auth.sameOrigin.mockReturnValue(false);
  expect((await h.call("post", { action: "delete", id: "a", revision: 1 })).status).toBe(403);
  h.auth.sameOrigin.mockReturnValue(true);
  expect((await h.call("post", { action: "update", id: "a", revision: 1, content: "fact", visibility: "everyone" })).status).toBe(400);
  expect(h.service.update).not.toHaveBeenCalled();
  h.service.update.mockRejectedValueOnce(Error("memory_revision_conflict"));
  expect((await h.call("post", { action: "update", id: "a", revision: 1, content: "fact", visibility: "owner", tenantId: "other" })).status).toBe(409);
  expect(h.service.update).toHaveBeenCalledWith({ id: "a", revision: 1, content: "fact", visibility: "owner" }, expect.any(Function));
});

it("leaves visibility absent for a body-only edit so the record retains its ownership", async () => {
  const h = harness();
  expect((await h.call("post", { action: "update", id: "a", revision: 1, content: "corrected old fact" })).status).toBe(200);
  expect(h.service.update).toHaveBeenCalledWith({ id: "a", revision: 1, content: "corrected old fact" }, expect.any(Function));
});

it.each(["update", "delete"] as const)("preserves authentication failures for a queued %s without committing", async (action) => {
  for (const failure of ["expired", "member", "replaced", "origin"] as const) {
    const h = harness();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const commit = vi.fn();
    h.service[action].mockImplementationOnce(async (_input, authorize) => {
      entered();
      await blocked;
      authorize();
      commit();
      return {};
    });
    const pending = h.call("post", { action, id: "a", revision: 1, content: "fact", visibility: "shared" });
    await started;
    if (failure === "expired") h.auth.sessionFromCookie.mockReturnValue(null);
    if (failure === "member") h.auth.sessionFromCookie.mockReturnValue({ role: "member" });
    if (failure === "replaced") h.auth.sessionFromCookie.mockReturnValue({ role: "owner" });
    if (failure === "origin") h.auth.sameOrigin.mockReturnValue(false);
    release();
    const response = await pending;
    expect(response.status).toBe(failure === "member" || failure === "origin" ? 403 : 401);
    expect((response.body as { message: string }).message).toBe(
      failure === "member" ? "owner_required" : failure === "origin" ? "same_origin_required" : "login_required",
    );
    expect(commit).not.toHaveBeenCalled();
  }
});

it("serves a memory's attachment to the owner only, a picture in place and anything else as a download", async () => {
  const h = harness();
  const headers: Record<string, string> = {};
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const attachment = vi.fn(async (id: string, index: number) => {
    if (id !== "a" || index !== 1) throw Error("memory_not_found");
    return { bytes: png, mediaType: "image/png", filename: "立绘.png" };
  });
  Object.assign(h.service, { attachment });
  const fetch = async (query: Record<string, string>) => {
    const http: MemoryHttp = { query, set: (name: string, value: string) => void (headers[name] = value), get: () => "", status: 200, body: undefined };
    await h.routes.get("get/yesimbot/api/v1/memory/attachment")!(http);
    return http;
  };
  const shown = await fetch({ id: "a", index: "1" });
  expect(shown.body).toEqual(Buffer.from(png));
  expect(headers).toMatchObject({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Content-Disposition": expect.stringMatching(/^inline;/) });
  expect(headers["Content-Security-Policy"]).toContain("sandbox");
  expect(attachment).toHaveBeenCalledWith("a", 1);
  await fetch({ id: "a", index: "1", download: "1" });
  expect(headers["Content-Disposition"]).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("立绘.png")}`);
  expect((await fetch({ id: "a", index: "2" })).status).toBe(404);
  expect((await fetch({ id: "a", index: "0" })).status).toBe(404);
  expect((await fetch({ id: "a", index: "../1" })).status).toBe(404);
  attachment.mockClear();
  h.auth.sessionFromCookie.mockReturnValue({ role: "member" });
  expect((await fetch({ id: "a", index: "1" })).status).toBe(403);
  expect(attachment).not.toHaveBeenCalled();
});

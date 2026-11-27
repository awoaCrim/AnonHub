import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpsInstance } from "../src/shared/accounts";
import { ManagerError, sanitizeOps, TenantManagerClient } from "../src/tenant-manager-client";
import { INSTANCE_NAPCAT_PREFIX, INSTANCE_RESTART_PATH, installInstanceOps } from "../src/webui/instance-ops";

const id = "00000000-0000-4000-8000-000000000001";
afterEach(() => vi.unstubAllGlobals());

type Handler = (http: Record<string, unknown>) => Promise<void>;
function setup(role: "owner" | "member" | undefined, sameOrigin = true) {
  const routes = new Map<string, Handler>();
  const ctx = {
    server: {
      get: (path: string, cb: Handler) => routes.set(`GET ${path}`, cb),
      post: (path: string, cb: Handler) => routes.set(`POST ${path}`, cb),
    },
  };
  const auth = {
    requireOwner: (http: { status: number }) => {
      if (role === "owner") return true;
      http.status = role ? 403 : 401;
      return false;
    },
    sameOrigin: () => sameOrigin,
  };
  const manager = {
    restart: vi.fn(async (_target: string, _program: string) => ({ status: 200 as number, instance: { target: id } as OpsInstance })),
    napcat: vi.fn(async (..._args: unknown[]) => ({ status: 200, body: { available: true, loggedIn: true } })),
  };
  installInstanceOps(ctx as never, auth as never, manager as never);
  const call = async (key: string, init: { params?: Record<string, string>; body?: unknown } = {}) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const http = {
      status: 200,
      body: undefined as unknown,
      params: init.params ?? {},
      query: {},
      set: () => {},
      get: (name: string) => (name === "content-type" ? "application/json" : name === "content-length" && body ? String(body.length) : ""),
      request: { body: init.body },
      req: {},
    };
    await routes.get(key)!(http);
    return http;
  };
  return { call, manager, routes };
}

describe("instance restart route", () => {
  const key = `POST ${INSTANCE_RESTART_PATH}`;
  it("is owner-only and same-origin", async () => {
    expect((await setup("member").call(key, { body: { target: "owner", program: "napcat" } })).status).toBe(403);
    expect((await setup(undefined).call(key, { body: { target: "owner", program: "napcat" } })).status).toBe(401);
    const blocked = setup("owner", false);
    expect((await blocked.call(key, { body: { target: "owner", program: "napcat" } })).status).toBe(403);
    expect(blocked.manager.restart).not.toHaveBeenCalled();
  });
  it("validates target and program before the manager is called", async () => {
    const { call, manager } = setup("owner");
    for (const body of [
      { target: "../etc", program: "koishi" },
      { target: "not-a-uuid", program: "koishi" },
      { target: id, program: "sh" },
      { target: id },
      { program: "koishi" },
    ])
      expect((await call(key, { body })).status, JSON.stringify(body)).toBe(400);
    expect(manager.restart).not.toHaveBeenCalled();
  });
  it("passes the manager's answer through, 202 for the owner's own bot", async () => {
    const { call, manager } = setup("owner");
    const done = await call(key, { body: { target: id, program: "napcat" } });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ instance: { target: id } });
    expect(manager.restart).toHaveBeenCalledWith(id, "napcat");
    manager.restart.mockResolvedValueOnce({ status: 202, accepted: true } as never);
    const own = await call(key, { body: { target: "owner", program: "koishi" } });
    expect(own.status).toBe(202);
    expect(own.body).toEqual({ accepted: true });
  });
  it("keeps 404 and 409, and hides other failures behind 502", async () => {
    const { call, manager } = setup("owner");
    for (const [from, to] of [
      [409, 409],
      [404, 404],
      [500, 502],
      [401, 502],
    ] as const) {
      manager.restart.mockRejectedValueOnce(new ManagerError("x", from));
      expect((await call(key, { body: { target: id, program: "koishi" } })).status).toBe(to);
    }
    manager.restart.mockRejectedValueOnce(new Error("ECONNREFUSED http://secret"));
    const failed = await call(key, { body: { target: id, program: "koishi" } });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain("secret");
  });
});

describe("friend QQ login relay", () => {
  it("registers only the napcat paths the owner's own QQ page uses", () => {
    const { routes } = setup("owner");
    const base = `${INSTANCE_NAPCAT_PREFIX}/:id/napcat`;
    expect([...routes.keys()].filter((key) => key.includes("/napcat/")).sort()).toEqual(
      [
        `GET ${base}/status`,
        `GET ${base}/qrcode`,
        `POST ${base}/logout`,
        `POST ${base}/qrcode/refresh`,
        `POST ${base}/login/password`,
        `POST ${base}/login/captcha`,
        `POST ${base}/login/device`,
        `POST ${base}/login/cancel`,
      ].sort(),
    );
  });
  it("is owner-only, same-origin for writes, and checks the uuid", async () => {
    const status = `GET ${INSTANCE_NAPCAT_PREFIX}/:id/napcat/status`;
    const logout = `POST ${INSTANCE_NAPCAT_PREFIX}/:id/napcat/logout`;
    expect((await setup("member").call(status, { params: { id } })).status).toBe(403);
    expect((await setup(undefined).call(status, { params: { id } })).status).toBe(401);
    const blocked = setup("owner", false);
    expect((await blocked.call(logout, { params: { id }, body: {} })).status).toBe(403);
    expect(blocked.manager.napcat).not.toHaveBeenCalled();
    const { call, manager } = setup("owner");
    for (const bad of ["owner", "../x", "00000000-0000-1000-8000-000000000001"]) expect((await call(status, { params: { id: bad } })).status).toBe(400);
    expect(manager.napcat).not.toHaveBeenCalled();
    expect((await call(status, { params: { id } })).body).toEqual({ available: true, loggedIn: true });
    expect(manager.napcat).toHaveBeenCalledWith(id, "GET", "status", undefined);
  });
  it("forwards the login body, and never turns a friend's auth failure into the owner's", async () => {
    const { call, manager } = setup("owner");
    const password = `POST ${INSTANCE_NAPCAT_PREFIX}/:id/napcat/login/password`;
    await call(password, { params: { id }, body: { uin: "12345", password: "x" } });
    expect(manager.napcat).toHaveBeenCalledWith(id, "POST", "login/password", { uin: "12345", password: "x" });
    manager.napcat.mockResolvedValueOnce({ status: 401, body: { message: "friend" } });
    expect((await call(`GET ${INSTANCE_NAPCAT_PREFIX}/:id/napcat/status`, { params: { id } })).status).toBe(502);
    manager.napcat.mockResolvedValueOnce({ status: 409, body: { errorCode: "runtime-unavailable" } });
    expect((await call(`GET ${INSTANCE_NAPCAT_PREFIX}/:id/napcat/status`, { params: { id } })).status).toBe(409);
    manager.napcat.mockRejectedValueOnce(new Error("boom"));
    expect((await call(`GET ${INSTANCE_NAPCAT_PREFIX}/:id/napcat/qrcode`, { params: { id } })).status).toBe(502);
  });
});

describe("TenantManagerClient ops", () => {
  const dir = mkdtempSync(join(tmpdir(), "manager-key-"));
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, "a".repeat(64));
  chmodSync(keyFile, 0o600);
  let answer: (url: unknown, init?: RequestInit) => Promise<Response> = async () => new Response("{}", { status: 500 });
  const client = new TenantManagerClient("http://manager.invalid:9000", keyFile, ((url: unknown, init?: RequestInit) => answer(url, init)) as never);
  const owner = {
    target: "owner",
    container: { name: "demo-owner", running: true, startedAt: "2026-11-19T01:00:00.000Z" },
    memory: { usedBytes: 600, limitBytes: 1200 },
    programs: { koishi: { state: "RUNNING", pid: 10, uptimeSeconds: 90 }, napcat: { state: "EVIL" } },
    release: { commit: "0123456789abcdef", deployId: "d1", deployedAt: "2026-11-19T01:00:00.000Z" },
    secret: "x",
  };

  it("reads the snapshot and keeps only known fields", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ instances: [owner, { target: id, container: { name: "c", running: false }, programs: {} }, { target: "x" }, null] })),
    );
    answer = fetcher;
    const result = await client.ops();
    expect(String(fetcher.mock.calls[0]![0])).toBe("http://manager.invalid:9000/v1/ops");
    expect(result.owner).toEqual({
      target: "owner",
      container: { name: "demo-owner", running: true, startedAt: "2026-11-19T01:00:00.000Z" },
      memory: { usedBytes: 600, limitBytes: 1200 },
      programs: { koishi: { state: "RUNNING", pid: 10, uptimeSeconds: 90 } },
      release: { commit: "0123456789abcdef", deployId: "d1", deployedAt: "2026-11-19T01:00:00.000Z" },
    });
    expect(Object.keys(result.accounts)).toEqual([id]);
    expect(sanitizeOps({ ...owner, release: { commit: "not hex!" } })?.release).toBeUndefined();
  });
  it("rejects a manager that answers badly", async () => {
    answer = async () => new Response("{}", { status: 500 });
    await expect(client.ops()).rejects.toThrow();
    answer = async () => new Response(JSON.stringify({ nope: 1 }));
    await expect(client.ops()).rejects.toThrow();
  });
  it("restarts through the manager: 200 with the instance, 202 for the owner's bot", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ instance: owner }), { status: 200 }));
    answer = fetcher;
    expect(await client.restart("owner", "napcat")).toMatchObject({ status: 200, instance: { target: "owner" } });
    expect(String(fetcher.mock.calls[0]![0])).toBe("http://manager.invalid:9000/v1/ops/owner/restart");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ program: "napcat" });
    answer = async () => new Response(JSON.stringify({ accepted: true }), { status: 202 });
    expect(await client.restart("owner", "koishi")).toEqual({ status: 202, accepted: true });
    answer = async () => new Response("{}", { status: 409 });
    await expect(client.restart(id, "koishi")).rejects.toMatchObject({ status: 409 });
    await expect(client.restart("../x", "koishi")).rejects.toThrow();
  });
  it("relays a friend's NapCat call under the napcat prefix", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ loggedIn: false }), { status: 200 }));
    answer = fetcher;
    expect(await client.napcat(id, "POST", "qrcode/refresh", {})).toEqual({ status: 200, body: { loggedIn: false } });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`http://manager.invalid:9000/v1/runtimes/${id}/http/yesimbot/napcat/qrcode/refresh`);
    await expect(client.napcat("owner", "GET", "status")).rejects.toThrow();
  });
});

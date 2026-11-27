import { scryptSync } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NapCatGateway } from "@yesimbot/onebot/napcat";
import { describe, expect, it, vi } from "vitest";

import { AdminAuth } from "../src/admin-auth.js";
import { installNapCatGateway } from "../src/napcat.js";

describe("NapCat owner routes", () => {
  it("requires owner access on each route and origin validation for writes", async () => {
    const routes: Record<string, Function> = {};
    const ctx = {
      baseDir: "/",
      server: {
        get: (path: string, cb: Function) => {
          routes[path] = cb;
        },
        post: (path: string, cb: Function) => {
          routes[path] = cb;
        },
      },
    };
    const auth = { requireOwner: vi.fn(() => false), sameOrigin: vi.fn(() => false) };
    installNapCatGateway(ctx as never, { enabled: true, endpoint: "http://127.0.0.1:6099", webuiConfigFile: "/missing" }, auth as never);
    expect(Object.keys(routes).sort()).toEqual([
      "/yesimbot/napcat/login/cancel",
      "/yesimbot/napcat/login/captcha",
      "/yesimbot/napcat/login/device",
      "/yesimbot/napcat/login/password",
      "/yesimbot/napcat/logout",
      "/yesimbot/napcat/qrcode",
      "/yesimbot/napcat/qrcode/refresh",
      "/yesimbot/napcat/status",
    ]);
    for (const route of Object.values(routes)) await route({});
    expect(auth.requireOwner).toHaveBeenCalledTimes(8);
    auth.requireOwner.mockReturnValue(true);
    const writes = Object.keys(routes).filter((path) => path !== "/yesimbot/napcat/status" && path !== "/yesimbot/napcat/qrcode");
    expect(writes).toHaveLength(6);
    for (const path of writes) {
      const http = { status: 200 };
      await routes[path](http);
      expect(http.status).toBe(403);
    }
  });

  it("validates login requests before calling NapCat and maps an unreachable NapCat to a safe 502", async () => {
    const routes: Record<string, Function> = {};
    const ctx = {
      baseDir: "/",
      server: {
        get() {},
        post: (path: string, cb: Function) => {
          routes[path] = cb;
        },
      },
    };
    const auth = { requireOwner: vi.fn(() => true), sameOrigin: vi.fn(() => true) };
    installNapCatGateway(ctx as never, { enabled: true, endpoint: "http://127.0.0.1:6099", webuiConfigFile: "/missing" }, auth as never);
    const login = vi.spyOn(NapCatGateway.prototype, "passwordLogin").mockResolvedValue({ step: "submitted" });
    const post = async (path: string, body: unknown, type = "application/json") => {
      const http = { status: 200, body: undefined as unknown, request: { body }, get: (name: string) => (name === "content-type" ? type : ""), set() {} };
      await routes[`/yesimbot/napcat/login/${path}`](http);
      return http;
    };
    try {
      for (const body of [
        { uin: "1234", password: "pw" },
        { uin: "012345", password: "pw" },
        { uin: "12345", password: "" },
        { uin: 12345, password: "pw" },
        [],
      ])
        expect((await post("password", body)).status).toBe(400);
      expect((await post("password", { uin: "12345", password: "x".repeat(129) })).status).toBe(400);
      expect((await post("password", { uin: "12345", password: "pw" }, "text/plain")).status).toBe(400);
      expect((await post("captcha", { ticket: "", randstr: "r" })).status).toBe(400);
      expect((await post("device", { renew: "yes" })).status).toBe(400);
      expect(login).not.toHaveBeenCalled();
      expect(await post("password", { uin: "12345", password: "pw" })).toMatchObject({ status: 200, body: { step: "submitted" } });
      expect(login).toHaveBeenCalledWith("12345", "pw");
      login.mockRejectedValueOnce(new Error("private-token"));
      const failed = await post("password", { uin: "12345", password: "pw" });
      expect(failed.status).toBe(502);
      expect(JSON.stringify(failed.body)).not.toContain("private-token");
    } finally {
      login.mockRestore();
    }
  });
});

it("protects HTTP logout with current owner cookies and exact Origin, and maps upstream failure to safe502", async () => {
  const dir = await mkdtemp(join(tmpdir(), "napcat-http-"));
  const credential = join(dir, "admin.json");
  const salt = Buffer.alloc(16, 7);
  await writeFile(
    credential,
    JSON.stringify({ version: 1, username: "owner", salt: salt.toString("base64"), hash: scryptSync("correct", salt, 64).toString("base64") }),
  );
  let now = 0;
  const auth = new AdminAuth({ enabled: true, credentialFile: credential, sessionHours: 1 }, credential, { now: () => now, timeZone: "Asia/Shanghai" });
  const routes: Record<string, Function> = {};
  installNapCatGateway(
    {
      baseDir: dir,
      server: {
        get() {},
        post: (path: string, callback: Function) => {
          routes[path] = callback;
        },
      },
    } as never,
    { enabled: true, endpoint: "http://127.0.0.1:6099", webuiConfigFile: "/missing" },
    auth,
  );
  const logout = vi.spyOn(NapCatGateway.prototype, "logout").mockResolvedValue({ accepted: true, message: "Requested" });
  const server = createServer(async (request, response) => {
    const http = {
      status: 200,
      body: {} as unknown,
      origin: `http://${request.headers.host}`,
      get: (key: string) => request.headers[key] || "",
      set: (key: string, value: string) => response.setHeader(key, value),
    };
    if (request.method === "POST" && routes[request.url!]) await routes[request.url!](http);
    else http.status = 404;
    response.writeHead(http.status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(http.body));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/yesimbot/napcat/logout`;
    const cookie = `yesimbot_admin=${await auth.login(undefined, "correct")}`;
    const post = (headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers });
    expect((await post({ Origin: origin })).status).toBe(401);
    expect((await post({ Cookie: "yesimbot_admin=wrong", Origin: origin })).status).toBe(401);
    expect((await post({ Cookie: cookie })).status).toBe(403);
    expect((await post({ Cookie: cookie, Origin: "http://evil.example" })).status).toBe(403);
    expect(logout).not.toHaveBeenCalled();
    const accepted = await post({ Cookie: cookie, Origin: origin });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(await accepted.json()).toMatchObject({ accepted: true });
    logout.mockRejectedValueOnce(new Error("private-token upstream-raw-error"));
    const failed = await post({ Cookie: cookie, Origin: origin });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toMatch(/private-token|upstream-raw-error/);
    now = 3600_000;
    expect((await post({ Cookie: cookie, Origin: origin })).status).toBe(401);
    expect((await fetch(url, { headers: { Cookie: cookie } })).status).toBe(404);
  } finally {
    logout.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

import { scryptSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { AdminAuth, installAdminAuth, readAdminLoginBody } from "../src/admin-auth.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "yesimbot-auth-"));
  dirs.push(dir);
  const path = join(dir, "admin.json");
  const salt = Buffer.alloc(16, 7);
  await writeFile(
    path,
    JSON.stringify({ version: 1, username: "owner", salt: salt.toString("base64"), hash: scryptSync("correct", salt, 64).toString("base64") }),
  );
  return { dir, path, config: { enabled: true, credentialFile: path, sessionHours: 1 } };
}
describe("single administrator sessions", () => {
  it("fails closed for missing/invalid credentials and wrong/empty passwords", async () => {
    const { path, config } = await fixture();
    const auth = new AdminAuth(config, path);
    expect(await auth.login(undefined, "")).toBeUndefined();
    expect(await auth.login(undefined, "wrong")).toBeUndefined();
    expect(await auth.login("other", "correct")).toBeUndefined();
    await rm(path);
    expect(await auth.login(undefined, "correct")).toBeUndefined();
  });
  it("expires sessions and revokes only the logged-out cookie", async () => {
    const { path, config } = await fixture();
    let now = 0;
    const auth = new AdminAuth(config, path, { now: () => now, timeZone: "Asia/Shanghai" });
    const first = await auth.login(undefined, "correct");
    const second = await auth.login("owner", "correct");
    expect(auth.sessionFromCookie(`yesimbot_admin=${first}`)?.username).toBe("owner");
    auth.logout(`yesimbot_admin=${first}`);
    expect(auth.sessionFromCookie(`yesimbot_admin=${first}`)).toBeUndefined();
    expect(auth.sessionFromCookie(`yesimbot_admin=${second}`)).toBeDefined();
    now = 3600_000;
    expect(auth.sessionFromCookie(`yesimbot_admin=${second}`)).toBeUndefined();
  });
  it("rejects absent/cross-site origins", async () => {
    const { path, config } = await fixture();
    const auth = new AdminAuth(config, path);
    const http = (origin: string, site = "same-origin") => ({ origin: "https://bot.example", get: (key: string) => (key === "origin" ? origin : site) });
    expect(auth.sameOrigin(http("") as never)).toBe(false);
    expect(auth.sameOrigin(http("https://evil.example") as never)).toBe(false);
    expect(auth.sameOrigin(http("https://bot.example", "cross-site") as never)).toBe(false);
    expect(auth.sameOrigin(http("https://bot.example") as never)).toBe(true);
  });
});

describe("login HTTP JSON bodies", () => {
  const request = (chunks: string[], contentType = "application/json", length = "") => ({
    get: (key: string) => (key === "content-type" ? contentType : length),
    request: {},
    req: Readable.from(chunks),
  });
  it("reads split raw HTTP request chunks and accepts pre-parsed JSON", async () => {
    expect(await readAdminLoginBody(request(['{"password":', '"correct"}']) as never)).toEqual({ password: "correct" });
    expect(await readAdminLoginBody({ ...request([]), request: { body: { password: "correct" } } } as never)).toEqual({ password: "correct" });
  });
  it("rejects oversized chunked/declared and malformed/non-object/non-JSON bodies", async () => {
    for (const http of [
      request(["x".repeat(8193)]),
      request([], "application/json", "8193"),
      request(["{"]),
      request(["[]"]),
      request(['{"password":"correct"}'], "text/plain"),
    ]) {
      await expect(readAdminLoginBody(http as never)).rejects.toThrow();
    }
  });
  it("logs in through the registered handler using a raw stream", async () => {
    const { dir, config } = await fixture();
    const routes: Record<string, Function> = {};
    const ctx = {
      baseDir: dir,
      on() {},
      console: { clients: {} },
      server: {
        get() {},
        post: (path: string, fn: Function) => {
          routes[path] = fn;
        },
      },
    };
    installAdminAuth(ctx as never, config);
    const headers: Record<string, string> = {};
    const http = {
      ...request(['{"username":"owner","password":"correct"}']),
      origin: "https://bot.example",
      secure: true,
      set: (key: string, value: string) => {
        headers[key] = value;
      },
      body: undefined as unknown,
      get: (key: string) => ({ origin: "https://bot.example", "content-type": "application/json" })[key] ?? "",
    };
    await routes["/yesimbot/admin/login"](http);
    expect(http.body).toMatchObject({ authenticated: true, username: "owner" });
    expect(headers["Set-Cookie"]).toContain("HttpOnly; SameSite=Strict");
    expect(headers["Set-Cookie"]).toContain("; Secure");
  });
});

it("requires the explicitly configured public origin behind HTTPS proxies without trusting forwarded headers", async () => {
  const { path, config } = await fixture();
  const auth = new AdminAuth({ ...config, publicOrigin: "https://bot.example" }, path);
  const http = {
    origin: "http://bot.example",
    secure: false,
    get: (key: string) => ({ origin: "https://bot.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" })[key] ?? "",
  };
  expect(auth.sameOrigin(http as never)).toBe(true);
  expect(auth.secureCookie(http as never)).toBe(true);
  const insecure = { ...http, get: (key: string) => (key === "origin" ? "http://bot.example" : "") };
  expect(auth.sameOrigin(insecure as never)).toBe(false);
  const defaults = new AdminAuth(config, path);
  expect(defaults.sameOrigin(http as never)).toBe(false);
  expect(() => new AdminAuth({ ...config, publicOrigin: "https://bot.example/path" }, path)).toThrow();
  expect(() => new AdminAuth({ ...config, publicOrigin: "https://secret@bot.example" }, path)).toThrow();
});

it("keeps ten password attempts per minute and exposes the remaining bounded wait", async () => {
  const { path, config } = await fixture();
  let now = 1000;
  const auth = new AdminAuth(config, path, { now: () => now, timeZone: "Asia/Shanghai" });
  for (let attempt = 0; attempt < 10; attempt++) {
    expect(auth.retryAfterSeconds()).toBe(0);
    expect(await auth.login(undefined, "wrong")).toBeUndefined();
  }
  expect(auth.retryAfterSeconds()).toBe(60);
  expect(await auth.login(undefined, "correct")).toBeUndefined();
  now += 59_001;
  expect(auth.retryAfterSeconds()).toBe(1);
  now += 999;
  expect(auth.retryAfterSeconds()).toBe(0);
  expect(await auth.login(undefined, "correct")).toBeDefined();
  expect(auth.retryAfterSeconds()).toBe(0);
});

it("returns distinct HTTP credential/rate/origin errors and retains valid sessions while limited", async () => {
  const { dir, config } = await fixture();
  const routes: Record<string, Function> = {};
  const auth = installAdminAuth(
    {
      baseDir: dir,
      on() {},
      console: { clients: {} },
      server: {
        get() {},
        post: (path: string, handler: Function) => {
          routes[path] = handler;
        },
      },
    } as never,
    { ...config, publicOrigin: "https://bot.example", additionalOrigins: ["http://192.0.2.10:15141"] },
  );
  const existing = await auth.login(undefined, "correct");
  const request = (password: string, origin = "https://bot.example") => {
    const headers: Record<string, string> = {};
    return {
      origin: "https://bot.example",
      secure: true,
      status: 200,
      body: undefined as unknown,
      request: { body: { password } },
      get: (name: string) => ({ origin, "content-type": "application/json" })[name] ?? "",
      set: (name: string, value: string) => {
        headers[name] = value;
      },
      headers,
    };
  };
  const rejected = request("correct", "https://evil.example");
  await routes["/yesimbot/admin/login"](rejected);
  expect(rejected.status).toBe(403);
  for (let attempt = 0; attempt < 10; attempt++) {
    const http = request("wrong", attempt % 2 ? "http://192.0.2.10:15141" : "https://bot.example");
    await routes["/yesimbot/admin/login"](http);
    expect(http.status).toBe(401);
    expect(http.body).toEqual({ message: "Invalid administrator credentials." });
    expect(http.headers["Retry-After"]).toBeUndefined();
  }
  const limited = request("correct", "http://192.0.2.10:15141");
  await routes["/yesimbot/admin/login"](limited);
  expect(limited.status).toBe(429);
  expect(Number(limited.headers["Retry-After"])).toBeGreaterThan(0);
  expect(Number(limited.headers["Retry-After"])).toBeLessThanOrEqual(60);
  expect(limited.body).toEqual({ message: "Login temporarily limited. Try again later.", retryAfterSeconds: Number(limited.headers["Retry-After"]) });
  expect(limited.headers["Set-Cookie"]).toBeUndefined();
  expect(limited.headers["Cache-Control"]).toBe("no-store");
  expect(auth.sessionFromCookie(`yesimbot_admin=${existing}`)?.username).toBe("owner");
});

describe("explicit administrator origin aliases", () => {
  const publicOrigin = "https://bot.example";
  const lanOrigin = "http://192.0.2.10:15141";
  it("matches only configured exact origins and uses their scheme rather than transport or forwarded headers", async () => {
    const { path, config } = await fixture();
    const auth = new AdminAuth({ ...config, publicOrigin, additionalOrigins: [lanOrigin] }, path);
    const request = (origin: string, secure = false, site = "same-origin") => ({
      origin: "http://internal:5140",
      secure,
      get: (name: string) => ({ origin, "sec-fetch-site": site, "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" })[name] ?? "",
    });
    expect(auth.sameOrigin(request(publicOrigin) as never)).toBe(true);
    expect(auth.secureCookie(request(publicOrigin) as never)).toBe(true);
    expect(auth.sameOrigin(request(lanOrigin, true) as never)).toBe(true);
    expect(auth.secureCookie(request(lanOrigin, true) as never)).toBe(false);
    for (const origin of [
      "",
      "null",
      "https://evil.example",
      "http://bot.example",
      "https://192.0.2.10:15141",
      "http://192.0.2.10:15142",
      `${lanOrigin}/`,
      `${publicOrigin}.evil.example`,
      "http://internal:5140",
    ]) {
      expect(auth.sameOrigin(request(origin) as never)).toBe(false);
    }
    expect(auth.sameOrigin(request(lanOrigin, false, "cross-site") as never)).toBe(false);
    const defaults = new AdminAuth(config, path);
    expect(defaults.sameOrigin(request(lanOrigin) as never)).toBe(false);
    expect(defaults.secureCookie(request(lanOrigin, true) as never)).toBe(true);
    const legacy = new AdminAuth({ ...config, publicOrigin }, path);
    expect(legacy.sameOrigin(request(lanOrigin) as never)).toBe(false);
    expect(legacy.secureCookie(request(lanOrigin) as never)).toBe(true);
  });
  it("rejects invalid alias configuration with the same origin validation as publicOrigin", async () => {
    const { path, config } = await fixture();
    for (const origin of [
      "",
      "*",
      "null",
      "ftp://bot.example",
      "https://*.example",
      "https://%2a.example",
      "https://@bot.example",
      "https://bot.example?",
      "https://bot.example#",
      "https://bot.example/path/..",
      " https://bot.example",
      "https://bot.example\\",
      "https://user:secret@bot.example",
      "https://bot.example/path",
      "https://bot.example?query",
      "https://bot.example#fragment",
    ]) {
      expect(() => new AdminAuth({ ...config, publicOrigin, additionalOrigins: [origin] }, path)).toThrow();
      if (origin) expect(() => new AdminAuth({ ...config, publicOrigin: origin }, path)).toThrow();
    }
    expect(() => new AdminAuth({ ...config, additionalOrigins: [lanOrigin] }, path)).toThrow();
  });
  it("sets and clears Strict host-only cookies correctly on both allowed login/logout routes", async () => {
    const { dir, config } = await fixture();
    const routes: Record<string, Function> = {};
    const auth = installAdminAuth(
      {
        baseDir: dir,
        on() {},
        console: { clients: {} },
        server: {
          get() {},
          post: (path: string, handler: Function) => {
            routes[path] = handler;
          },
        },
      } as never,
      { ...config, publicOrigin, additionalOrigins: [lanOrigin] },
    );
    const request = (origin: string, cookie = "") => {
      const headers: Record<string, string> = {};
      return {
        origin: "http://internal:5140",
        secure: false,
        status: 200,
        body: undefined as unknown,
        request: { body: { username: "owner", password: "correct" } },
        headers,
        get: (name: string) => ({ origin, cookie, "content-type": "application/json" })[name] ?? "",
        set: (name: string, value: string) => {
          headers[name] = value;
        },
      };
    };
    for (const origin of [publicOrigin, lanOrigin]) {
      const login = request(origin);
      await routes["/yesimbot/admin/login"](login);
      expect(login.body).toMatchObject({ authenticated: true, username: "owner" });
      const cookie = login.headers["Set-Cookie"];
      expect(cookie).toContain("; Path=/; HttpOnly; SameSite=Strict; Max-Age=");
      expect(cookie.includes("; Secure")).toBe(origin === publicOrigin);
      expect(cookie).not.toContain("Domain=");
      expect(auth.requireOwner({ ...request(origin, cookie) } as never)).toBe(true);
      for (const invalid of ["", "https://evil.example"]) {
        for (const route of ["/yesimbot/admin/login", "/yesimbot/admin/logout"]) {
          const rejected = request(invalid, cookie);
          await routes[route](rejected);
          expect(rejected.status).toBe(403);
          expect(rejected.headers["Set-Cookie"]).toBeUndefined();
          expect(auth.sessionFromCookie(cookie)).toBeDefined();
        }
      }
      const logout = request(origin, cookie);
      await routes["/yesimbot/admin/logout"](logout);
      expect(logout.body).toEqual({ enabled: true, authenticated: false });
      expect(logout.headers["Set-Cookie"]).toContain("SameSite=Strict; Max-Age=0");
      expect(logout.headers["Set-Cookie"].includes("; Secure")).toBe(origin === publicOrigin);
      expect(auth.sessionFromCookie(cookie)).toBeUndefined();
      const denied = request(origin, cookie);
      expect(auth.requireOwner(denied as never)).toBe(false);
      expect(denied.status).toBe(401);
    }
  });
});

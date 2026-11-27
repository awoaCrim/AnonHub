import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { XIAOHEIHE_PATH, type XiaoheiheConnection } from "../src/shared/xiaoheihe.js";
import { installXiaoheihe } from "../src/webui/xiaoheihe.js";
import { createXiaoheiheConnection } from "../web/src/state/xiaoheihe-connection";

type Http = {
  headers: Record<string, string>;
  status: number;
  body?: Record<string, unknown>;
  set(name: string, value: string): void;
  get(name: string): string;
  request: { body?: unknown };
};

const connected = {
  selfId: "1234",
  state: "connected" as const,
  paused: null,
  quarantinedPosts: 0,
  newPostQuarantined: false,
  postsRemaining: 1,
  interactionsRemaining: 10,
  login: { state: "idle" as const },
};

function server(
  service?: { status(): typeof connected; startWebLogin(): Promise<void> },
  session: { role: string } | null = { role: "owner" },
  sameOrigin = true,
) {
  const routes = new Map<string, (http: Http) => Promise<void> | void>();
  const ctx = {
    get: (name: string) => (name === "yesimbotXiaoheihe" ? service : undefined),
    server: {
      get: (path: string, handler: (http: Http) => void) => routes.set(`GET ${path}`, handler),
      post: (path: string, handler: (http: Http) => Promise<void>) => routes.set(`POST ${path}`, handler),
    },
  };
  installXiaoheihe(ctx as never, { sessionFromCookie: () => session ?? undefined, sameOrigin: () => sameOrigin } as never);
  const call = async (route: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    const http: Http = {
      headers,
      status: 200,
      set: (name, value) => {
        headers[name] = value;
      },
      get: (name) => (name === "content-type" ? "application/json" : ""),
      request: { body },
    };
    await routes.get(route)!(http);
    return http;
  };
  return { call, routes };
}

it("reports the configured account and login state to the owner, and 未启用 when the extension is not running", async () => {
  const running = server({ status: () => connected, startWebLogin: vi.fn() });
  const http = await running.call(`GET ${XIAOHEIHE_PATH}`);
  expect(http.body).toEqual({ available: true, ...connected });
  expect(http.headers["Cache-Control"]).toBe("private, no-store");
  expect((await server().call(`GET ${XIAOHEIHE_PATH}`)).body).toEqual({ available: false });
});

it("starts the QR login only for the owner, from the same origin, and with an empty body", async () => {
  const start = vi.fn(async () => {});
  const owner = server({ status: () => ({ ...connected, state: "login_required" as const, login: { state: "pending" as const } }), startWebLogin: start });
  const http = await owner.call(`POST ${XIAOHEIHE_PATH}/login`, {});
  expect(start).toHaveBeenCalledOnce();
  expect(http.body).toMatchObject({ available: true, state: "login_required", login: { state: "pending" } });
  expect((await owner.call(`POST ${XIAOHEIHE_PATH}/login`, { selfId: "x" })).status).toBe(400);
  expect(start).toHaveBeenCalledOnce();

  const member = await server({ status: () => connected, startWebLogin: start }, { role: "member" }).call(`POST ${XIAOHEIHE_PATH}/login`, {});
  expect([member.status, member.body]).toEqual([403, { message: "owner_required" }]);
  const anonymous = await server({ status: () => connected, startWebLogin: start }, null).call(`GET ${XIAOHEIHE_PATH}`);
  expect([anonymous.status, anonymous.body]).toEqual([401, { message: "login_required" }]);
  const crossSite = await server({ status: () => connected, startWebLogin: start }, { role: "owner" }, false).call(`POST ${XIAOHEIHE_PATH}/login`, {});
  expect([crossSite.status, crossSite.body]).toEqual([403, { message: "same_origin_required" }]);
  const unavailable = await server().call(`POST ${XIAOHEIHE_PATH}/login`, {});
  expect([unavailable.status, unavailable.body]).toEqual([409, { message: "xiaoheihe_unavailable" }]);
  expect(start).toHaveBeenCalledOnce();
});

it("never puts cookies or post content in what it returns", async () => {
  const http = await server({ status: () => connected, startWebLogin: vi.fn() }).call(`GET ${XIAOHEIHE_PATH}`);
  expect(JSON.stringify(http.body)).not.toMatch(/cookie|pkey|session/i);
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("polls the card only while a scan is pending, and updates the data in place", async () => {
  const states: XiaoheiheConnection[] = [
    { available: true, ...connected, state: "login_required", login: { state: "pending", image: "data:image/png;base64,AA" } },
    { available: true, ...connected, state: "login_required", login: { state: "pending", image: "data:image/png;base64,AA" } },
    { available: true, ...connected, login: { state: "finished", message: "小黑盒登录成功" } },
  ];
  const request = vi.fn(async () => states.shift()!);
  const control = createXiaoheiheConnection({ request: request as never, interval: 1000 });
  await control.load();
  expect(control.state.connection).toMatchObject({ login: { state: "pending" } });
  const first = control.state.connection;
  await vi.advanceTimersByTimeAsync(1000);
  expect(control.state.connection).not.toBe(first);
  expect(control.state.connection).toMatchObject({ login: { state: "pending" } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(control.state.connection).toMatchObject({ state: "connected", login: { state: "finished" } });
  const calls = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls.length).toBe(calls);
  control.dispose();
});

it("starts a login through the owner's endpoint and says so in plain Chinese when the extension is off", async () => {
  const request = vi.fn(async (path: string) => {
    if (path.endsWith("/login")) return { available: true, ...connected, state: "login_required", login: { state: "pending" } };
    return { available: true, ...connected, state: "login_required", login: { state: "pending", image: "data:image/png;base64,AA" } };
  });
  const control = createXiaoheiheConnection({ request: request as never, interval: 1000 });
  await control.login();
  expect(request).toHaveBeenCalledWith(`${XIAOHEIHE_PATH}/login`, {}, expect.anything());
  await vi.advanceTimersByTimeAsync(1000);
  expect(control.state.connection).toMatchObject({ login: { image: "data:image/png;base64,AA" } });
  control.dispose();
  const { ApiError } = await import("../web/src/lib/api");
  const off = createXiaoheiheConnection({ request: (async () => Promise.reject(new ApiError(409, "xiaoheihe_unavailable"))) as never });
  await off.login();
  expect(off.state.error).toContain("能力");
  off.dispose();
});

import { AppError } from "@yesimbot/foundation";
import { afterEach, expect, it, vi } from "vitest";

import type { InstalledPackage } from "../src/host.js";
import { installExtensions } from "../src/webui/extensions.js";

// User, 2026-11-26: 「允许用户自己给自己的实例安装拓展，目前莫名其妙的绑定了koishi的拓展市场」.

interface Http {
  status: number;
  body: unknown;
  input?: unknown;
  set(): void;
  get(name: string): string;
}

vi.mock("../src/admin-auth.js", () => ({ readAdminLoginBody: async (http: { input: unknown }) => http.input }));
afterEach(() => vi.restoreAllMocks());

function harness(list: InstalledPackage[] = []) {
  const routes = new Map<string, (http: Http) => Promise<void> | void>();
  const extensions = { list: vi.fn(() => list), install: vi.fn((name: unknown) => ({ name: String(name) })), remove: vi.fn(async () => {}) };
  const session = { role: "owner" };
  const auth = { sessionFromCookie: vi.fn(() => session), sameOrigin: vi.fn(() => true) };
  const ctx = {
    extensions,
    server: {
      get: (path: string, handler: (http: Http) => void) => routes.set(`get ${path}`, handler),
      post: (path: string, handler: (http: Http) => Promise<void>) => routes.set(`post ${path}`, handler),
    },
  };
  installExtensions(ctx as never, auth as never);
  const call = async (method: "get" | "post", input?: unknown) => {
    const http: Http = { status: 200, body: undefined, input, set() {}, get: () => "cookie" };
    await routes.get(`${method} /yesimbot/api/v1/extensions`)!(http);
    return http;
  };
  return { extensions, call };
}

it("lists each install with one status: installing, failed to install or load, or how its module runs", async () => {
  const { call } = harness([
    { name: "a", installing: true },
    { name: "b", error: "extension_not_extension" },
    { name: "c", version: "1.0.0", module: "c", state: { state: "running" } },
    { name: "d", version: "2.0.0", module: "d", state: { state: "failed", error: { code: "config_invalid" } } },
    { name: "e", version: "1.0.0", module: "e", state: { state: "disabled" } },
  ]);
  expect((await call("get")).body).toEqual({
    items: [
      { name: "a", status: "installing" },
      { name: "b", status: "failed", error: "extension_not_extension" },
      { name: "c", version: "1.0.0", module: "c", status: "running" },
      { name: "d", version: "2.0.0", module: "d", status: "failed", error: "config_invalid" },
      { name: "e", version: "1.0.0", module: "e", status: "disabled" },
    ],
  });
});

it("starts an install with 202, removes one, and answers a refusal with its code", async () => {
  const { extensions, call } = harness();
  const started = await call("post", { action: "install", name: "yesimbot-extension-weather", version: "" });
  expect([started.status, started.body]).toEqual([202, { name: "yesimbot-extension-weather" }]);
  expect(extensions.install).toHaveBeenCalledWith("yesimbot-extension-weather", "");
  const removed = await call("post", { action: "remove", name: "yesimbot-extension-weather" });
  expect([removed.status, removed.body]).toEqual([200, { ok: true }]);
  extensions.install.mockImplementation(() => {
    throw new AppError("input_invalid", { effect: "none" });
  });
  const refused = await call("post", { action: "install", name: "Bad Name" });
  expect([refused.status, refused.body]).toEqual([400, { message: "input_invalid" }]);
  expect((await call("post", { action: "upgrade" })).body).toEqual({ message: "input_invalid" });
});

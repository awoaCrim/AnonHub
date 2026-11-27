import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import Koa from "koa";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import type { AdminAuth, AdminSession } from "../src/admin-auth";
import type { ConfigStore } from "../src/config/store";
import type { Host } from "../src/host.js";
import { GOOGLE_CALLBACK_PATH, GOOGLE_PATH } from "../src/shared/google";
import * as googleBoundary from "../src/shared/google";
import { installGoogle, sharedAppConfigured } from "../src/webui/google";
import { ApiError } from "../web/src/lib/api";
import { createGoogleConnections } from "../web/src/state/google-connections";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const off of cleanup.splice(0).reverse()) await off();
});
const snapshot = {
  available: true,
  configured: true,
  accounts: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "own@example.com", permissions: { gmail: "read" }, connectedAt: 1, needsReconnect: false }],
};
const state = "a".repeat(43);

async function fixture(callbackDocument?: string) {
  const sessions = new Map<string, AdminSession>([
    ["owner", { username: "owner", role: "owner", expiresAt: Date.now() + 60_000 }],
    ["member", { username: "member", role: "member", expiresAt: Date.now() + 60_000 }],
  ]);
  const auth = {
    sessionFromCookie: (cookie: string) => sessions.get(cookie),
    sameOrigin: (http: Koa.Context) => http.get("origin") === "https://bot.example" && http.get("sec-fetch-site") !== "cross-site",
  } as unknown as AdminAuth;
  const service = {
    snapshot: vi.fn(async () => snapshot),
    begin: vi.fn(async () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=x" })),
    finish: vi.fn(async (_binding: string, _input: unknown, valid: () => boolean) => {
      if (!valid()) throw new Error("invalid");
    }),
    disconnect: vi.fn(async () => ({ revoked: true })),
  };
  let permitted = true,
    enabled = true;
  const routes = new Map<string, (http: Koa.Context) => unknown>();
  installGoogle(
    {
      logger: () => ({ warn: vi.fn() }),
      server: {
        get: (path: string, handler: (http: Koa.Context) => unknown) => routes.set(`GET ${path}`, handler),
        post: (path: string, handler: (http: Koa.Context) => unknown) => routes.set(`POST ${path}`, handler),
      },
      get: () => (enabled ? service : undefined),
    } as unknown as Host,
    auth,
    { permitted: () => permitted } as unknown as ConfigStore,
    false,
    callbackDocument,
  );
  const app = new Koa();
  app.use(async (http, next) => routes.get(`${http.method} ${http.path}`)?.(http) ?? next());
  const server: Server = createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address() as { port: number };
  const request = (path: string, cookie = "owner", body?: unknown, origin: string | undefined = "https://bot.example", extra: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      redirect: "manual",
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return {
    request,
    service,
    sessions,
    permitted(value: boolean) {
      permitted = value;
    },
    enabled(value: boolean) {
      enabled = value;
    },
  };
}

it("guards connection reads and writes with runtime-owner auth, same origin and the plugin grant", async () => {
  const f = await fixture();
  expect((await f.request(GOOGLE_PATH, "")).status).toBe(401);
  expect((await f.request(GOOGLE_PATH, "member")).status).toBe(403);
  expect((await f.request(GOOGLE_PATH, "owner", undefined, "https://evil.example")).status).toBe(403);
  expect((await f.request(`${GOOGLE_PATH}/authorize`, "owner", { services: { gmail: "read" } }, "")).status).toBe(403);
  expect(f.service.begin).not.toHaveBeenCalled();
  expect(await (await f.request(GOOGLE_PATH)).json()).toEqual(snapshot);
  f.permitted(false);
  expect((await f.request(GOOGLE_PATH)).status).toBe(403);
  expect((await f.request(`${GOOGLE_PATH}/disconnect`, "owner", { id: snapshot.accounts[0].id })).status).toBe(403);
  expect(f.service.disconnect).not.toHaveBeenCalled();
});
it("validates requested grants and account IDs and binds login to the current session", async () => {
  const f = await fixture();
  for (const services of [{}, { gmail: "admin" }, { other: "manage" }])
    expect((await f.request(`${GOOGLE_PATH}/authorize`, "owner", { services })).status).toBe(400);
  expect((await f.request(`${GOOGLE_PATH}/authorize`, "owner", { services: { gmail: "read" }, tenantId: "foreign" })).status).toBe(400);
  expect((await f.request(`${GOOGLE_PATH}/authorize`, "owner", { services: { gmail: "read", drive: "manage" } })).status).toBe(200);
  expect(f.service.begin).toHaveBeenCalledWith("owner", { gmail: "read", drive: "manage" }, undefined);
  expect((await f.request(`${GOOGLE_PATH}/authorize`, "owner", { services: { gmail: "read" }, account: "../other" })).status).toBe(400);
  expect((await f.request(`${GOOGLE_PATH}/authorize`, "owner", { services: { gmail: "read" }, account: snapshot.accounts[0].id })).status).toBe(200);
  expect(f.service.begin).toHaveBeenLastCalledWith("owner", { gmail: "read" }, snapshot.accounts[0].id);
  expect((await f.request(`${GOOGLE_PATH}/disconnect`, "owner", { id: "foreign-path" })).status).toBe(400);
  f.enabled(false);
  // Not started yet: the owner is offered setup; connecting starts the plugin first.
  expect(await (await f.request(GOOGLE_PATH)).json()).toEqual({ available: true, configured: false, shared: false, accounts: [] });
});
it("accepts only a well-formed Google app from the owner", async () => {
  const f = await fixture();
  const app = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret", redirectUri: `https://bot.example${GOOGLE_CALLBACK_PATH}` };
  for (const body of [
    { ...app, clientId: "not-a-client" },
    { ...app, clientSecret: "short" },
    { ...app, redirectUri: "http://bot.example/elsewhere" },
    { ...app, extra: 1 },
  ])
    expect((await f.request(`${GOOGLE_PATH}/app`, "owner", body)).status).toBe(400);
  expect((await f.request(`${GOOGLE_PATH}/app`, "owner", app, "")).status).toBe(403);
  expect((await f.request(`${GOOGLE_PATH}/app`, "member", app)).status).toBe(403);
});
it("a friend's runtime takes the owner's app only when it is complete", () => {
  const dir = mkdtempSync(join(tmpdir(), "google-app-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "google.json");
  expect(sharedAppConfigured(file)).toBe(false);
  writeFileSync(file, JSON.stringify({ version: 1 }));
  expect(sharedAppConfigured(file)).toBe(false);
  writeFileSync(file, JSON.stringify({ version: 1, clientId: "a.apps.googleusercontent.com", clientSecret: "s", redirectUri: "https://x/cb" }));
  expect(sharedAppConfigured(file)).toBe(true);
});
it("serves a constant public OAuth landing page, then completes only by an authenticated same-origin POST", async () => {
  const f = await fixture();
  const result = await f.request(`${GOOGLE_CALLBACK_PATH}?state=${state}&code=private-code`, "", undefined, "", { "sec-fetch-site": "cross-site" });
  expect(result.status).toBe(200);
  const html = await result.text();
  expect(html).not.toContain("private-code");
  expect(html).toContain("history.replaceState");
  expect(result.headers.get("content-security-policy")).toContain("script-src 'sha256-");
  expect(result.headers.get("referrer-policy")).toBe("no-referrer");
  expect(f.service.finish).not.toHaveBeenCalled();
  expect(await (await f.request(`${GOOGLE_PATH}/complete`, "owner", { state, code: "private-code" })).json()).toEqual({ outcome: "connected" });
  expect(f.service.finish).toHaveBeenCalledWith("owner", { state, code: "private-code" }, expect.any(Function));
  expect((await f.request(`${GOOGLE_PATH}/complete`, "", { state, code: "x" })).status).toBe(401);
  expect((await f.request(`${GOOGLE_PATH}/complete`, "member", { state, code: "x" })).status).toBe(403);
  expect((await f.request(`${GOOGLE_PATH}/complete`, "owner", { state, code: "x" }, "https://evil.example")).status).toBe(403);
  expect(await (await f.request(`${GOOGLE_PATH}/complete`, "owner", { state: [state, state], code: "x" })).json()).toEqual({ outcome: "expired" });
});
it("uses the shared callback document without reflecting OAuth secrets or relaxing script CSP", async () => {
  const f = await fixture(
    '<!doctype html><html><head><link rel="stylesheet" href="/assets/theme-test.css"></head><body><main data-slot="card">Connecting</main><!-- OAUTH_CALLBACK_SCRIPT --></body></html>',
  );
  const result = await f.request(`${GOOGLE_CALLBACK_PATH}?state=${state}&code=private-code`, "", undefined, "", { "sec-fetch-site": "cross-site" });
  const html = await result.text();
  expect(html).toContain('data-slot="card"');
  expect(html).toContain("/assets/theme-test.css");
  expect(html).toContain("history.replaceState");
  expect(html).not.toContain("private-code");
  expect(html).not.toContain("OAUTH_CALLBACK_SCRIPT");
  const csp = result.headers.get("content-security-policy")!;
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("script-src 'sha256-");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("script-src 'self'");
});

it("rechecks session revocation after asynchronous OAuth work", async () => {
  const f = await fixture();
  f.service.finish.mockImplementationOnce(async () => {
    f.sessions.delete("owner");
  });
  const result = await f.request(`${GOOGLE_PATH}/complete`, "owner", { state, code: "code" });
  expect(result.status).toBe(401);
  expect(result.headers.has("location")).toBe(false);
});

it("loads connection state and connects through Google's exact OAuth endpoint", async () => {
  const navigate = vi.fn();
  const request = vi.fn(async (path: string) =>
    path.endsWith("/authorize") ? { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=a" } : snapshot,
  );
  const control = createGoogleConnections({ request: request as never, navigate });
  await control.load();
  expect(control.state.snapshot).toEqual(snapshot);
  await control.connect({ gmail: "read" });
  expect(navigate).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=a");
  expect(request.mock.calls[1].slice(0, 2)).toEqual([`${GOOGLE_PATH}/authorize`, { services: { gmail: "read" } }]);
  control.dispose();
});
it("does not navigate to an injected host or after the page is disposed", async () => {
  const navigate = vi.fn();
  const invalid = createGoogleConnections({
    request: vi.fn(async () => ({ authorizationUrl: "https://accounts.google.com.evil.example/o/oauth2/v2/auth" })) as never,
    navigate,
  });
  await invalid.connect({ drive: "manage" });
  expect(navigate).not.toHaveBeenCalled();
  expect(invalid.state.error).toBeTruthy();
  let done!: (value: unknown) => void;
  const late = createGoogleConnections({
    request: (() =>
      new Promise((resolve) => {
        done = resolve;
      })) as never,
    navigate,
  });
  const connecting = late.connect({ gmail: "read" });
  late.dispose();
  done({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" });
  await connecting;
  expect(navigate).not.toHaveBeenCalled();
});
it("keeps the latest snapshot and reports missing grants without exposing server errors", async () => {
  const waiting: Array<(value: unknown) => void> = [];
  const control = createGoogleConnections({ request: (() => new Promise((resolve) => waiting.push(resolve))) as never });
  const old = control.load(),
    current = control.load();
  waiting[1](snapshot);
  await current;
  waiting[0]({ available: false, configured: false, accounts: [] });
  await old;
  expect(control.state.snapshot).toEqual(snapshot);
  control.dispose();
  const missing = createGoogleConnections({
    request: vi.fn(async () => {
      throw new ApiError(403, "not_permitted");
    }) as never,
  });
  await missing.load();
  expect(missing.state.error).toContain("管理员");
  missing.dispose();
});
it("refreshes after disconnect, preserving whether Google confirmed revocation", async () => {
  const request = vi.fn(async (path: string) => (path.endsWith("/disconnect") ? { revoked: false } : { ...snapshot, accounts: [] }));
  const control = createGoogleConnections({ request: request as never });
  expect(await control.disconnect(snapshot.accounts[0].id)).toEqual({ revoked: false });
  expect(control.state.snapshot?.accounts).toEqual([]);
  control.dispose();
});
it("compiles the connections component script and template", () => {
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/GoogleConnection.vue", import.meta.url), "utf8"));
  expect(() => compileScript(descriptor, { id: "connections" })).not.toThrow();
  expect(compileTemplate({ source: descriptor.template!.content, filename: "GoogleConnection.vue", id: "connections" }).errors).toEqual([]);
});

async function connectionsPage(tenant: boolean, shared = snapshot as unknown) {
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/GoogleConnection.vue", import.meta.url), "utf8"));
  const code = ts.transpileModule(compileScript(descriptor, { id: "connections-setup" }).content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const request = vi.fn(async (path: string) =>
    path.endsWith("/authorize") ? { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=a" } : shared,
  );
  const navigate = vi.fn(),
    confirmDiscard = vi.fn(async () => true),
    mounted: Array<() => Promise<void>> = [],
    unmounted: Array<() => void> = [];
  type SetupView = {
    callback: vue.ComputedRef<string>;
    owner: vue.ComputedRef<boolean>;
    headline: vue.ComputedRef<string>;
    setupOpen: vue.Ref<boolean>;
    setupDirty: vue.ComputedRef<boolean>;
    app: { clientId: string; clientSecret: string };
    state: { busy: string };
    openSetup(): void;
    setSetupOpen(open: boolean): void;
    connect(account?: googleBoundary.GoogleAccountView): Promise<void>;
  };
  const module = { exports: {} as { default: { setup: (props: object, context: object) => SetupView } } };
  const imports: Record<string, unknown> = {
    vue: { ...vue, onMounted: (fn: () => Promise<void>) => mounted.push(fn), onBeforeUnmount: (fn: () => void) => unmounted.push(fn) },
    "vue-router": { useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) },
    "../../../src/shared/google": googleBoundary,
    "../context": { useSession: () => ({ state: { features: { tenant } } }) },
    "../lib/dialog": { confirmDialog: async () => true, confirmDiscard },
    "../lib/editor-guard": { editorRegistry: { leave: async () => true }, trackEditor: () => {} },
    "../lib/toast": { toast: vi.fn(), toastErrors: () => {} },
    "../state/google-connections": { createGoogleConnections: () => createGoogleConnections({ request: request as never, navigate }) },
  };
  runInNewContext(code, {
    module,
    exports: module.exports,
    location: { origin: "https://bot.example" },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    setTimeout,
    clearTimeout,
    URL,
    require: (name: string) => imports[name] ?? { default: {} },
  });
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} }))!;
  cleanup.push(() => {
    unmounted.forEach((fn) => fn());
    scope.stop();
  });
  await mounted[0]();
  return { view, request, navigate, confirmDiscard };
}
it("connecting asks Google for everything at once, and renewing opens Google on that account", async () => {
  const { view, request, navigate } = await connectionsPage(false);
  expect(view.callback.value).toBe(`https://bot.example${GOOGLE_CALLBACK_PATH}`);
  const full = { gmail: "manage", calendar: "manage", drive: "manage" };
  await view.connect();
  expect((request.mock.calls.find(([path]) => path.endsWith("/authorize")) as unknown[])[1]).toEqual({ services: full });
  expect(navigate).toHaveBeenCalledTimes(1);
  await view.connect(snapshot.accounts[0] as googleBoundary.GoogleAccountView);
  expect((request.mock.calls.filter(([path]) => path.endsWith("/authorize")).at(-1) as unknown[])[1]).toEqual({
    services: full,
    account: snapshot.accounts[0].id,
  });
});
it("only the owner is offered the Google app setup", async () => {
  const unset = { available: true, configured: false, accounts: [] };
  const owner = await connectionsPage(false, unset);
  expect(owner.view.owner.value).toBe(true);
  expect(owner.view.headline.value).toContain("设置一次");
  const friend = await connectionsPage(true, { ...unset, shared: true });
  expect(friend.view.owner.value).toBe(false);
  expect(friend.view.headline.value).toBe("主人还没设置好 Google，暂时不能连接。");
});
it("drops Google app edits on dismissal without asking, but keeps them while an operation is still running", async () => {
  const { view, confirmDiscard } = await connectionsPage(false);
  view.openSetup();
  const saved = view.app.clientId;
  view.app.clientId = "changed.apps.googleusercontent.com";
  view.app.clientSecret = "changed-secret";
  expect(view.setupDirty.value).toBe(true);
  view.state.busy = "app";
  view.setSetupOpen(false);
  expect(view.setupOpen.value).toBe(true);
  expect(view.app.clientSecret).toBe("changed-secret");
  view.state.busy = "";
  view.setSetupOpen(false);
  expect(view.setupOpen.value).toBe(false);
  expect(view.setupDirty.value).toBe(false);
  expect(view.app.clientId).toBe(saved);
  expect(view.app.clientSecret).toBe("");
  expect(confirmDiscard).not.toHaveBeenCalled();
});

it.each([
  ["google_timeout", "timeout"],
  ["google_unavailable", "unavailable"],
  ["google_app_invalid", "app_invalid"],
])("returns a bounded OAuth failure outcome for %s", async (code, outcome) => {
  const f = await fixture();
  f.service.finish.mockRejectedValueOnce(new Error(code));
  const response = await f.request(`${GOOGLE_PATH}/complete`, "owner", { state: "s".repeat(43), code: "private-code" });
  expect(await response.json()).toEqual({ outcome });
});

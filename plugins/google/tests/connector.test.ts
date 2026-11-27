import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureLogging, manualClock, type Clock, type LogRecord } from "@yesimbot/foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleManager, GOOGLE_CALLBACK_PATH } from "../src/connector.js";
import { request } from "../src/http.js";
import { permissions, requestedScopes, SCOPES } from "../src/scopes.js";
import { sharedAppReader } from "../src/shared-app.js";
import { GoogleStore } from "../src/store.js";

const clean: Array<() => Promise<unknown> | void> = [];
const records: LogRecord[] = [];
beforeEach(() => {
  records.length = 0;
  configureLogging({ sink: (record) => records.push(record) });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const off of clean.splice(0).reverse()) await off();
});
const config = { clientId: "test.apps.googleusercontent.com", clientSecret: "secret-never-return", redirectUri: `https://bot.example${GOOGLE_CALLBACK_PATH}` };
const tenant = randomUUID(),
  accountId = randomUUID();
const client = createHash("sha256").update(config.clientId).digest("hex");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
/** Google is reached through `httpFetch`, which calls the global `fetch`; the test replaces that. */
function serve<T extends (...args: never[]) => unknown>(fetcher: T): T {
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

async function fixture(fetcher: typeof fetch = vi.fn(async () => json({})), clock: Clock = manualClock(100_000)) {
  serve(fetcher);
  const dir = await mkdtemp(join(tmpdir(), "yesimbot-google-"));
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const store = await GoogleStore.open(dir, tenant);
  const manager = new GoogleManager(store, config, clock);
  clean.push(() => manager.close());
  const seed = (scopes: readonly string[] = SCOPES.gmail.manage, expiresAt = 1_000_000) =>
    store.change((state) => {
      state.accounts = [
        {
          id: accountId,
          subject: "google-subject-1",
          email: "person@example.com",
          client,
          refreshToken: "refresh-secret",
          accessToken: "access-secret",
          expiresAt,
          scopes: [...scopes],
          connectedAt: 1000,
          needsReconnect: false,
          permissions: permissions(scopes),
        },
      ];
    });
  return { dir, store, manager, seed };
}

function authorizationFetch(scopes?: readonly string[], refresh = true) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token")
      return json({
        access_token: "new-access-secret",
        ...(refresh ? { refresh_token: "new-refresh-secret" } : {}),
        token_type: "Bearer",
        expires_in: 3600,
        ...(scopes ? { scope: scopes.join(" ") } : {}),
      });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo")
      return json({ sub: "google-subject-1", email: "person@example.com", email_verified: true, name: "Person" });
    return json({});
  });
}

describe("the owner's shared app", () => {
  it("a friend's runtime follows the shared file as the owner sets it up, replaces it or removes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yesimbot-google-shared-"));
    clean.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "google.json");
    const read = sharedAppReader(file);
    const manager = new GoogleManager(await GoogleStore.open(dir, tenant), read, manualClock(100_000), true);
    clean.push(() => manager.close());
    expect(await manager.snapshot()).toMatchObject({ configured: false, shared: true });
    await expect(manager.begin("browser-a", { gmail: "read" })).rejects.toThrow("google_app_not_configured");
    await writeFile(file, JSON.stringify({ version: 1, ...config }));
    const snapshot = await manager.snapshot();
    expect(snapshot).toMatchObject({ configured: true, shared: true });
    // A friend never learns which app the owner uses.
    expect(snapshot).not.toHaveProperty("clientId");
    expect(snapshot).not.toHaveProperty("redirectUri");
    expect(new URL((await manager.begin("browser-a", { gmail: "read" })).authorizationUrl).searchParams.get("client_id")).toBe(config.clientId);
    await writeFile(file, JSON.stringify({ version: 1, ...config, redirectUri: "http://bot.example/elsewhere" }) + " ");
    expect((await manager.snapshot()).configured).toBe(false);
    await writeFile(file, "not json");
    expect((await manager.snapshot()).configured).toBe(false);
  });
  it("a sign-in started under one app fails when the owner replaces the app before it finishes", async () => {
    const fetcher = serve(authorizationFetch(SCOPES.gmail.read));
    let app = config;
    const dir = await mkdtemp(join(tmpdir(), "yesimbot-google-swap-"));
    clean.push(() => rm(dir, { recursive: true, force: true }));
    const store = await GoogleStore.open(dir, tenant);
    const manager = new GoogleManager(store, () => app, manualClock(100_000), true);
    clean.push(() => manager.close());
    const state = new URL((await manager.begin("browser-a", { gmail: "read" })).authorizationUrl).searchParams.get("state")!;
    app = { ...config, clientId: "other.apps.googleusercontent.com" };
    await expect(manager.finish("browser-a", { state, code: "code" }, () => true)).rejects.toThrow("google_oauth_invalid");
    // The code was exchanged with the app it was issued to, never with the replacement.
    const body = new URLSearchParams(String((fetcher.mock.calls[0][1] as RequestInit).body));
    expect(body.get("client_id")).toBe(config.clientId);
    expect(store.snapshot().accounts).toEqual([]);
  });
});

describe("OAuth and account isolation", () => {
  it("opens Google on the account whose access is being changed", async () => {
    const { manager, seed } = await fixture();
    await seed();
    const url = new URL((await manager.begin("browser-a", { gmail: "read" }, accountId)).authorizationUrl);
    expect(url.searchParams.get("login_hint")).toBe("person@example.com");
    expect(new URL((await manager.begin("browser-a", { gmail: "read" })).authorizationUrl).searchParams.has("login_hint")).toBe(false);
    await expect(manager.begin("browser-a", { gmail: "read" }, randomUUID())).rejects.toThrow("google_account_not_found");
  });
  it("requests exactly the selected service grants, offline access, random state and S256 PKCE", async () => {
    const { manager } = await fixture();
    const one = new URL((await manager.begin("browser-a", { gmail: "read" })).authorizationUrl);
    const two = new URL((await manager.begin("browser-a", { gmail: "read" })).authorizationUrl);
    expect(one.origin).toBe("https://accounts.google.com");
    expect(one.searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", "profile", ...SCOPES.gmail.read]);
    expect(one.searchParams.get("state")).not.toBe(two.searchParams.get("state"));
    expect(one.searchParams.get("code_challenge_method")).toBe("S256");
    expect(one.searchParams.get("access_type")).toBe("offline");
    expect(one.searchParams.get("prompt")).toContain("consent");
    expect(one.searchParams.has("client_secret")).toBe(false);
  });
  it("binds state to the initiating browser, consumes it once, and passes the matching PKCE verifier", async () => {
    const fetcher = authorizationFetch();
    const { manager } = await fixture(fetcher as typeof fetch);
    const url = new URL((await manager.begin("browser-a", { gmail: "manage" })).authorizationUrl);
    const state = url.searchParams.get("state")!;
    await expect(manager.finish("browser-b", { state, code: "the-code" }, () => true)).rejects.toThrow("google_oauth_invalid");
    expect(fetcher).not.toHaveBeenCalled();
    await manager.finish("browser-a", { state, code: "the-code" }, () => true);
    const body = (fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as URLSearchParams;
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    await expect(manager.finish("browser-a", { state, code: "the-code" }, () => true)).rejects.toThrow("google_oauth_invalid");
    const snapshot = await manager.snapshot();
    expect(snapshot.accounts[0].permissions).toEqual({ gmail: "manage" });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|access_token|refreshToken|subject/);
  });
  it("expires authorization, consumes denial, and refuses a revoked session after the token exchange", async () => {
    const clock = manualClock(10);
    const fetcher = authorizationFetch();
    const { manager, store } = await fixture(fetcher as typeof fetch, clock);
    const state = new URL((await manager.begin("a", { drive: "read" })).authorizationUrl).searchParams.get("state")!;
    clock.advance(600_001);
    await expect(manager.finish("a", { state, code: "code" }, () => true)).rejects.toThrow("google_oauth_invalid");
    const denied = new URL((await manager.begin("a", { drive: "read" })).authorizationUrl).searchParams.get("state")!;
    await expect(manager.finish("a", { state: denied, error: "access_denied" }, () => true)).rejects.toThrow("google_consent_denied");
    await expect(manager.finish("a", { state: denied, code: "code" }, () => true)).rejects.toThrow("google_oauth_invalid");
    const fresh = new URL((await manager.begin("a", { gmail: "read" })).authorizationUrl).searchParams.get("state")!;
    let checks = 0;
    await expect(manager.finish("a", { state: fresh, code: "code" }, () => ++checks < 2)).rejects.toThrow("google_oauth_invalid");
    expect(store.snapshot().accounts).toHaveLength(0);
  });
  it("stores actual partial consent and requires a refresh token for a new account", async () => {
    const fetcher = authorizationFetch(SCOPES.gmail.read);
    const { manager } = await fixture(fetcher as typeof fetch);
    const state = new URL((await manager.begin("a", { gmail: "manage", drive: "manage" })).authorizationUrl).searchParams.get("state")!;
    await manager.finish("a", { state, code: "code" }, () => true);
    expect((await manager.snapshot()).accounts[0].permissions).toEqual({ gmail: "read" });
    const second = await fixture(authorizationFetch(undefined, false) as typeof fetch);
    const missing = new URL((await second.manager.begin("a", { calendar: "read" })).authorizationUrl).searchParams.get("state")!;
    await expect(second.manager.finish("a", { state: missing, code: "code" }, () => true)).rejects.toThrow("google_refresh_missing");
  });
  it("never widens the selected permission ceiling when Google returns older broader grants", async () => {
    const { manager } = await fixture(authorizationFetch([...SCOPES.gmail.manage, ...SCOPES.drive.manage]) as typeof fetch);
    const state = new URL((await manager.begin("a", { gmail: "read" })).authorizationUrl).searchParams.get("state")!;
    await manager.finish("a", { state, code: "code" }, () => true);
    const [account] = (await manager.snapshot()).accounts;
    expect(account.permissions).toEqual({ gmail: "read" });
    await expect(manager.api(account.id, "gmail", "read", "/drafts/send", { method: "POST", operationId: "a" })).rejects.toThrow("google_scope_required");
    await expect(manager.api(account.id, "drive", "read", "/files")).rejects.toThrow("google_scope_required");
  });
  it("rejects unsafe callback URIs and never infers a different client's account by email", async () => {
    const { store, seed, manager } = await fixture();
    await seed();
    for (const redirectUri of [
      "http://public.example/callback",
      "https://bot.example/wrong",
      `https://evil@bot.example${GOOGLE_CALLBACK_PATH}`,
      `${config.redirectUri}?next=evil`,
    ])
      expect(() => new GoogleManager(store, { ...config, redirectUri })).toThrow("google_redirect_invalid");
    const other = new GoogleManager(store, { ...config, clientId: "other" });
    expect((await other.snapshot()).accounts[0].needsReconnect).toBe(true);
    await expect(other.api(accountId, "gmail", "read", "/messages")).rejects.toThrow("google_reconnect_required");
    await expect(manager.api(randomUUID(), "gmail", "read", "/messages")).rejects.toThrow("google_account_not_found");
  });
});

describe("encrypted persistence and API execution", () => {
  it("encrypts all account data, persists attempts, and fails closed for corruption or another tenant", async () => {
    const { dir, store, seed } = await fixture();
    await seed();
    const encrypted = await readFile(join(dir, "accounts.enc"));
    expect(encrypted.toString()).not.toMatch(/secret|person@example.com/);
    expect((await stat(join(dir, "key"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "accounts.enc"))).mode & 0o777).toBe(0o600);
    expect((await GoogleStore.open(dir, tenant)).snapshot().accounts).toEqual(store.snapshot().accounts);
    await expect(GoogleStore.open(dir, "foreign-tenant")).rejects.toThrow("google_store_invalid");
    const bad = Buffer.from(encrypted);
    bad[bad.length - 1] ^= 1;
    await writeFile(join(dir, "accounts.enc"), bad);
    await expect(GoogleStore.open(dir, tenant)).rejects.toThrow("google_store_invalid");
  });
  it("serializes vault updates without losing concurrent changes", async () => {
    const { store } = await fixture();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.change((state) => {
          state.attempts[createHash("sha256").update(String(i)).digest("hex")] = i;
        }),
      ),
    );
    expect(Object.keys(store.snapshot().attempts)).toHaveLength(12);
  });
  it("coalesces refresh and caches it, and rechecks narrowed scopes before an effect", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/token")
        ? json({ access_token: "fresh", token_type: "Bearer", expires_in: 3600, scope: SCOPES.gmail.read.join(" ") })
        : json({ messages: [] }),
    );
    const { manager, seed } = await fixture(fetcher as typeof fetch);
    await seed(SCOPES.gmail.manage, 0);
    await Promise.all([manager.api(accountId, "gmail", "read", "/messages"), manager.api(accountId, "gmail", "read", "/messages")]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
    await expect(manager.api(accountId, "gmail", "manage", "/drafts/send", { method: "POST", body: { id: "d1" }, operationId: "op1" })).rejects.toThrow(
      "google_scope_required",
    );
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("drafts/send"))).toBe(false);
  });
  it("marks invalid_grant as reconnect-required and sanitizes provider messages", async () => {
    const fetcher = vi.fn(async () => json({ error: "invalid_grant", error_description: "refresh-secret is invalid" }, 400));
    const { manager, seed, store } = await fixture(fetcher as typeof fetch);
    await seed(SCOPES.gmail.read, 0);
    await expect(manager.api(accountId, "gmail", "read", "/messages")).rejects.toThrow(/^google_reconnect_required$/);
    expect(store.snapshot().accounts[0].needsReconnect).toBe(true);
    await expect(manager.api(accountId, "gmail", "read", "/messages")).rejects.toThrow("google_reconnect_required");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("persists admission before sending, and never retries or replays an ambiguous effect across restart", async () => {
    let dir = "";
    const fetcher = vi.fn(async () => {
      expect((await readFile(join(dir, "accounts.enc"))).length).toBeGreaterThan(29);
      throw new Error("secret network detail");
    });
    const fixtureValue = await fixture(fetcher as typeof fetch);
    dir = fixtureValue.dir;
    const { manager, seed } = fixtureValue;
    await seed();
    const options = { method: "POST" as const, body: { id: "draft-1" }, operationId: "send-op" };
    await expect(manager.api(accountId, "gmail", "manage", "/drafts/send", options)).rejects.toThrow(/^google_result_unknown$/);
    const reopened = new GoogleManager(await GoogleStore.open(dir, tenant), config);
    await expect(reopened.api(accountId, "gmail", "manage", "/drafts/send", options)).rejects.toThrow("google_operation_already_attempted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("sends a read lost in transit once more, but not a rejected read, and reports a second failure", async () => {
    const fetcher = vi.fn(async () => json({ messages: [] }));
    fetcher.mockRejectedValueOnce(new Error("socket reset"));
    const { manager, seed } = await fixture(fetcher as typeof fetch);
    await seed();
    await expect(manager.api(accountId, "gmail", "read", "/messages")).resolves.toEqual({ messages: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockClear();
    fetcher.mockResolvedValueOnce(json({}, 404));
    await expect(manager.api(accountId, "gmail", "read", "/messages/missing")).rejects.toThrow(/^google_not_found$/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    fetcher.mockRejectedValue(new Error("offline"));
    await expect(manager.api(accountId, "gmail", "read", "/messages")).rejects.toThrow(/^google_unavailable$/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects writes without a stable operation ID and obeys cancellation before sending", async () => {
    const fetcher = vi.fn(async () => json({}));
    const { manager, seed } = await fixture(fetcher as typeof fetch);
    await seed();
    await expect(manager.api(accountId, "gmail", "manage", "/drafts/send", { method: "POST" })).rejects.toThrow("google_operation_id_required");
    const controller = new AbortController();
    controller.abort();
    await expect(manager.api(accountId, "gmail", "manage", "/drafts/send", { method: "POST", operationId: "a", signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("removes local access even when remote revocation fails", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    const { manager, seed, dir } = await fixture(fetcher as typeof fetch);
    await seed();
    expect(await manager.disconnect(accountId)).toEqual({ revoked: false });
    expect(records.find((record) => record.event === "account.revoke_failed")).toMatchObject({ level: "warn", code: "google_unavailable" });
    expect(JSON.stringify(records)).not.toContain("refresh-secret");
    expect((await manager.snapshot()).accounts).toEqual([]);
    expect((await GoogleStore.open(dir, tenant)).snapshot().accounts).toEqual([]);
    await expect(manager.api(accountId, "gmail", "read", "/messages")).rejects.toThrow("google_account_not_found");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds response bodies and never follows an authenticated redirect", async () => {
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      return new Response("a".repeat(128 * 1024 + 1));
    });
    serve(fetcher);
    await expect(request("https://www.googleapis.com/drive/v3/files/a", {}, undefined, true)).rejects.toThrow("google_response_too_large");
    serve(vi.fn(async () => new Response("not-json")));
    await expect(request("https://oauth2.googleapis.com/token", {})).rejects.toThrow("google_invalid_response");
  });
});

it("models read/manage grants without accidentally treating a partial calendar grant as full access", () => {
  expect(permissions([SCOPES.calendar.manage[1]])).toEqual({});
  expect(permissions([...SCOPES.calendar.manage, ...SCOPES.drive.read])).toEqual({ calendar: "manage", drive: "read" });
  expect(() => requestedScopes({})).toThrow();
  expect(() => requestedScopes({ unknown: "manage" } as never)).toThrow();
});

it("classifies an aborted request separately and never exposes transport credentials", async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = serve(
    vi.fn(async () => {
      throw new Error("private transport detail");
    }),
  );
  await expect(request("https://oauth2.googleapis.com/token", {}, controller.signal)).rejects.toThrow("google_timeout");
  expect(transport).not.toHaveBeenCalled();
  const failure = await request("https://oauth2.googleapis.com/token", {}).catch((error) => error);
  expect(failure).toMatchObject({ name: "AppError", code: "google_unavailable", message: "google_unavailable" });
  // The cause is kept for the log; the message the callers pass on is only the code.
  expect(failure.cause).toMatchObject({ code: "network_failed" });
  expect(failure.message).not.toContain("private transport detail");
});

it("never follows a redirect with the bearer token, and says so as unavailable", async () => {
  const redirect = serve(vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/steal" } })));
  await expect(request("https://www.googleapis.com/drive/v3/files", { headers: { Authorization: "Bearer secret" } })).rejects.toMatchObject({
    code: "google_unavailable",
    effect: "unknown",
  });
  expect(redirect).toHaveBeenCalledOnce();
});

it("keeps the parse failure of an unreadable answer as the cause", async () => {
  serve(vi.fn(async () => new Response("<html>gateway page</html>")));
  const failure = await request("https://oauth2.googleapis.com/token", {}).catch((error) => error);
  expect(failure).toMatchObject({ code: "google_invalid_response" });
  expect(failure.cause).toBeInstanceOf(SyntaxError);
});

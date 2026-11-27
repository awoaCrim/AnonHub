import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { GoogleConnector, GoogleSelection, GoogleSharedApp, GoogleSnapshot } from "@yesimbot/contracts";
import { errorFields, writeFileAtomic } from "@yesimbot/foundation";

import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import { isObject } from "../config/secrets.js";
import type { ConfigStore } from "../config/store.js";
import type { Host } from "../host.js";
import { log } from "../log.js";
import { GOOGLE_CALLBACK_PATH, GOOGLE_PATH } from "../shared/google.js";
import type { PluginConfigEntry } from "../shared/plugin-config.js";
import { authorizeOwner, type HttpContext } from "./plugins.js";

/** A friend's runtime: the owner's shared app arrives here through the account manager (read-only mount). */
export const SHARED_APP_FILE = process.env.YESIMBOT_GOOGLE_APP_FILE || "/run/yesimbot/policy/google.json";

const PLUGIN = "yesimbot-google";

const CLIENT_ID = /^[\w.-]{1,200}\.apps\.googleusercontent\.com$/;

const SECRET = /^[\x21-\x7e]{8,200}$/;

// A cross-site OAuth GET does not carry the application's SameSite=Strict login cookie.
// Commit a minimal same-origin document, then POST with that cookie through the normal tenant relay.
// The script is constant: no query values are interpolated into HTML or JavaScript.
const callbackScript = `(async()=>{
 const p=new URLSearchParams(location.search);const v={};let outcome="expired";const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),55000);
 for(const key of ["state","code","error"]){const all=p.getAll(key);if(all.length>1){location.replace("/settings/connections?google=expired");return;}if(all.length)v[key]=all[0];}
 history.replaceState(null,"","/settings/connections");
 try{const r=await fetch("${GOOGLE_PATH}/complete",{method:"POST",signal:controller.signal,credentials:"same-origin",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(v)});if(r.ok){const data=await r.json();if(["connected","denied","expired","failed","timeout","unavailable","app_invalid","permission_denied"].includes(data.outcome))outcome=data.outcome;}else outcome="failed";}catch{outcome=controller.signal.aborted?"timeout":"failed";}finally{clearTimeout(timer);}
 location.replace("/settings/connections?google="+outcome);
})();`;

const callbackCsp = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(callbackScript).digest("base64")}'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/** Whether the owner's shared app is set up, as this friend's runtime sees it. */
export function sharedAppConfigured(file = SHARED_APP_FILE): boolean {
  try {
    if (statSync(file).size > 4096) return false;
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<GoogleSharedApp>;
    return value.version === 1 && !!value.clientId && !!value.clientSecret && !!value.redirectUri;
  } catch {
    return false;
  }
}

export function installGoogle(ctx: Host, auth: AdminAuth, store: ConfigStore, tenant: boolean, callbackDocument?: string): void {
  const permitted = () => store.permitted(PLUGIN);
  const authorized = (http: HttpContext, write = false) => {
    // Member requests have already been relayed into their own child runtime.
    if (!authorizeOwner(http, auth, write)) return false;
    if (permitted()) return true;
    http.status = 403;
    http.body = { message: "not_permitted" };
    return false;
  };
  const connector = (): GoogleConnector => {
    const service = ctx.get("yesimbotGoogle") as GoogleConnector | undefined;
    if (!service) throw new Error("google_unavailable");
    return service;
  };
  /** Starts the plugin when it is not running yet and waits for its connector. */
  const started = async (): Promise<GoogleConnector> => {
    const running = ctx.get("yesimbotGoogle") as GoogleConnector | undefined;
    if (running) return running;
    await enableGoogle(store);
    for (let waited = 0; waited < 15_000; waited += 200) {
      const service = ctx.get("yesimbotGoogle") as GoogleConnector | undefined;
      if (service) return service;
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error("google_unavailable");
  };
  ctx.server.get(GOOGLE_PATH, async (http) => {
    if (!authorized(http)) return;
    try {
      const service = ctx.get("yesimbotGoogle") as GoogleConnector | undefined;
      // Not started yet: a friend can still connect once the owner's app is set up; the owner sees the setup.
      const result: GoogleSnapshot = service
        ? await service.snapshot()
        : { available: true, configured: tenant && sharedAppConfigured(), shared: tenant, accounts: [] };
      if (authorized(http)) http.body = result;
    } catch (error) {
      if (authorized(http)) failure(http, error);
    }
  });
  ctx.server.post(`${GOOGLE_PATH}/authorize`, async (http) => {
    if (!authorized(http, true)) return;
    try {
      const input = (await readAdminLoginBody(http, 4096)) as Record<string, unknown>;
      if (!input || Object.keys(input).some((key) => key !== "services" && key !== "account")) throw new Error("google_invalid_input");
      const services = selection(input.services);
      if (input.account !== undefined && (typeof input.account !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.account)))
        throw new Error("google_invalid_input");
      if (!authorized(http, true)) return;
      const service = await started();
      if (!authorized(http, true)) return;
      const result = await service.begin(http.get("cookie"), services, input.account as string | undefined);
      if (authorized(http, true)) http.body = result;
    } catch (error) {
      if (authorized(http, true)) failure(http, error);
    }
  });
  ctx.server.post(`${GOOGLE_PATH}/disconnect`, async (http) => {
    if (!authorized(http, true)) return;
    try {
      const input = (await readAdminLoginBody(http, 4096)) as Record<string, unknown>;
      if (
        !input ||
        Object.keys(input).some((key) => key !== "id") ||
        typeof input.id !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.id)
      )
        throw new Error("google_invalid_input");
      if (!authorized(http, true)) return;
      const result = await connector().disconnect(input.id);
      if (authorized(http, true)) http.body = result;
    } catch (error) {
      if (authorized(http, true)) failure(http, error);
    }
  });
  // The owner's own Google app, shared with every friend. A friend's runtime has none of its own.
  ctx.server.post(`${GOOGLE_PATH}/app`, async (http) => {
    if (!authorized(http, true)) return;
    if (tenant) {
      http.status = 403;
      http.body = { message: "owner_required" };
      return;
    }
    try {
      const input = (await readAdminLoginBody(http, 4096)) as Record<string, unknown>;
      if (!input || Object.keys(input).some((key) => !["clientId", "clientSecret", "redirectUri"].includes(key))) throw new Error("google_invalid_input");
      const { clientId, clientSecret, redirectUri } = input;
      if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) throw new Error("google_invalid_client_id");
      if (clientSecret !== undefined && (typeof clientSecret !== "string" || !SECRET.test(clientSecret))) throw new Error("google_invalid_client_secret");
      if (typeof redirectUri !== "string" || redirectUri.length > 512) throw new Error("google_invalid_input");
      const url = new URL(redirectUri);
      const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== GOOGLE_CALLBACK_PATH || url.search || url.hash)
        throw new Error("google_invalid_input");
      if (!authorized(http, true)) return;
      const path = await enableGoogle(store);
      const current = store.resolve(path).value;
      const secret = (clientSecret as string | undefined) ?? (typeof current.clientSecret === "string" ? current.clientSecret : undefined);
      if (!secret) throw new Error("google_invalid_client_secret");
      await store.update(store.revision(), path, { ...current, clientId, clientSecret: secret, redirectUri });
      if (authorized(http, true)) http.body = { saved: true };
    } catch (error) {
      if (!authorized(http, true)) return;
      const code = error instanceof Error ? error.message : "";
      if (code === "google_invalid_client_id" || code === "google_invalid_client_secret") {
        http.status = 400;
        http.body = { message: code };
      } else failure(http, code === "google_invalid_input" || error instanceof TypeError ? new Error("google_invalid_input") : error);
    }
  });
  ctx.server.get(GOOGLE_CALLBACK_PATH, async (http) => {
    http.set("Cache-Control", "private, no-store");
    http.set("Referrer-Policy", "no-referrer");
    http.set("Content-Security-Policy", callbackCsp);
    http.type = "text/html";
    // UI-EXCEPTION missing-assets: preserve OAuth recovery when the UI build is absent. Normal releases use the shared SSR Card/Button document.
    http.body = callbackDocument?.includes("<!-- OAUTH_CALLBACK_SCRIPT -->")
      ? callbackDocument.replace("<!-- OAUTH_CALLBACK_SCRIPT -->", `<script>${callbackScript}</script>`)
      : `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>连接 Google</title><p>正在完成 Google 授权…</p><p><a href="/settings/connections">返回服务连接，查看连接状态或重新授权</a></p><noscript>请开启 JavaScript 后重新连接 Google。</noscript><script>${callbackScript}</script></html>`;
  });
  ctx.server.post(`${GOOGLE_PATH}/complete`, async (http) => {
    if (!authorized(http, true)) return;
    const cookie = http.get("cookie"),
      session = auth.sessionFromCookie(cookie);
    const valid = () => !!session && session.role !== "member" && auth.sessionFromCookie(cookie) === session && permitted();
    if (!valid()) {
      http.status = 401;
      http.body = { message: "login_required" };
      return;
    }
    let result = "failed";
    try {
      const input = (await readAdminLoginBody(http, 12 * 1024)) as Record<string, unknown>;
      if (!input || Object.keys(input).some((key) => !["state", "code", "error"].includes(key))) throw new Error("google_oauth_invalid");
      const { state, code, error } = input;
      if (
        typeof state !== "string" ||
        !/^[a-zA-Z0-9_-]{43}$/.test(state) ||
        (code !== undefined && (typeof code !== "string" || code.length > 8192)) ||
        (error !== undefined && (typeof error !== "string" || error.length > 256))
      )
        throw new Error("google_oauth_invalid");
      await connector().finish(cookie, { state, ...(typeof code === "string" ? { code } : {}), ...(typeof error === "string" ? { error } : {}) }, valid);
      result = "connected";
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "google_consent_denied") result = "denied";
      else if (code === "google_oauth_invalid") result = "expired";
      else if (code === "google_timeout") result = "timeout";
      else if (code === "google_unavailable") result = "unavailable";
      else if (code === "google_app_invalid") result = "app_invalid";
      else if (code === "google_permission_denied" || code === "google_no_services_granted") result = "permission_denied";
      log.warn("google.oauth_failed", { result });
    }
    if (!valid()) {
      http.status = 401;
      http.body = { message: "login_required" };
      return;
    }
    http.body = { outcome: result };
  });
}

/**
 * The owner publishes its Google app for the account manager, which copies it into each friend's read-only policy
 * folder. Only a complete, enabled app is published; anything else publishes "not set up".
 */
export function installGoogleAppPublisher(
  ctx: Host,
  store: Pick<ConfigStore, "catalog" | "resolve">,
  file = resolve(ctx.baseDir, "data/console-admin/google-app.json"),
) {
  const publish = async () => {
    try {
      const entry = await googleEntry(store as ConfigStore);
      const value = entry?.enabled ? store.resolve(entry.path).value : {};
      const app: GoogleSharedApp = { version: 1 };
      if (isObject(value) && typeof value.clientId === "string" && typeof value.clientSecret === "string" && typeof value.redirectUri === "string") {
        app.clientId = value.clientId;
        app.clientSecret = value.clientSecret;
        app.redirectUri = value.redirectUri;
      }
      const data = JSON.stringify(app) + "\n";
      try {
        if (readFileSync(file, "utf8") === data) return;
      } catch {
        /* First publication. */
      }
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(file, data, { mode: 0o600 });
    } catch (error) {
      // Members keep the last valid settings.
      log.warn("google.app_publish_failed", { ...errorFields(error) });
    }
  };
  ctx.on("ready", () => void publish());
  const timer = setInterval(() => void publish(), 5000);
  timer.unref?.();
  ctx.on("dispose", () => clearInterval(timer));
  return publish;
}

function flatten(tree: PluginConfigEntry[]): PluginConfigEntry[] {
  return tree.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

/** The Google plugin's entry in this runtime's koishi.yml, if it was ever added. */
async function googleEntry(store: ConfigStore): Promise<PluginConfigEntry | undefined> {
  const entries = flatten((await store.catalog.snapshot()).tree).filter((item) => !item.group && item.name === PLUGIN);
  return entries.find((item) => item.enabled) ?? entries[0];
}

/** Add the plugin if it is missing and turn it on, so connecting needs no trip to the plugin list. */
async function enableGoogle(store: ConfigStore): Promise<string> {
  let entry = await googleEntry(store);
  let path = entry?.path;
  if (!path) path = (await store.add(store.revision(), "", PLUGIN)).path!;
  if (!entry?.enabled) path = (await store.setEnabled(store.revision(), path, true)).path ?? path;
  return path;
}

function selection(value: unknown): GoogleSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("google_invalid_input");
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([key, mode]) => !["gmail", "calendar", "drive"].includes(key) || !["read", "manage"].includes(mode as string)))
    throw new Error("google_invalid_input");
  return Object.fromEntries(entries) as GoogleSelection;
}

function failure(http: HttpContext, error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const allowed = ["google_invalid_input", "google_app_not_configured", "google_login_busy", "google_account_not_found", "google_account_limit"];
  const message = allowed.includes(code) ? code : "google_unavailable";
  http.status = message === "google_invalid_input" ? 400 : message === "google_account_not_found" ? 404 : message === "google_unavailable" ? 503 : 409;
  http.body = { message };
}

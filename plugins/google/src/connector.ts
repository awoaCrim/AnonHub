import { createHash } from "node:crypto";

import type { GoogleAccess, GoogleConnector, GoogleSelection, GoogleService, GoogleSnapshot } from "@yesimbot/contracts";
import { AppError, contentHash, errorFields, isAbortError, logger, newId, newSecret, retry, systemClock, type Clock } from "@yesimbot/foundation";
import { z } from "zod/v4";

import type { GoogleConfig } from "./config.js";
import { googleError } from "./errors.js";
import { request } from "./http.js";
import { permissions, requestedScopes, selectionSchema } from "./scopes.js";
import { GoogleStore, type GoogleAccount } from "./store.js";

export const GOOGLE_CALLBACK_PATH = "/yesimbot/api/v1/connectors/google/callback";

const log = logger("yesimbot.google");

/** The pause before a read lost in transit is sent again. */
const READ_RETRY_MS = 1_000;

const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(16384).optional(),
  expires_in: z.number().positive().max(86400),
  token_type: z.string().refine((v) => v.toLowerCase() === "bearer"),
  scope: z.string().max(8192).optional(),
});

const identitySchema = z.object({
  sub: z.string().min(1).max(256),
  email: z.string().email().max(320),
  email_verified: z.literal(true),
  name: z.string().max(200).optional(),
});

const bases = {
  gmail: "https://gmail.googleapis.com/gmail/v1/users/me",
  calendar: "https://www.googleapis.com/calendar/v3",
  drive: "https://www.googleapis.com/drive/v3",
} as const;

type Pending = { binding: string; verifier: string; scopes: string[]; selection: GoogleSelection; expires: number; app: Required<GoogleConfig> };

/** Runtime-local OAuth app, account vault and API transport. No model tool can begin or finish login. */
export class GoogleManager implements GoogleConnector {
  private readonly pending = new Map<string, Pending>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly accountSignals = new Map<string, AbortController>();
  private readonly stopped = new AbortController();
  private readonly app: () => GoogleConfig;
  /**
   * `config` is a fixed configuration, or a reader for one that can change while running: a friend's runtime
   * reads the owner's shared app, which the owner may set up or replace at any time.
   */
  constructor(
    private readonly store: GoogleStore,
    config: GoogleConfig | (() => GoogleConfig),
    private readonly clock: Clock = systemClock(),
    private readonly shared = false,
  ) {
    this.app = typeof config === "function" ? config : () => config;
    if (typeof config !== "function" && config.redirectUri && !validRedirect(config.redirectUri)) throw googleError("google_redirect_invalid");
  }
  /** The app in effect now; an unusable redirect counts as not configured. */
  private current(): Required<GoogleConfig> | undefined {
    const { clientId, clientSecret, redirectUri } = this.app();
    return clientId && clientSecret && redirectUri && validRedirect(redirectUri) ? { clientId, clientSecret, redirectUri } : undefined;
  }
  private get client(): string {
    return fingerprint(this.app().clientId ?? "");
  }
  close(): void {
    this.pending.clear();
    this.stopped.abort();
  }
  private ready(): Required<GoogleConfig> {
    if (this.stopped.signal.aborted) throw googleError("google_unavailable");
    const app = this.current();
    if (!app) throw googleError("google_app_not_configured");
    return app;
  }
  async snapshot(): Promise<GoogleSnapshot> {
    return {
      available: !this.stopped.signal.aborted,
      configured: !!this.current(),
      shared: this.shared,
      // A friend's runtime borrows the owner's app: only the owner sees which one it is.
      ...(this.shared ? {} : { redirectUri: this.app().redirectUri, ...(this.app().clientId ? { clientId: this.app().clientId } : {}) }),
      accounts: this.store.snapshot().accounts.map((account) => ({
        id: account.id,
        email: account.email,
        ...(account.name ? { name: account.name } : {}),
        permissions: accountPermissions(account),
        connectedAt: account.connectedAt,
        needsReconnect: account.needsReconnect || account.client !== this.client,
      })),
    };
  }
  async begin(binding: string, selection: GoogleSelection, accountId?: string): Promise<{ authorizationUrl: string }> {
    const app = this.ready();
    // Changing or renewing one account's access: Google opens on that account instead of asking which.
    const hint = accountId === undefined ? undefined : this.store.snapshot().accounts.find((row) => row.id === accountId)?.email;
    if (accountId !== undefined && !hint) throw googleError("google_account_not_found");
    const scopes = requestedScopes(selection);
    for (const [state, item] of this.pending) if (item.expires <= this.clock.now()) this.pending.delete(state);
    if (!binding || this.pending.size >= 32) throw googleError("google_login_busy");
    const state = newSecret(32),
      verifier = newSecret(48);
    this.pending.set(state, {
      binding: fingerprint(binding),
      verifier,
      scopes,
      selection: selectionSchema.parse(selection),
      expires: this.clock.now() + 10 * 60_000,
      app,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: app.redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "false",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...(hint ? { login_hint: hint } : {}),
    }).toString();
    return { authorizationUrl: url.href };
  }
  async finish(binding: string, input: { state: string; code?: string; error?: string }, valid: () => boolean): Promise<void> {
    this.ready();
    const item = this.pending.get(input.state);
    if (!item || item.expires <= this.clock.now() || !binding || item.binding !== fingerprint(binding) || !valid()) throw googleError("google_oauth_invalid");
    this.pending.delete(input.state); // A valid callback consumes the attempt, including consent denial.
    if (input.error) throw googleError("google_consent_denied");
    if (!input.code || input.code.length > 8192) throw googleError("google_oauth_invalid");
    const deadline = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(45_000)]);
    let token: z.infer<typeof tokenSchema>, user: z.infer<typeof identitySchema>;
    try {
      token = tokenSchema.parse(
        await this.token(
          { code: input.code, grant_type: "authorization_code", redirect_uri: item.app.redirectUri, code_verifier: item.verifier },
          item.app,
          deadline,
        ),
      );
      user = identitySchema.parse(
        await request("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` } }, deadline),
      );
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw googleError("google_oauth_invalid", { cause });
    }
    const granted = token.scope?.split(/\s+/).filter(Boolean) ?? item.scopes;
    // Preserve Google's actual grants; never turn a partial consent into the requested permissions.
    const approved = limitPermissions(permissions(granted), item.selection);
    if (!Object.keys(approved).length) throw googleError("google_no_services_granted");
    await this.store.change((state) => {
      if (!valid() || deadline.aborted) throw googleError("google_oauth_invalid");
      // Sign-in started under one app and the owner replaced it before it finished: start again.
      if (fingerprint(item.app.clientId) !== this.client) throw googleError("google_oauth_invalid");
      const existing = state.accounts.find((account) => account.subject === user.sub && account.client === this.client);
      const refreshToken = token.refresh_token ?? existing?.refreshToken;
      if (!refreshToken) throw googleError("google_refresh_missing");
      if (!existing && state.accounts.length >= 8) throw googleError("google_account_limit");
      const account: GoogleAccount = {
        id: existing?.id ?? newId(),
        subject: user.sub,
        email: user.email,
        ...(user.name ? { name: user.name } : {}),
        client: this.client,
        refreshToken,
        accessToken: token.access_token,
        expiresAt: this.clock.now() + token.expires_in * 1000,
        scopes: granted,
        connectedAt: this.clock.now(),
        needsReconnect: false,
        permissions: approved,
      };
      state.accounts = [...state.accounts.filter((row) => row.id !== account.id), account];
    });
  }
  async disconnect(id: string): Promise<{ revoked: boolean }> {
    const account = await this.store.change((state) => {
      const account = state.accounts.find((row) => row.id === id);
      if (!account) throw googleError("google_account_not_found");
      state.accounts = state.accounts.filter((row) => row.id !== id);
      return account;
    });
    this.accountSignals.get(id)?.abort();
    this.accountSignals.delete(id);
    try {
      await request(
        "https://oauth2.googleapis.com/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: account.refreshToken }),
        },
        this.stopped.signal,
      );
      return { revoked: true };
    } catch (cause) {
      // Local access is already gone, even if Google is unreachable.
      log.warn("account.revoke_failed", { ...errorFields(cause) });
      return { revoked: false };
    }
  }
  private account(id: string): GoogleAccount {
    this.ready();
    const account = this.store.snapshot().accounts.find((row) => row.id === id);
    if (!account) throw googleError("google_account_not_found");
    if (account.client !== this.client || account.needsReconnect) throw googleError("google_reconnect_required");
    return account;
  }
  private async token(params: Record<string, string>, app = this.ready(), signal = this.stopped.signal): Promise<unknown> {
    return request(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, client_id: app.clientId, client_secret: app.clientSecret }),
      },
      signal,
    );
  }
  private async access(id: string): Promise<string> {
    const account = this.account(id);
    if (account.accessToken && account.expiresAt > this.clock.now() + 60_000) return account.accessToken;
    const pending = this.refreshing.get(id);
    if (pending) return pending;
    const refresh = (async () => {
      try {
        const token = tokenSchema.parse(await this.token({ grant_type: "refresh_token", refresh_token: account.refreshToken }));
        await this.store.change((state) => {
          if (this.stopped.signal.aborted) throw googleError("google_unavailable");
          const current = state.accounts.find((row) => row.id === id);
          if (!current || current.refreshToken !== account.refreshToken) throw googleError("google_account_changed");
          current.accessToken = token.access_token;
          current.expiresAt = this.clock.now() + token.expires_in * 1000;
          if (token.refresh_token) current.refreshToken = token.refresh_token;
          if (token.scope) current.scopes = token.scope.split(/\s+/).filter(Boolean);
        });
        return token.access_token;
      } catch (cause) {
        if (cause instanceof AppError && cause.code === "google_reconnect_required") await this.markReconnect(id);
        if (cause instanceof AppError) throw cause;
        throw googleError("google_invalid_response", { cause });
      }
    })();
    this.refreshing.set(id, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshing.delete(id);
    }
  }
  private async markReconnect(id: string) {
    await this.store.change((state) => {
      const row = state.accounts.find((row) => row.id === id);
      if (row) {
        row.needsReconnect = true;
        delete row.accessToken;
      }
    });
  }

  async api<T = unknown>(
    id: string,
    service: GoogleService,
    access: GoogleAccess,
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      query?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
      text?: boolean;
      operationId?: string;
      multipart?: { metadata: { name: string; mimeType: string; parents?: string[] }; content: string };
    } = {},
  ): Promise<T> {
    const allowed = () => {
      const mode = accountPermissions(this.account(id))[service];
      if (!mode || ((access === "manage" || (options.method && options.method !== "GET")) && mode !== "manage")) throw googleError("google_scope_required");
    };
    allowed();
    const method = options.method ?? "GET",
      effect = method !== "GET";
    if (effect && !options.operationId) throw googleError("google_operation_id_required");
    const attemptKey = effect ? fingerprint(options.operationId!) : undefined;
    if (attemptKey && Object.hasOwn(this.store.snapshot().attempts, attemptKey)) throw googleError("google_operation_already_attempted");
    if (!path.startsWith("/") || path.includes("..") || /[?#\\]/.test(path)) throw googleError("google_request_rejected");
    if (options.multipart && (service !== "drive" || path !== "/files" || options.method !== "POST")) throw googleError("google_request_rejected");
    const url = new URL(`${options.multipart ? "https://www.googleapis.com/upload/drive/v3" : bases[service]}${path}`);
    if (options.query) url.search = new URLSearchParams(options.query).toString();
    const bearer = await this.access(id);
    allowed(); // A refresh can narrow scopes; a disconnect can race it.
    options.signal?.throwIfAborted();
    if (effect) {
      const key = attemptKey!;
      await this.store.change((state) => {
        if (!state.accounts.some((account) => account.id === id)) throw googleError("google_account_not_found");
        if (Object.hasOwn(state.attempts, key)) throw googleError("google_operation_already_attempted");
        if (Object.keys(state.attempts).length >= 5000) throw googleError("google_operation_limit");
        state.attempts[key] = this.clock.now(); // Persist before any effect; ambiguous calls are never replayed.
      });
    }
    let controller = this.accountSignals.get(id);
    if (!controller) {
      controller = new AbortController();
      this.accountSignals.set(id, controller);
    }
    const signal = AbortSignal.any([this.stopped.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    let body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    let contentType = body !== undefined ? "application/json" : undefined;
    if (options.multipart) {
      const boundary = `yesimbot_${newId()}`;
      contentType = `multipart/related; boundary=${boundary}`;
      body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(options.multipart.metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${options.multipart.content}\r\n--${boundary}--\r\n`;
    }
    allowed();
    signal.throwIfAborted();
    const send = () =>
      request(
        url,
        {
          method,
          headers: { Authorization: `Bearer ${bearer}`, ...(contentType ? { "Content-Type": contentType } : {}) },
          ...(body !== undefined ? { body } : {}),
        },
        signal,
        options.text,
      );
    try {
      let result: unknown;
      try {
        // A read lost in transit (reset, stalled proxy, 5xx) is sent once more after a pause; a write never is
        // (2026-11-20: one failed message lookup failed a whole Gmail check).
        result = await retry(
          (attempt) => {
            if (attempt > 1) allowed();
            return send();
          },
          {
            attempts: effect ? 1 : 2,
            effect: effect ? "unsafe" : "idempotent",
            classify: (error) => (error instanceof AppError && error.code === "google_unavailable" ? "transient" : "fatal"),
            backoff: { baseMs: READ_RETRY_MS, factor: 1, maxMs: READ_RETRY_MS, jitter: false },
            signal,
          },
        );
      } catch (error) {
        // Cancelled during the pause: the call that failed is what the caller learns of.
        if (isAbortError(error) && signal.aborted) throw googleError("google_timeout", { cause: error });
        throw error;
      }
      this.account(id); // Do not return disconnected private data to a waiting caller.
      return result as T;
    } catch (error) {
      if (error instanceof AppError && error.code === "google_reconnect_required") await this.markReconnect(id);
      if (effect && (!(error instanceof AppError) || ["google_unavailable", "google_invalid_response", "google_response_too_large"].includes(error.code)))
        throw googleError("google_result_unknown", { cause: error });
      throw error;
    }
  }
}

/** A redirect URI Google may call back: https (or loopback http), exactly the callback path. */
export function validRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return (local || url.protocol === "https:") && !url.username && !url.password && url.pathname === GOOGLE_CALLBACK_PATH && !url.search && !url.hash;
}

const fingerprint = (value: string) => contentHash(value);

function limitPermissions(actual: GoogleSelection, ceiling: GoogleSelection): GoogleSelection {
  const result: GoogleSelection = {};
  for (const service of ["gmail", "calendar", "drive"] as const) {
    if (actual[service] && ceiling[service]) result[service] = actual[service] === "manage" && ceiling[service] === "manage" ? "manage" : "read";
  }
  return result;
}

const accountPermissions = (account: GoogleAccount) => limitPermissions(permissions(account.scopes), account.permissions);

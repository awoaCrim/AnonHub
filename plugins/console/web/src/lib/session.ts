import { reactive } from "vue";

import type { BootstrapResponse, WebUIFeatures } from "../../../src/shared/webui";
import { api, ApiError } from "./api";
import { clearCaches, setCacheOwner } from "./cache";

const BOOT_KEY = "yesimbot:boot:v1";

function readBoot(): Partial<SessionState> | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(BOOT_KEY);
    return raw ? (JSON.parse(raw) as Partial<SessionState>) : undefined;
  } catch {
    return;
  }
}

function writeBoot(state: SessionState | undefined) {
  try {
    if (state?.authenticated) {
      const { username, role, expiresAt, features, memberRuntime } = state;
      globalThis.localStorage?.setItem(BOOT_KEY, JSON.stringify({ username, role, expiresAt, features, memberRuntime }));
    } else globalThis.localStorage?.removeItem(BOOT_KEY);
  } catch {
    // Storage unavailable: every load waits for bootstrap instead.
  }
}

export interface SessionState {
  loaded: boolean;
  authenticated: boolean;
  username: string;
  role: "owner" | "member";
  expiresAt: number;
  features: WebUIFeatures;
  /** Members on an accounts-enabled parent: whether their own runtime is serving requests. */
  memberRuntime: "running" | "unavailable" | "";
}

export type Fetcher = typeof fetch;

/**
 * One bootstrap request before the first route; afterwards route guards read
 * verified, unexpired metadata synchronously. The server still authorizes every request.
 */
export function createSession(fetcher: Fetcher = (...args) => fetch(...args), now = Date.now, remember = false) {
  const state = reactive<SessionState>({
    loaded: false,
    authenticated: false,
    username: "",
    role: "owner",
    expiresAt: 0,
    features: { napcat: false, wechat: false, accounts: false, tenant: false, usage: false },
    memberRuntime: "",
  });
  let pending: Promise<boolean> | undefined;
  let generation = 0;
  /** Shown from the last verified bootstrap; `verify()` confirms it in the background. */
  let optimistic = false;
  const boot = remember ? readBoot() : undefined;
  if (boot?.username && typeof boot.expiresAt === "number" && boot.expiresAt > now() && boot.features) {
    Object.assign(state, {
      loaded: true,
      authenticated: true,
      username: boot.username,
      role: boot.role === "member" ? "member" : "owner",
      expiresAt: boot.expiresAt,
      features: boot.features,
      memberRuntime: boot.memberRuntime ?? "",
    });
    optimistic = true;
    setCacheOwner(boot.username);
  }

  function apply(result: BootstrapResponse) {
    const authenticated = result.authenticated && !!result.session && Number.isFinite(result.session.expiresAt) && result.session.expiresAt > now();
    state.loaded = true;
    state.features = result.features;
    state.authenticated = authenticated;
    state.username = authenticated ? result.session!.username : "";
    state.role = authenticated && result.session!.role === "member" ? "member" : "owner";
    state.expiresAt = authenticated ? result.session!.expiresAt : 0;
    setCacheOwner(state.username);
  }

  /**
   * A running member's data requests relay to their own runtime, whose features
   * (QQ management, no accounts) replace the parent's for navigation.
   */
  async function resolveMember(current: number) {
    if (!state.authenticated || state.role !== "member" || !state.features.accounts) {
      state.memberRuntime = "";
      return;
    }
    try {
      const { runtime } = await api<{ runtime: { state: string } }>("/yesimbot/account/runtime", undefined, {}, fetcher);
      if (current !== generation) return;
      if (runtime.state !== "running") {
        state.memberRuntime = "unavailable";
        return;
      }
      const { features } = await api<{ features: WebUIFeatures }>("/yesimbot/api/v1/features", undefined, {}, fetcher);
      if (current !== generation) return;
      state.features = features;
      state.memberRuntime = "running";
    } catch {
      if (current === generation) state.memberRuntime = "unavailable";
    }
  }

  function refresh(): Promise<boolean> {
    if (pending) return pending;
    const current = generation;
    const request = api<BootstrapResponse>("/yesimbot/api/v1/bootstrap", undefined, {}, fetcher)
      .then(async (result) => {
        if (current === generation) {
          apply(result);
          await resolveMember(current);
          if (remember && current === generation) writeBoot(state);
        }
        return state.authenticated;
      })
      .catch(() => {
        if (current === generation) {
          state.loaded = true;
          invalidate();
        }
        return false;
      })
      .finally(() => {
        if (pending === request) pending = undefined;
      });
    pending = request;
    return request;
  }

  function invalidate() {
    generation++;
    optimistic = false;
    if (remember) writeBoot(undefined);
    state.authenticated = false;
    state.username = "";
    state.expiresAt = 0;
    state.role = "owner";
    state.features = { napcat: false, wechat: false, accounts: false, tenant: false, usage: false };
    state.memberRuntime = "";
  }

  /** Synchronous after the first bootstrap; never waits on the network for warm navigation. */
  function ensure(): boolean | Promise<boolean> {
    if (!state.loaded) return refresh();
    if (state.authenticated && state.expiresAt <= now()) invalidate();
    return state.authenticated;
  }

  async function login(username: string, password: string): Promise<void> {
    await api("/yesimbot/admin/login", { ...(username ? { username } : {}), password }, { allowUnauthorized: true }, fetcher);
    generation++;
    pending = undefined;
    await refresh();
    if (!state.authenticated) throw new ApiError(401, "login_failed");
  }

  async function logout(): Promise<void> {
    try {
      await api("/yesimbot/admin/logout", {}, { allowUnauthorized: true }, fetcher);
    } finally {
      invalidate();
      clearCaches();
    }
  }

  /** After an optimistic start: confirms the session with the server once. */
  function verify(): Promise<boolean> | undefined {
    if (!optimistic) return;
    optimistic = false;
    return refresh();
  }

  return { state, refresh, ensure, invalidate, login, logout, verify };
}

export type Session = ReturnType<typeof createSession>;

/** Only same-app absolute paths; anything else falls back to the overview. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value) || value.startsWith("/login"))
    return "/";
  return value;
}

import { scrypt as scryptCallback } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { newSecret, safeEqual, systemClock, type Clock } from "@yesimbot/foundation";

import type { AccountStore } from "./accounts.js";
import type { Host } from "./host.js";

const scrypt = promisify(scryptCallback);

const COOKIE = "yesimbot_admin";
export interface AdminAuthConfig {
  enabled: boolean;
  credentialFile: string;
  sessionHours: number;
  publicOrigin?: string;
  additionalOrigins?: string[];
}

export interface AdminSession {
  username: string;
  expiresAt: number;
  role?: "owner" | "member";
  accountId?: string;
  version?: number;
}

export interface AdminHttpContext {
  get(name: string): string;
  origin: string;
  secure: boolean;
  status: number;
  body: unknown;
  set(name: string, value: string): void;
}

export class AdminAuth {
  accounts?: AccountStore;
  private revocationListeners = new Set<() => void>();
  onRevocation(listener: () => void) {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }
  revokeAccount(id: string) {
    for (const [token, session] of this.sessions) if (session.accountId === id) this.sessions.delete(token);
    this.notifyRevocation();
  }
  private notifyRevocation() {
    for (const listener of this.revocationListeners) listener();
  }
  async ownerUsername(): Promise<string> {
    const credential = JSON.parse(await readFile(this.credentialFile, "utf8"));
    if (typeof credential.username !== "string" || !credential.username) throw new Error("owner_unavailable");
    return credential.username;
  }
  private publicOrigin?: string;
  private allowedOrigins = new Set<string>();
  private sessions = new Map<string, AdminSession>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(
    readonly config: AdminAuthConfig,
    private credentialFile: string,
    readonly clock: Clock = systemClock(),
  ) {
    const parseOrigin = (value: string, field: string): string => {
      const origin = new URL(value);
      if (
        !/^https?:\/\/[^/?#\\\s*@]+\/?$/i.test(value) ||
        !["http:", "https:"].includes(origin.protocol) ||
        origin.hostname.includes("*") ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw new Error(`Administrator ${field} must be an HTTP(S) origin.`);
      return origin.origin;
    };
    if (config.publicOrigin) {
      this.publicOrigin = parseOrigin(config.publicOrigin, "publicOrigin");
      this.allowedOrigins.add(this.publicOrigin);
    }
    if (config.additionalOrigins?.length && !this.publicOrigin) throw new Error("Administrator additionalOrigins requires an explicit publicOrigin.");
    for (const origin of config.additionalOrigins ?? []) this.allowedOrigins.add(parseOrigin(origin, "additionalOrigins"));
  }

  sessionFromCookie(cookie = ""): AdminSession | undefined {
    const token = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (!token) return;
    const session = this.sessions.get(token);
    if (session && session.expiresAt > this.clock.now()) {
      const member = session.role === "member" ? this.accounts?.get(session.accountId!) : undefined;
      if (session.role !== "member" || (member?.enabled && member.version === session.version)) return session;
    }
    this.sessions.delete(token);
  }

  sameOrigin(http: AdminHttpContext): boolean {
    const origin = http.get("origin");
    return !!origin && (this.publicOrigin ? this.allowedOrigins.has(origin) : origin === http.origin) && http.get("sec-fetch-site") !== "cross-site";
  }

  secureCookie(http: AdminHttpContext): boolean {
    // An explicit alias chooses its own cookie scheme even when TLS terminates upstream.
    const origin = http.get("origin");
    if (this.allowedOrigins.has(origin)) return origin.startsWith("https://");
    return this.publicOrigin ? this.publicOrigin.startsWith("https://") : http.secure;
  }

  requireOwner(http: AdminHttpContext): boolean {
    http.set("Cache-Control", "no-store");
    const session = this.sessionFromCookie(http.get("cookie"));
    if (this.config.enabled && session && session.role !== "member") return true;
    if (session?.role === "member") {
      http.status = 403;
      http.body = { message: "Owner access required." };
      return false;
    }
    http.status = 401;
    http.body = { message: "Administrator login required." };
    return false;
  }

  retryAfterSeconds(): number {
    const rate = this.attempts.get("login");
    return rate && rate.count >= 10 ? Math.max(0, Math.ceil((rate.until - this.clock.now()) / 1000)) : 0;
  }

  async login(username: unknown, password: unknown): Promise<string | undefined> {
    if (!this.config.enabled || typeof password !== "string" || !password || password.length > 4096) return;
    // Bound expensive password checks and memory even when requests have no trusted IP.
    const rate = this.attempts.get("login");
    if (this.retryAfterSeconds()) return;
    this.attempts.set("login", {
      count: rate && rate.until > this.clock.now() ? rate.count + 1 : 1,
      until: rate && rate.until > this.clock.now() ? rate.until : this.clock.now() + 60_000,
    });
    try {
      const member = await this.accounts?.authenticate(username, password);
      if (member) return this.issue({ username: member.username, role: "member", accountId: member.id, version: member.version });
      const credential = JSON.parse(await readFile(this.credentialFile, "utf8"));
      if (
        credential.version !== 1 ||
        typeof credential.username !== "string" ||
        !credential.username ||
        typeof credential.salt !== "string" ||
        typeof credential.hash !== "string"
      )
        return;
      const salt = Buffer.from(credential.salt, "base64");
      const hash = Buffer.from(credential.hash, "base64");
      if (salt.length !== 16 || hash.length !== 64) return;
      const actual = (await scrypt(password, salt, 64)) as Buffer;
      if (!safeEqual(actual.toString("base64"), hash.toString("base64")) || (username !== undefined && username !== credential.username)) return;
      return this.issue({ username: credential.username, role: "owner", accountId: "owner" });
    } catch {
      return;
    }
  }

  private issue(identity: Omit<AdminSession, "expiresAt">): string {
    this.attempts.clear();
    for (const [token, session] of this.sessions) if (session.expiresAt <= this.clock.now()) this.sessions.delete(token);
    if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value!);
    const token = newSecret(32);
    const hours = Math.min(168, Math.max(1, Number.isFinite(this.config.sessionHours) ? this.config.sessionHours : 12));
    this.sessions.set(token, { ...identity, expiresAt: this.clock.now() + hours * 3600_000 });
    return token;
  }

  logout(cookie: string): void {
    const token = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    if (token) this.sessions.delete(token);
    this.notifyRevocation();
  }

  clear(): void {
    this.sessions.clear();
    this.notifyRevocation();
    this.attempts.clear();
  }
}

export function installAdminAuth(ctx: Host, config: AdminAuthConfig, options: { onLogout?: () => void } = {}): AdminAuth {
  const auth = new AdminAuth(config, resolve(ctx.baseDir, config.credentialFile), ctx.clock);
  if (!config.enabled) {
    ctx.server.get("/yesimbot/admin/session", (http) => {
      http.set("Cache-Control", "no-store");
      http.body = { enabled: false, authenticated: false };
    });
    return auth;
  }
  const status = (http: AdminHttpContext) => {
    http.set("Cache-Control", "no-store");
    const session = auth.sessionFromCookie(http.get("cookie"));
    return { enabled: true, authenticated: !!session, ...publicSession(session) };
  };
  ctx.server.get("/yesimbot/admin/session", (http) => {
    http.body = status(http);
  });
  ctx.server.post("/yesimbot/admin/login", async (http) => {
    http.set("Cache-Control", "no-store");
    if (!auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { message: "Same-origin request required." };
      return;
    }
    let body: { username?: unknown; password?: unknown };
    try {
      body = await readAdminLoginBody(http);
    } catch {
      http.status = 400;
      http.body = { message: "Login requires a JSON object no larger than 8 KiB." };
      return;
    }
    const retryAfterSeconds = auth.retryAfterSeconds();
    if (retryAfterSeconds) {
      http.status = 429;
      http.set("Retry-After", String(retryAfterSeconds));
      http.body = { message: "Login temporarily limited. Try again later.", retryAfterSeconds };
      return;
    }
    const token = await auth.login(body?.username, body?.password);
    if (!token) {
      http.status = 401;
      http.body = { message: "Invalid administrator credentials." };
      return;
    }
    auth.logout(http.get("cookie"));
    const session = auth.sessionFromCookie(`${COOKIE}=${token}`)!;
    http.set(
      "Set-Cookie",
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((session.expiresAt - auth.clock.now()) / 1000)}${auth.secureCookie(http) ? "; Secure" : ""}`,
    );
    http.body = { enabled: true, authenticated: true, ...publicSession(session) };
  });
  ctx.server.post("/yesimbot/admin/logout", (http) => {
    if (!auth.sameOrigin(http)) {
      http.status = 403;
      http.body = { message: "Same-origin request required." };
      return;
    }
    auth.logout(http.get("cookie"));
    http.set("Cache-Control", "no-store");
    http.set("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${auth.secureCookie(http) ? "; Secure" : ""}`);
    http.body = { enabled: true, authenticated: false };
    options.onLogout?.();
  });
  ctx.on("dispose", () => auth.clear());
  return auth;
}

export async function readAdminLoginBody(
  http: {
    get(name: string): string;
    request: object;
    req: IncomingMessage;
  },
  limit = 8192,
): Promise<{ username?: unknown; password?: unknown }> {
  if (http.get("content-type").split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new Error("Invalid content type");
  let value = (http.request as { body?: unknown }).body;
  if (value === undefined) {
    const length = http.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error("Body too large");
    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const cleanup = () => {
        clearTimeout(timer);
        http.req.off("data", data);
        http.req.off("end", end);
        http.req.off("error", fail);
        http.req.off("aborted", aborted);
      };
      const fail = () => {
        cleanup();
        http.req.resume();
        reject(new Error("Invalid body"));
      };
      const aborted = () => fail();
      const data = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit) {
          fail();
          return;
        }
        chunks.push(buffer);
      };
      const end = () => {
        cleanup();
        resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const timer = setTimeout(fail, 10_000);
      http.req.on("data", data);
      http.req.once("end", end);
      http.req.once("error", fail);
      http.req.once("aborted", aborted);
    });
    value = JSON.parse(raw);
  } else if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new Error("Body too large");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid login body");
  return value;
}

function publicSession(session?: AdminSession) {
  return session && { username: session.username, expiresAt: session.expiresAt, role: session.role ?? "owner", accountId: session.accountId ?? "owner" };
}

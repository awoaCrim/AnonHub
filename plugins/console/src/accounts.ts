import { scrypt as derive } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { newId, newSecret, safeEqual, systemClock, writeFileAtomic, type Clock } from "@yesimbot/foundation";

import { readAdminLoginBody, type AdminAuth } from "./admin-auth.js";
import type { Host, HttpContext } from "./host.js";
import type { AccountView, RuntimeView } from "./shared/accounts.js";
import { OPTIONAL_MEMBER_PLUGIN_NAMES, normalizeMemberPlugins } from "./shared/plugin-catalog.js";
import type { TenantManagerClient } from "./tenant-manager-client.js";

export const memberId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const scrypt = promisify(derive);

export interface AccountsConfig {
  enabled: boolean;
  usersFile: string;
  managerEndpoint: string;
  managerKeyFile: string;
  ownerRuntimeId?: string;
  ownerOneBotPath?: string;
}

export interface MemberAccount {
  id: string;
  username: string;
  enabled: boolean;
  createdAt: string;
  version: number;
  salt: string;
  hash: string;
  /** Absent in registries written before plugin grants; treated as every optional plugin. */
  plugins?: string[];
}

/** One process owns this registry. Writes serialize and publish only after atomic rename. */
export class AccountStore {
  private accounts: MemberAccount[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  constructor(
    readonly file: string,
    private ownerName: () => Promise<string>,
    private readonly clock: Clock = systemClock(),
  ) {
    this.ready = this.load();
  }
  private async load() {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error("unsafe_account_registry");
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error("invalid_account_registry");
      const ids = new Set<string>(),
        names = new Set<string>();
      for (const a of data.accounts) {
        if (
          !memberId.test(a.id) ||
          normalizeUsername(a.username) !== a.username ||
          typeof a.enabled !== "boolean" ||
          !Number.isSafeInteger(a.version) ||
          a.version < 1 ||
          !Number.isFinite(Date.parse(a.createdAt)) ||
          Buffer.from(a.salt, "base64").length !== 16 ||
          Buffer.from(a.hash, "base64").length !== 64 ||
          ids.has(a.id) ||
          names.has(a.username) ||
          (a.plugins !== undefined && !validPlugins(a.plugins))
        )
          throw new Error("invalid_account_registry");
        ids.add(a.id);
        names.add(a.username);
      }
      this.accounts = data.accounts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  get(id: string) {
    const a = this.accounts.find((a) => a.id === id);
    return a && clone(a);
  }
  list() {
    return this.accounts.map(clone);
  }
  async authenticate(username: unknown, password: string) {
    await this.ready;
    let name: string;
    try {
      name = normalizeUsername(username);
    } catch {
      return;
    }
    const a = this.accounts.find((a) => a.username === name && a.enabled);
    if (!a) return;
    const version = a.version;
    const hash = (await scrypt(password, Buffer.from(a.salt, "base64"), 64)) as Buffer;
    // A revocation already queued while password hashing was running must commit first.
    await this.queue;
    const current = this.get(a.id);
    if (current?.enabled && current.version === version && safeEqual(hash.toString("base64"), Buffer.from(a.hash, "base64").toString("base64"))) return current;
  }
  private mutate<T>(operation: (accounts: MemberAccount[]) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      await this.ready;
      const accounts = this.list();
      const result = await operation(accounts);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
      this.accounts = accounts;
      return result;
    });
    this.queue = result.catch(() => {});
    return result;
  }
  create(username: unknown, password: unknown, plugins: unknown = OPTIONAL_MEMBER_PLUGIN_NAMES) {
    return this.mutate(async (accounts) => {
      const name = normalizeUsername(username);
      validatePassword(password);
      const granted = normalizeMemberPlugins(plugins);
      if (name === (await this.ownerName()).toLowerCase() || accounts.some((a) => a.username === name)) throw new Error("username_unavailable");
      const salt = Buffer.from(newSecret(16), "base64url"),
        hash = (await scrypt(password, salt, 64)) as Buffer;
      const account: MemberAccount = {
        id: newId(),
        username: name,
        enabled: true,
        createdAt: new Date(this.clock.now()).toISOString(),
        version: 1,
        salt: salt.toString("base64"),
        hash: hash.toString("base64"),
        plugins: granted,
      };
      accounts.push(account);
      return clone(account);
    });
  }
  update(id: string, change: { enabled: boolean } | { password: string }) {
    return this.mutate(async (accounts) => {
      const a = accounts.find((a) => a.id === id);
      if (!a || !memberId.test(id)) throw new Error("account_not_found");
      if ("password" in change) {
        validatePassword(change.password);
        const salt = Buffer.from(newSecret(16), "base64url");
        a.hash = ((await scrypt(change.password, salt, 64)) as Buffer).toString("base64");
        a.salt = salt.toString("base64");
      } else {
        if (typeof change.enabled !== "boolean") throw new Error("invalid_enabled");
        a.enabled = change.enabled;
      }
      a.version++;
      return clone(a);
    });
  }
  remove(id: string) {
    return this.mutate(async (accounts) => {
      const index = accounts.findIndex((a) => a.id === id);
      if (index < 0 || !memberId.test(id)) throw new Error("account_not_found");
      return clone(accounts.splice(index, 1)[0]!);
    });
  }
  /** Grants are not credentials: existing sessions stay valid and the version is unchanged. */
  setPlugins(id: string, plugins: unknown) {
    return this.mutate(async (accounts) => {
      const a = accounts.find((a) => a.id === id);
      if (!a || !memberId.test(id)) throw new Error("account_not_found");
      a.plugins = normalizeMemberPlugins(plugins);
      return clone(a);
    });
  }
}

export function installAccountRoutes(ctx: Host, auth: AdminAuth, store: AccountStore, manager: TenantManagerClient) {
  const view = async (a: MemberAccount): Promise<AccountView> => {
    let runtime: RuntimeView;
    try {
      runtime = await manager.runtime(a.id);
    } catch {
      runtime = { id: a.id, state: "error", errorCode: "manager_unavailable" };
    }
    return { id: a.id, username: a.username, enabled: a.enabled, createdAt: a.createdAt, plugins: memberPlugins(a), runtime };
  };
  ctx.server.get("/yesimbot/admin/accounts", async (http) => {
    if (!auth.requireOwner(http)) return;
    try {
      await store.ready;
      http.body = { accounts: await Promise.all(store.list().map(view)) };
    } catch {
      http.status = 503;
      http.body = { message: "account_registry_unavailable" };
    }
  });
  const write =
    (handler: (http: HttpContext, body: Record<string, unknown>) => Promise<void>, owner = true) =>
    async (http: HttpContext) => {
      http.set("Cache-Control", "private, no-store");
      if (owner ? !auth.requireOwner(http) : !auth.sessionFromCookie(http.get("cookie"))) {
        if (!owner) {
          http.status = 401;
          http.body = { message: "Login required." };
        }
        return;
      }
      if (!auth.sameOrigin(http)) {
        http.status = 403;
        http.body = { message: "Same-origin request required." };
        return;
      }
      try {
        await handler(http, (await readAdminLoginBody(http)) as Record<string, unknown>);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        http.status = /^(invalid_|username_unavailable|account_not_found)/.test(code) ? 400 : 503;
        http.body = { message: http.status === 400 ? code : "runtime_operation_failed" };
      }
    };
  ctx.server.post(
    "/yesimbot/admin/accounts",
    write(async (http, body) => {
      // Validate optional setup input before persisting the new identity.
      if (body.qqAccount !== undefined && (typeof body.qqAccount !== "string" || !/^[1-9][0-9]{4,11}$/.test(body.qqAccount)))
        throw new Error("invalid_qq_account");
      const account = await store.create(body.username, body.password, body.plugins ?? OPTIONAL_MEMBER_PLUGIN_NAMES);
      try {
        await manager.runtime(account.id, "register", body.qqAccount, memberPlugins(account));
      } catch {
        /* Identity remains available for safe setup retry. */
      }
      http.body = { account: await view(account) };
    }),
  );
  for (const action of ["enabled", "password"] as const)
    ctx.server.post(
      `/yesimbot/admin/accounts/:id/${action}`,
      write(async (http, body) => {
        const account = await store.update(http.params.id, action === "enabled" ? { enabled: body.enabled as boolean } : { password: body.password as string });
        auth.revokeAccount(account.id);
        let stopFailed = false;
        if (!account.enabled) {
          try {
            await manager.runtime(account.id, "stop");
          } catch {
            stopFailed = true;
          }
        }
        http.body = { account: await view(account), ...(stopFailed ? { message: "runtime_stop_failed_access_revoked" } : {}) };
      }),
    );
  ctx.server.post(
    "/yesimbot/admin/accounts/:id/delete",
    write(async (http, body) => {
      await store.ready;
      const account = store.list().find((a) => a.id === http.params.id);
      if (!account) throw new Error("account_not_found");
      // The friend's name typed back is the confirmation; nothing is deleted on a mismatch.
      if (typeof body.username !== "string" || normalizeUsername(body.username) !== account.username) throw new Error("invalid_confirmation");
      // The manager goes first: if it cannot take the deletion, the friend stays as they were.
      await manager.remove(account.id);
      await store.remove(account.id);
      auth.revokeAccount(account.id);
      http.body = { deleted: true };
    }),
  );
  ctx.server.post(
    "/yesimbot/admin/accounts/:id/plugins",
    write(async (http, body) => {
      const account = await store.setPlugins(http.params.id, body.plugins);
      let synced = true;
      try {
        // The member runtime polls its read-only policy file; no restart or session revocation.
        await manager.runtime(account.id, "register", undefined, memberPlugins(account));
      } catch {
        synced = false;
      }
      http.body = { account: await view(account), ...(synced ? {} : { message: "runtime_policy_sync_failed" }) };
    }),
  );
  ctx.server.get("/yesimbot/account/runtime", async (http) => {
    http.set("Cache-Control", "private, no-store");
    const session = auth.sessionFromCookie(http.get("cookie"));
    if (session?.role !== "member") {
      http.status = session ? 403 : 401;
      http.body = { message: "Member login required." };
      return;
    }
    try {
      http.body = { runtime: await manager.runtime(session.accountId!) };
    } catch {
      http.status = 503;
      http.body = { runtime: { id: session.accountId, state: "error", errorCode: "manager_unavailable" } };
    }
  });
  ctx.server.post(
    "/yesimbot/account/runtime/start",
    write(async (http, body) => {
      const session = auth.sessionFromCookie(http.get("cookie"));
      if (session?.role !== "member") {
        http.status = 403;
        http.body = { message: "Member login required." };
        return;
      }
      // Creation may have persisted the identity while the manager was unavailable.
      // Register the session-selected UUID idempotently before attempting its first start.
      const account = store.get(session.accountId!);
      if (!account) throw new Error("account_not_found");
      await manager.runtime(session.accountId!, "register", body.qqAccount, memberPlugins(account));
      if (auth.sessionFromCookie(http.get("cookie")) !== session) {
        http.status = 401;
        http.body = { message: "Login required." };
        return;
      }
      http.body = { runtime: await manager.runtime(session.accountId!, "start", body.qqAccount) };
    }, false),
  );
}

export function memberPlugins(account: MemberAccount): string[] {
  return account.plugins ? [...account.plugins] : [...OPTIONAL_MEMBER_PLUGIN_NAMES];
}

export function normalizeUsername(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{3,32}$/.test(value)) throw new Error("invalid_username");
  return value.toLowerCase();
}

export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 4096) throw new Error("invalid_password");
}

function clone(a: MemberAccount): MemberAccount {
  return { ...a, ...(a.plugins ? { plugins: [...a.plugins] } : {}) };
}

function validPlugins(value: unknown) {
  try {
    normalizeMemberPlugins(value);
    return true;
  } catch {
    return false;
  }
}

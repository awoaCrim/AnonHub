import type { AccountStore } from "../accounts.js";
import type { AdminAuth, AdminSession } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { AccountHealth, AccountsHealthResponse, BotSummary, OpsSnapshot } from "../shared/accounts.js";
import type { TenantManagerClient } from "../tenant-manager-client.js";

/** Under `/yesimbot/admin`, which the tenant proxy reserves for the parent: members never reach it. */
export const ACCOUNTS_HEALTH_PATH = "/yesimbot/admin/accounts/health";
const CONCURRENCY = 4;
const TIMEOUT_MS = 4_000;
const CACHE_MS = 15_000;

type Manager = Pick<TenantManagerClient, "runtime" | "summary"> & Partial<Pick<TenantManagerClient, "ops">>;

/**
 * Owner-only health of every member bot. One slow or stopped runtime marks only its own row unknown.
 */
export function installAccountsHealth(
  ctx: Host,
  auth: AdminAuth,
  store: Pick<AccountStore, "ready" | "list">,
  manager: Manager,
  own: (session: AdminSession) => Promise<BotSummary | null>,
) {
  let cached: { at: number; value: Promise<AccountsHealthResponse> } | undefined;
  ctx.server.get(ACCOUNTS_HEALTH_PATH, async (http) => {
    http.set("Cache-Control", "private, no-store");
    if (!auth.requireOwner(http)) return;
    if (!cached || ctx.clock.now() - cached.at > CACHE_MS || http.query.refresh === "1") {
      const session = auth.sessionFromCookie(http.get("cookie"))!;
      const value = collectHealth(store, manager, () => own(session));
      cached = { at: ctx.clock.now(), value };
      value.catch(() => (cached = undefined));
    }
    try {
      http.body = await cached.value;
    } catch {
      http.status = 503;
      http.body = { message: "account_registry_unavailable" };
    }
  });
}

export async function collectHealth(
  store: Pick<AccountStore, "ready" | "list">,
  manager: Manager,
  own: () => Promise<BotSummary | null>,
  timeoutMs = TIMEOUT_MS,
): Promise<AccountsHealthResponse> {
  await store.ready;
  const accounts = store.list();
  const results: AccountHealth[] = new Array(accounts.length);
  let next = 0;
  const worker = async () => {
    while (next < accounts.length) {
      const index = next++;
      results[index] = await accountHealth(accounts[index].id, accounts[index].enabled, manager, timeoutMs);
    }
  };
  // Container state is read in parallel; an unreachable manager leaves `ops` null and the rest as it was.
  const ops: Promise<OpsSnapshot | null> = manager.ops ? withTimeout(manager.ops(timeoutMs), timeoutMs + 500).catch(() => null) : Promise.resolve(null);
  const [owner, snapshot] = await Promise.all([own().catch(() => null), ops, ...Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker)]);
  return { generatedAt: new Date().toISOString(), owner, accounts: results, ops: snapshot };
}

async function accountHealth(id: string, enabled: boolean, manager: Manager, timeoutMs: number): Promise<AccountHealth> {
  if (!enabled) return { id, health: null, error: "not_running" };
  try {
    const runtime = await withTimeout(manager.runtime(id), timeoutMs);
    if (runtime.state !== "running") return { id, health: null, error: "not_running" };
    return { id, health: await manager.summary(id, timeoutMs) };
  } catch (error) {
    return { id, health: null, error: (error as Error)?.name === "TimeoutError" || (error as Error)?.message === "timeout" ? "timeout" : "unreachable" };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

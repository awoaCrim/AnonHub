import type { UsagePayload } from "@yesimbot/contracts";

import type { AccountStore } from "../accounts.js";
import type { AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { AccountsUsageResponse } from "../shared/accounts-usage.js";
import type { TenantManagerClient } from "../tenant-manager-client.js";
import type { TopicRegistry } from "./topics.js";

export const ACCOUNTS_USAGE_PATH = "/yesimbot/admin/accounts/usage";

export async function collectAccountsUsage(
  store: Pick<AccountStore, "ready" | "list">,
  manager: Pick<TenantManagerClient, "usage">,
): Promise<AccountsUsageResponse> {
  await store.ready;
  const accounts = store.list();
  const rows: AccountsUsageResponse["accounts"] = new Array(accounts.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, accounts.length) }, async () => {
      while (next < accounts.length) {
        const index = next++;
        const { id, username } = accounts[index];
        // A stopped instance is unknown, never a fabricated zero. Disabled accounts
        // still belong in the administrator's usage overview.
        const usage = await manager.usage(id).catch(() => null);
        rows[index] = { id, username, usage };
      }
    }),
  );
  return { accounts: rows };
}

/** Parent-only route: ordinary accounts cannot select another runtime. */
export function installAccountsUsage(ctx: Host, auth: AdminAuth, store: AccountStore, manager: TenantManagerClient) {
  let cached: { at: number; value: Promise<AccountsUsageResponse> } | undefined;
  ctx.server.get(ACCOUNTS_USAGE_PATH, async (http) => {
    http.set("Cache-Control", "private, no-store");
    if (!auth.requireOwner(http)) return;
    const session = auth.sessionFromCookie(http.get("cookie"));
    if (!cached || ctx.clock.now() - cached.at >= 15_000) {
      const value = collectAccountsUsage(store, manager);
      cached = { at: ctx.clock.now(), value };
      value.catch(() => {
        if (cached?.value === value) cached = undefined;
      });
    }
    try {
      const data = await cached.value;
      if (auth.sessionFromCookie(http.get("cookie")) !== session) {
        http.status = 401;
        return;
      }
      http.body = data;
    } catch {
      http.status = 503;
      http.body = { message: "usage_unavailable" };
    }
  });
}

/** The existing tenant relay pins this read to the authenticated account's runtime. */
export function installUsageRead(ctx: Host, auth: AdminAuth, topics: TopicRegistry) {
  ctx.server.get("/yesimbot/api/v1/usage", async (http) => {
    http.set("Cache-Control", "private, no-store");
    const session = auth.sessionFromCookie(http.get("cookie"));
    if (!session) {
      http.status = 401;
      return;
    }
    const topic = topics.get("usage");
    if (!topic?.authorize(session)) {
      http.status = 403;
      return;
    }
    const data = (await topic.get(session)) as UsagePayload;
    if (auth.sessionFromCookie(http.get("cookie")) !== session) {
      http.status = 401;
      return;
    }
    http.body = data;
  });
}

import { expect, it, vi } from "vitest";

import type { AdminHttpContext } from "../src/admin-auth";
import { collectAccountsUsage, installAccountsUsage, installUsageRead } from "../src/webui/accounts-usage";
import { TopicRegistry } from "../src/webui/topics";

interface UsageHttp extends Pick<AdminHttpContext, "set" | "get" | "body"> {
  query: Record<string, string>;
  status?: number;
}

it("collects every account including disabled ones, bounds concurrency and preserves failures as unknown", async () => {
  let active = 0,
    peak = 0;
  const usage = vi.fn(async (id: string) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    if (id === "3") throw new Error("offline");
    return { today: { calls: Number(id) } } as never;
  });
  const accounts = Array.from({ length: 9 }, (_, i) => ({ id: String(i), username: `user${i}`, enabled: i !== 2 }));
  const result = await collectAccountsUsage({ ready: Promise.resolve(), list: () => accounts } as never, { usage });
  expect(peak).toBeLessThanOrEqual(4);
  expect(result.accounts).toHaveLength(9);
  expect(result.accounts[2]).toMatchObject({ username: "user2", usage: { today: { calls: 2 } } });
  expect(result.accounts[3].usage).toBeNull();
});

it("rejects member enumeration before any registry or manager access", async () => {
  let route!: (http: Pick<AdminHttpContext, "set" | "status">) => Promise<void>;
  const store = { list: vi.fn() },
    manager = { usage: vi.fn() };
  const auth = {
    requireOwner: (http: Pick<AdminHttpContext, "status">) => {
      http.status = 403;
      return false;
    },
  };
  installAccountsUsage({ server: { get: (_: string, fn: typeof route) => (route = fn) } } as never, auth as never, store as never, manager as never);
  const http = { set: vi.fn(), status: 200 };
  await route(http);
  expect(http.status).toBe(403);
  expect(store.list).not.toHaveBeenCalled();
  expect(manager.usage).not.toHaveBeenCalled();
});

it("reads only the local authorized usage topic, ignoring requested user IDs", async () => {
  let route!: (http: UsageHttp) => Promise<void>;
  const session = { role: "owner" };
  const topics = new TopicRegistry();
  const get = vi.fn(async () => ({ today: { calls: 8 } }));
  topics.register({ name: "usage", authorize: (s) => s === session, get, subscribe: () => () => {} });
  const auth = { sessionFromCookie: () => session };
  installUsageRead({ server: { get: (_: string, fn: typeof route) => (route = fn) } } as never, auth as never, topics);
  const http: UsageHttp = { set: vi.fn(), get: () => "cookie", query: { accountId: "someone-else" }, body: undefined };
  await route(http);
  expect(get).toHaveBeenCalledWith(session);
  expect(http.body).toEqual({ today: { calls: 8 } });
});

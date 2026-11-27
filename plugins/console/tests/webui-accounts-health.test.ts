import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemClock } from "@yesimbot/foundation";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelPayload } from "../src/shared/panel";
import { TenantManagerClient } from "../src/tenant-manager-client";
import { ACCOUNTS_HEALTH_PATH, collectHealth, installAccountsHealth } from "../src/webui/accounts-health";
import { projectSummary } from "../src/webui/summary";

const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
const summary = { qqOnline: true, modelReady: true, roleReady: null, allowedChannels: 2, todayCalls: 5, lastActivityAt: 1, attention: 0 };

afterEach(() => vi.unstubAllGlobals());

describe("projectSummary", () => {
  it("maps panel, usage and history and keeps unknown sources null", () => {
    const panel = {
      adapters: [{ platform: "onebot", state: "online" }],
      config: { allowedChannels: 3 },
      attention: [{ message: "小黑盒需要重新验证" }, { message: "模型额度不足" }],
      onboarding: {
        steps: [
          { id: "model", done: true },
          { id: "role", done: false },
        ],
      },
      model: { chatModel: "gemini-3.8-flash" },
      plugins: [
        { label: "角色扮演", enabled: true },
        { label: "记忆", enabled: false },
      ],
      recent: [{}],
      health: { uptimeSeconds: 3600 },
    } as unknown as PanelPayload;
    const history = {
      channels: [
        { lastActivityAt: 5, type: "guild", channelId: "100" },
        { lastActivityAt: null, type: "direct", channelId: "private:1" },
        { lastActivityAt: 9, type: "direct", channelId: "private:2" },
      ],
    };
    expect(projectSummary(panel, { today: { calls: 7, inputTokens: 100, outputTokens: 20 } }, history, 99)).toEqual({
      qqOnline: true,
      modelReady: true,
      roleReady: false,
      allowedChannels: 3,
      todayCalls: 7,
      lastActivityAt: 9,
      attention: 2,
      chatModel: "gemini-3.8-flash",
      todayTokens: 120,
      plugins: ["角色扮演"],
      issues: ["小黑盒需要重新验证", "模型额度不足"],
      failures: 1,
      conversations: 3,
      uptimeSeconds: 3600,
      recent: [
        { type: "direct", channelId: "private:2", at: 9 },
        { type: "guild", channelId: "100", at: 5 },
      ],
    });
    // Without the usage plugin, the console's own count supplies today's calls.
    expect(projectSummary(panel, undefined, history, 4)).toMatchObject({ todayCalls: 4, todayTokens: null });
    expect(projectSummary(undefined, undefined, undefined)).toEqual({
      qqOnline: null,
      modelReady: null,
      roleReady: null,
      allowedChannels: null,
      todayCalls: null,
      lastActivityAt: null,
      attention: null,
      chatModel: null,
      todayTokens: null,
      failures: null,
      conversations: null,
      uptimeSeconds: null,
    });
    // An empty history is a real "no activity", not unknown.
    expect(projectSummary(undefined, undefined, { channels: [] }).lastActivityAt).toBeNull();
  });
});

describe("collectHealth", () => {
  const store = (enabled = [true, true, false, true, true, true]) => ({
    ready: Promise.resolve(),
    list: () => ids.map((id, i) => ({ id, enabled: enabled[i] })) as never,
  });

  it("marks only the failing rows unknown and bounds concurrency", async () => {
    let active = 0,
      peak = 0;
    const manager = {
      runtime: vi.fn(async (id: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (id === ids[1]) return { id, state: "stopped" as const };
        if (id === ids[3]) return new Promise<never>(() => {});
        if (id === ids[4]) throw new Error("manager_unavailable");
        return { id, state: "running" as const };
      }),
      summary: vi.fn(async () => summary),
    };
    const result = await collectHealth(store(), manager as never, async () => summary, 50);
    expect(result.owner).toEqual(summary);
    expect(result.accounts.map((row) => [row.id, row.error ?? "ok"])).toEqual([
      [ids[0], "ok"],
      [ids[1], "not_running"],
      [ids[2], "not_running"],
      [ids[3], "timeout"],
      [ids[4], "unreachable"],
      [ids[5], "ok"],
    ]);
    expect(manager.runtime).not.toHaveBeenCalledWith(ids[2]);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("adds the manager's container view, and a manager that cannot be read costs only that", async () => {
    const snapshot = { owner: { target: "owner" }, accounts: { [ids[0]]: { target: ids[0] } } };
    const base = { runtime: async (id: string) => ({ id, state: "running" as const }), summary: async () => summary };
    const withOps = await collectHealth(store([true]), { ...base, ops: async () => snapshot } as never, async () => summary);
    expect(withOps.ops).toEqual(snapshot);
    const failing = await collectHealth(store([true]), { ...base, ops: async () => Promise.reject(new Error("down")) } as never, async () => summary);
    expect(failing.ops).toBeNull();
    expect(failing.accounts[0].health).toEqual(summary);
    expect(failing.owner).toEqual(summary);
    expect((await collectHealth(store([true]), base as never, async () => summary)).ops).toBeNull();
    const slow = await collectHealth(store([true]), { ...base, ops: () => new Promise<never>(() => {}) } as never, async () => summary, 30);
    expect(slow.ops).toBeNull();
  });

  it("keeps the list when the owner's own summary fails", async () => {
    const manager = { runtime: async (id: string) => ({ id, state: "running" as const }), summary: async () => summary };
    const result = await collectHealth(store([true]), manager as never, async () => Promise.reject(new Error("x")));
    expect(result.owner).toBeNull();
    expect(result.accounts[0].health).toEqual(summary);
  });
});

describe("health route", () => {
  function setup(role: "owner" | "member" | undefined) {
    let handler: Function | undefined;
    const ctx = { clock: systemClock(), server: { get: (path: string, cb: Function) => path === ACCOUNTS_HEALTH_PATH && (handler = cb) } };
    const auth = {
      requireOwner: (http: { status: number }) => {
        if (role === "owner") return true;
        http.status = role ? 403 : 401;
        return false;
      },
      sessionFromCookie: () => (role ? { username: "u", role } : undefined),
    };
    const manager = { runtime: vi.fn(async (id: string) => ({ id, state: "running" as const })), summary: vi.fn(async () => summary) };
    const own = vi.fn(async () => summary);
    installAccountsHealth(ctx as never, auth as never, { ready: Promise.resolve(), list: () => [{ id: ids[0], enabled: true }] as never }, manager, own);
    const call = async (query: Record<string, string> = {}) => {
      const http = { status: 200, body: undefined as unknown, query, set: () => {}, get: () => "" };
      await handler!(http);
      return http;
    };
    return { call, manager, own };
  }

  it("is owner-only", async () => {
    expect((await setup("member").call()).status).toBe(403);
    expect((await setup(undefined).call()).status).toBe(401);
  });

  it("caches briefly and refreshes on demand", async () => {
    const { call, manager, own } = setup("owner");
    const first = await call();
    expect(first.body).toMatchObject({ owner: summary, accounts: [{ id: ids[0], health: summary }] });
    await call();
    expect(manager.summary).toHaveBeenCalledTimes(1);
    await call({ refresh: "1" });
    expect(manager.summary).toHaveBeenCalledTimes(2);
    expect(own).toHaveBeenCalledTimes(2);
  });
});

describe("TenantManagerClient.summary", () => {
  it("reads through the manager relay and keeps only known fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "manager-key-"));
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "a".repeat(64));
    chmodSync(keyFile, 0o600);
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...summary,
            todayCalls: -1,
            attention: "x",
            apiKey: "secret",
            config: { a: 1 },
            chatModel: 42,
            plugins: ["角色扮演", 3],
            recent: [{ type: "guild", channelId: "100", at: 5 }, { type: "evil", channelId: "x", at: 1 }, null],
          }),
        ),
    );
    const client = new TenantManagerClient("http://manager.invalid:9000", keyFile, fetcher as never);
    const result = await client.summary(ids[0]);
    expect(result).toEqual({
      ...summary,
      todayCalls: null,
      attention: null,
      chatModel: null,
      todayTokens: null,
      plugins: ["角色扮演"],
      failures: null,
      conversations: null,
      uptimeSeconds: null,
      recent: [{ type: "guild", channelId: "100", at: 5 }],
    });
    expect(result).not.toHaveProperty("apiKey");
    expect(result).not.toHaveProperty("config");
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit & { purpose: string }];
    expect(String(url)).toBe(`http://manager.invalid:9000/v1/runtimes/${ids[0]}/http/yesimbot/api/v1/bot/summary`);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${"a".repeat(64)}` });
    expect(init).toMatchObject({ purpose: "internal" });
  });
});

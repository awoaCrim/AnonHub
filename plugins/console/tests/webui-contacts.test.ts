import { systemClock } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";

import { CONTACTS_PATH, installContacts, listContacts } from "../src/webui/contacts";

function bot(overrides: Record<string, unknown> = {}) {
  return {
    platform: "onebot",
    selfId: "10001",
    status: 1,
    user: { name: "Athena" },
    getGuildList: vi.fn(async () => ({ data: [{ id: "123", name: "测试群" }, { id: "456" }, { id: "123", name: "dup" }] })),
    // The OneBot adapter returns plain users; Satori friends wrap them.
    getFriendList: vi.fn(async () => ({ data: [{ id: "42", name: "Alice" }, { user: { id: "43", name: "Bob" }, nick: "备注" }, {}] })),
    ...overrides,
  };
}

describe("listContacts", () => {
  it("returns channel IDs matching the core allow rules", async () => {
    expect(await listContacts(bot() as never, systemClock())).toEqual({
      platform: "onebot",
      selfId: "10001",
      name: "Athena",
      partial: false,
      contacts: [
        { channelId: "123", name: "测试群", direct: false },
        { channelId: "456", name: "456", direct: false },
        { channelId: "private:42", name: "Alice", direct: true },
        { channelId: "private:43", name: "备注", direct: true },
      ],
    });
  });

  it("uses each platform's direct channel ID", async () => {
    const wechat = bot({
      platform: "wechat-bridge",
      getGuildList: vi.fn(async () => ({ data: [{ id: "1@chatroom" }] })),
      getFriendList: vi.fn(async () => ({ data: [{ user: { id: "wxid_a" } }] })),
    });
    expect((await listContacts(wechat as never, systemClock())).contacts).toEqual([
      { channelId: "1@chatroom", name: "1@chatroom", direct: false },
      { channelId: "wxid_a", name: "wxid_a", direct: true },
    ]);
  });

  it("follows pages and reports partial results on failure, timeout and cap", async () => {
    const paged = bot({
      getGuildList: vi.fn(async (next?: string) => (next ? { data: [{ id: "2" }] } : { data: [{ id: "1" }], next: "p2" })),
      getFriendList: vi.fn(async () => Promise.reject(new Error("napcat down"))),
    });
    const result = await listContacts(paged as never, systemClock());
    expect(result.contacts.map((entry) => entry.channelId)).toEqual(["1", "2"]);
    expect(result.partial).toBe(true);

    const slow = bot({ getGuildList: () => new Promise(() => {}) });
    const timed = await listContacts(slow as never, systemClock(), 20);
    expect(timed.partial).toBe(true);
    expect(timed.contacts.every((entry) => entry.direct)).toBe(true);

    const many = bot({ getGuildList: async () => ({ data: Array.from({ length: 2100 }, (_, i) => ({ id: String(i) })) }) });
    const capped = await listContacts(many as never, systemClock());
    expect(capped.partial).toBe(true);
    expect(capped.contacts.filter((entry) => !entry.direct)).toHaveLength(2000);
  });
});

describe("contacts route", () => {
  function setup(bots: unknown[], session: { role: string } | null = { role: "owner" }) {
    let handler: Function | undefined;
    const ctx = { bots, clock: systemClock(), server: { get: (path: string, cb: Function) => path === CONTACTS_PATH && (handler = cb) } };
    const auth = { sessionFromCookie: () => session ?? undefined, sameOrigin: () => true };
    installContacts(ctx as never, auth as never);
    return async (query: Record<string, string> = {}) => {
      const http = { status: 200, body: undefined as unknown, query, set: () => {}, get: () => "" };
      await handler!(http);
      return http;
    };
  }

  it("is owner-only (members reach their own runtime through the relay)", async () => {
    expect((await setup([bot()], null)()).status).toBe(401);
    expect((await setup([bot()], { role: "member" })()).status).toBe(403);
  });

  it("lists online bots of registered chat platforms only and caches for a minute", async () => {
    const online = bot();
    const get = setup([
      online,
      bot({ status: 0, selfId: "off" }),
      bot({ platform: "discord", selfId: "d" }),
      bot({ platform: "xiaoheihe", selfId: "x" }),
      bot({ platform: "wechat-bridge", selfId: "wxid_self" }),
    ]);
    const first = await get();
    expect((first.body as { bots: { selfId: string }[] }).bots.map((entry) => entry.selfId)).toEqual(["10001", "wxid_self"]);
    await get();
    expect(online.getGuildList).toHaveBeenCalledTimes(1);
    await get({ refresh: "1" });
    expect(online.getGuildList).toHaveBeenCalledTimes(2);
  });

  it("reports an offline QQ instead of an empty list", async () => {
    const response = await setup([bot({ status: 0 })])();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ message: "bot_offline" });
  });

  it("never lists the always-online built-in web chat as a chat account", async () => {
    const web = bot({ platform: "web", selfId: "bot" });
    const offline = await setup([bot({ status: 0 }), web])();
    expect([offline.status, offline.body]).toEqual([503, { message: "bot_offline" }]);
    const online = await setup([web, bot()])();
    expect((online.body as { bots: { platform: string }[] }).bots.map((entry) => entry.platform)).toEqual(["onebot"]);
    expect(web.getGuildList).not.toHaveBeenCalled();
  });
});

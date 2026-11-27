import { AppError, manualClock, systemClock } from "@yesimbot/foundation";
import { AgentWechatError } from "@yesimbot/wechat-transport";
import { protectPluginTools } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

import { WECHAT_ERRORS } from "../src/errors.js";
import { GROUP_MEMBERS_TOOL, GroupRosters, groupMembersPlugin, groupMembersTool, type GroupRoster } from "../src/members.js";

const ROOM = "123@chatroom";

function rosterApi(overrides: Record<string, unknown> = {}) {
  return {
    refreshGroupMembers: vi.fn(async () => ({ id: "op_1", accountId: "acct", kind: "metadata", state: "queued", result: null })),
    operation: vi.fn(async () => ({ id: "op_1", accountId: "acct", kind: "metadata", state: "succeeded", result: { completeRoster: true, memberCount: 4 } })),
    group: vi.fn(async () => ({ id: ROOM, displayName: "工作群", ownerId: "wxid_owner", administratorIds: ["wxid_admin"] })),
    groupMembers: vi.fn(async () => [
      { username: "wxid_a", roomDisplayName: "小甲", nickname: "甲" },
      { username: "wxid_self", displayName: "机器人", nickname: "机器人" },
      { username: "wxid_admin", nickname: "管理" },
      { username: "wxid_owner" },
    ]),
    ...overrides,
  };
}

describe("group members", () => {
  it("asks WeChat for the whole list, then lists owner, admins and the rest with their group names", async () => {
    const api = rosterApi();
    const rosters = new GroupRosters(systemClock());
    expect(await rosters.read(api as never, "acct", ROOM, "wxid_self")).toEqual({
      group: "工作群",
      count: 4,
      members: [
        { id: "wxid_owner", name: "wxid_owner", role: "owner" },
        { id: "wxid_admin", name: "管理", role: "admin" },
        { id: "wxid_a", name: "小甲", nickname: "甲" },
        { id: "wxid_self", name: "机器人", self: true },
      ],
    });
    expect(api.refreshGroupMembers).toHaveBeenCalledWith("acct", ROOM, undefined);
    // Within ten minutes the saved list is current.
    await rosters.read(api as never, "acct", ROOM, "wxid_self");
    expect(api.refreshGroupMembers).toHaveBeenCalledOnce();
  });

  it("lists the saved members with a note when WeChat did not confirm the whole list, and asks again next time", async () => {
    const api = rosterApi({
      operation: vi.fn(async () => ({ id: "op_1", accountId: "acct", kind: "metadata", state: "failed", result: null })),
    });
    const rosters = new GroupRosters(systemClock());
    const roster = await rosters.read(api as never, "acct", ROOM, undefined);
    expect(roster.count).toBe(4);
    expect(roster.note).toMatch(/可能缺人/);
    api.refreshGroupMembers.mockRejectedValueOnce(new AgentWechatError(503, "transport_unavailable"));
    expect((await rosters.read(api as never, "acct", ROOM, undefined)).note).toMatch(/可能缺人/);
    expect(api.refreshGroupMembers).toHaveBeenCalledTimes(2);
  });

  it("offers the tool only in this adapter's WeChat groups", async () => {
    const read = vi.fn(async (): Promise<GroupRoster> => ({ count: 0, members: [] }));
    const ours = { selfId: "wxid_self" };
    const plugin = groupMembersPlugin({ owns: (bot) => bot === (ours as never), read });
    const group = { platform: "wechat-bridge", type: "guild", guildId: ROOM, channelId: ROOM } as const;
    const setup = (scope: object, bot: object = ours) => plugin.setup(scope as never, bot as never);
    const offered = (await setup(group))!;
    const tools = offered.tools as { name: string; execute: (input: object, context: object) => Promise<unknown> }[];
    expect(tools.map((tool) => tool.name)).toEqual([GROUP_MEMBERS_TOOL]);
    await tools[0]!.execute({}, {});
    expect(read).toHaveBeenCalledWith(ROOM, undefined);
    expect(await setup({ platform: "wechat-bridge", type: "direct", selfId: "wxid_self", userId: "wxid_peer", channelId: "wxid_peer" })).toBeNull();
    expect(await setup({ ...group, platform: "onebot", channelId: "123", guildId: "123" })).toBeNull();
    expect(await setup(group, { selfId: "wxid_other" })).toBeNull();
  });

  it("passes Core's capability boundary in WeChat groups and nowhere else", async () => {
    const plugin = { name: "wechat-bridge", tools: [groupMembersTool(async () => ({ count: 0, members: [] }))] };
    const kept = (platform: string, kind: "direct" | "group", role?: "main" | "content") =>
      (protectPluginTools(plugin, { platform, kind }, "adapter-wechat-bridge", undefined, role).tools as { name: string }[]).map((tool) => tool.name);
    expect(kept("wechat-bridge", "group")).toEqual([GROUP_MEMBERS_TOOL]);
    expect(kept("wechat-bridge", "direct")).toEqual([]);
    expect(kept("onebot", "group")).toEqual([]);
    // A background task never gets it.
    expect(kept("wechat-bridge", "group", "content")).toEqual([]);
  });

  it("tells the model in words why it could not read the list", async () => {
    const refused = groupMembersTool(async () => {
      throw new AppError(WECHAT_ERRORS.wechat_not_logged_in, { effect: "none" });
    });
    expect(await refused.execute!({}, {} as never)).toEqual({
      ok: false,
      error: { code: "wechat_not_logged_in", message: "微信没有登录，暂时无法操作。", retryable: true },
      effect: "none",
    });
    const down = groupMembersTool(async () => {
      throw new AgentWechatError(503, "transport_unavailable");
    });
    expect(await down.execute!({}, {} as never)).toMatchObject({ ok: false, error: { code: "wechat_roster_unavailable" } });
  });

  it("asks WeChat again after ten minutes by the clock", async () => {
    const api = rosterApi();
    const clock = manualClock(0);
    const rosters = new GroupRosters(clock);
    await rosters.read(api as never, "acct", ROOM, "wxid_self");
    clock.advance(9 * 60_000);
    await rosters.read(api as never, "acct", ROOM, "wxid_self");
    expect(api.refreshGroupMembers).toHaveBeenCalledOnce();
    clock.advance(2 * 60_000);
    await rosters.read(api as never, "acct", ROOM, "wxid_self");
    expect(api.refreshGroupMembers).toHaveBeenCalledTimes(2);
  });
});

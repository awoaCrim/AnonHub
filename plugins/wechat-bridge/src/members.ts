import type { AgentTool } from "@yesimbot/agent-runtime";
import { AppError, errorFields, toToolResult, type Clock, type ToolFailure } from "@yesimbot/foundation";
import { type AgentWechatClient, type AgentWechatGroupMember } from "@yesimbot/wechat-transport";
import type { ChannelPlugin, ChatAccount } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { isGroupThread } from "./config.js";
import { WECHAT_ERRORS } from "./errors.js";
import { log } from "./log.js";
import { sleep } from "./sleep.js";

export const GROUP_MEMBERS_TOOL = "wechat_group_members";

/** WeChat answered a member refresh in about a second (2026-11-23); past this the saved list is used. */
const REFRESH_WAIT_MS = 15_000;

/** A group's member list is asked of WeChat at most this often. */
const REFRESH_EVERY_MS = 10 * 60_000;

const OPERATION_DONE = new Set(["succeeded", "failed", "cancelled", "expired", "rejected"]);

const INCOMPLETE_NOTE = "刚才没能向微信刷新名单，这是本地保存的名单，可能缺人。";

export type RosterApi = Pick<AgentWechatClient, "group" | "groupMembers" | "refreshGroupMembers" | "operation">;

/** One adapter's bot and its rosters; the adapter checks the group and the login. */
export interface RosterSource {
  owns(bot: ChatAccount): boolean;
  read(room: string, signal?: AbortSignal): Promise<GroupRoster>;
}

export interface GroupRoster {
  readonly group?: string;
  readonly count: number;
  readonly members: readonly RosterMember[];
  /** Set when WeChat did not confirm the whole list just now. */
  readonly note?: string;
}

export interface RosterMember {
  /** The wxid; `<at id="…"/>` mentions this member. */
  readonly id: string;
  /** Their name in the group, else the account's remark or their nickname, else the wxid. */
  readonly name: string;
  readonly nickname?: string;
  readonly role?: "owner" | "admin";
  /** The bot's own account. */
  readonly self?: true;
}

/** Group rosters, refreshed from WeChat at most every ten minutes per group. */
export class GroupRosters {
  private readonly refreshed = new Map<string, number>();
  constructor(private readonly clock: Clock) {}

  async read(api: RosterApi, account: string, room: string, selfId: string | undefined, signal?: AbortSignal): Promise<GroupRoster> {
    const complete = await this.refresh(api, account, room, signal);
    const [group, saved] = await Promise.all([api.group(account, room, signal), api.groupMembers(account, room, signal)]);
    const admins = new Set(group.administratorIds ?? []);
    const members = saved.map((item) =>
      rosterMember(item, item.username === group.ownerId ? "owner" : admins.has(item.username) ? "admin" : undefined, selfId),
    );
    const rank = (member: RosterMember) => (member.role === "owner" ? 0 : member.role === "admin" ? 1 : 2);
    members.sort((left, right) => rank(left) - rank(right));
    const name = group.displayName?.trim();
    return { ...(name ? { group: name } : {}), count: members.length, members, ...(complete ? {} : { note: INCOMPLETE_NOTE }) };
  }

  /** True when WeChat confirmed the whole list now or within the last ten minutes. */
  private async refresh(api: RosterApi, account: string, room: string, signal?: AbortSignal): Promise<boolean> {
    const last = this.refreshed.get(room);
    if (last !== undefined && this.clock.now() - last < REFRESH_EVERY_MS) return true;
    try {
      let operation = await api.refreshGroupMembers(account, room, signal);
      const deadline = this.clock.now() + REFRESH_WAIT_MS;
      while (!OPERATION_DONE.has(operation.state)) {
        if (this.clock.now() + 300 > deadline) return false;
        await sleep(300, signal);
        operation = await api.operation(account, operation.id, signal);
      }
      if (operation.state !== "succeeded" || operation.result?.completeRoster !== true) return false;
      this.refreshed.set(room, this.clock.now());
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      log.debug("roster.refresh_failed", { room, ...errorFields(error) });
      return false;
    }
  }
}

/** `wechat_group_members` in the groups of this adapter's bot; never in direct chats. */
export function groupMembersPlugin(source: RosterSource): ChannelPlugin {
  return {
    id: "adapter-wechat-bridge",
    setup(scope, bot) {
      if (scope.platform !== "wechat-bridge" || scope.type === "direct" || !isGroupThread(scope.channelId) || !source.owns(bot)) return null;
      return { name: "wechat-bridge", tools: [groupMembersTool((signal) => source.read(scope.channelId, signal))] };
    },
  };
}

export function groupMembersTool(read: (signal?: AbortSignal) => Promise<GroupRoster>): AgentTool<Record<string, never>, GroupRoster | ToolFailure> {
  return {
    name: GROUP_MEMBERS_TOOL,
    description: '列出当前微信群的全部成员：微信 ID、群名片（没有时为备注或昵称）、群主和管理员，self 是你自己。只能看本群。要 @ 某人时用 <at id="微信 ID"/>。',
    inputSchema: z.strictObject({}),
    execute: async (_input, execution) => {
      try {
        return await read(execution?.abortSignal);
      } catch (cause) {
        log.warn("roster.read_failed", { ...errorFields(cause) });
        return toToolResult(cause instanceof AppError ? cause : new AppError(WECHAT_ERRORS.wechat_roster_unavailable, { cause, effect: "none" }));
      }
    },
  };
}

function rosterMember(item: AgentWechatGroupMember, role: RosterMember["role"], selfId: string | undefined): RosterMember {
  const nickname = item.nickname?.trim();
  const name = item.roomDisplayName?.trim() || item.displayName?.trim() || nickname || item.username;
  return {
    id: item.username,
    name,
    ...(nickname && nickname !== name ? { nickname } : {}),
    ...(role ? { role } : {}),
    ...(item.username === selfId ? { self: true as const } : {}),
  };
}

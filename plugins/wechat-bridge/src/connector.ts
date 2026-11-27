import { resolve } from "node:path";

import { AgentWechatClient, readTokenFile } from "@yesimbot/wechat-transport";
import { defineConnector, type ChatAccount, type Part } from "koishi-plugin-yesimbot/kernel";

import { createAutoReplyWill } from "./auto-reply.js";
import { moduleConfig, type Config } from "./config.js";
import { WechatConnection, type Presence } from "./connection.js";
import { groupMembersPlugin } from "./members.js";
import { inboundFromMessage, throughElements } from "./records.js";

/** The account status the console reads: not yet connected, online, offline. */
export const ACCOUNT_STATUS = { offline: 0, online: 1, connect: 2 } as const;

/**
 * WeChat through the agent-wechat daemon (leave-koishi 6.6), on `apps/server`: Core is reached directly, with no Satori
 * Bot or Session (the Koishi adapter was removed in leave-koishi stage 8).
 */
export const connector = defineConnector({
  moduleConfig,
  start(ctx) {
    // Core sends only once the connection below is running.
    const account = new WechatAccount(ctx.config, (channelId, parts) => connection.send(channelId, parts));
    let withdraw = ctx.account(account);
    const connection: WechatConnection = new WechatConnection({
      api: new AgentWechatClient({ endpoint: ctx.config.endpoint, token: () => readTokenFile(resolve(ctx.baseDir, ctx.config.tokenFile)) }),
      config: ctx.config,
      host: {
        selfId: () => account.selfId || undefined,
        online: () => account.status === ACCOUNT_STATUS.online,
        presence: (next) => {
          // The account is listed under its wxid once the daemon reports it.
          if (next.selfId && next.selfId !== account.selfId) {
            withdraw();
            account.rename(next.selfId);
            withdraw = ctx.account(account);
          }
          account.report(next);
        },
        receive: async (message) => {
          const inbound = inboundFromMessage(message, account.selfId);
          // Core keeps the message before the connection saves its progress; a failure keeps the event.
          if (inbound) await ctx.core.messenger.accept(inbound, true);
        },
      },
      clock: ctx.clock,
      stateDirectory: resolve(ctx.baseDir, "data/wechat-bridge"),
    });
    const withdrawWill = ctx.core.agent.will(createAutoReplyWill(ctx.config, () => account.selfId || undefined));
    const withdrawMembers = ctx.core.agent.use(
      groupMembersPlugin({
        owns: (current) => current === account || (!!account.selfId && current.selfId === account.selfId),
        read: (room, signal) => connection.groupMembers(room, signal),
      }),
    );
    account.status = ACCOUNT_STATUS.connect;
    connection.start();
    return async () => {
      await connection.stop();
      withdrawMembers();
      withdrawWill();
      withdraw();
    };
  },
});

/**
 * The WeChat account the daemon logs in, as Core sends through it and the console lists it: the wxid once known
 * (`""` before), the status the daemon reports, and only the allowed chats as its groups and friends.
 */
export class WechatAccount implements ChatAccount {
  public readonly platform = "wechat-bridge";
  public selfId = "";
  public status: number = ACCOUNT_STATUS.offline;
  public error?: { readonly message: string };
  public user: { readonly id?: string } = {};

  public constructor(
    public readonly config: Config,
    private readonly send: (channelId: string, parts: Part[]) => Promise<string[]>,
  ) {}

  public rename(selfId: string): void {
    this.selfId = selfId;
    this.user = { id: selfId };
  }

  /** What the Koishi adapter did to its Bot: an error is offline with that error; online clears it. */
  public report({ online, error }: Presence): void {
    if (error) {
      this.status = ACCOUNT_STATUS.offline;
      this.error = { message: error };
    } else if (online) {
      this.status = ACCOUNT_STATUS.online;
      this.error = undefined;
    } else {
      this.status = ACCOUNT_STATUS.offline;
      this.error = undefined;
    }
  }

  public sendMessage(channelId: string, content: readonly Part[]): Promise<string[]> {
    return this.send(channelId, throughElements(content));
  }

  /** Only the allowed groups: the account's other chats are never listed. */
  public async getGuildList(): Promise<{ data: { id: string }[] }> {
    return { data: this.config.allowedRooms.map((id) => ({ id })) };
  }

  /** Only the allowed direct contacts; their direct channel ID is the wxid itself. */
  public async getFriendList(): Promise<{ data: { user: { id: string } }[] }> {
    return { data: this.config.allowedPeers.map((id) => ({ user: { id } })) };
  }
}

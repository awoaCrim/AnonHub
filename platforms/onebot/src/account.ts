import type { Part } from "@yesimbot/contracts/parts";
import { ONEBOT_ACTIONS, oneBotActionName, oneBotArgs } from "@yesimbot/contracts/platforms";
import { AppError, errorFields, logger, type Clock } from "@yesimbot/foundation";
import type { ChatAccount, ConnectorActions, ConnectorSocket } from "koishi-plugin-yesimbot/kernel";

import { sendParts } from "./encoder.js";
import { ONEBOT_PROTOCOL_ERRORS, OneBotSocket, type OneBotEvent } from "./protocol.js";

/** Koishi's `Status`, which the console reads: not yet connected, online, offline. */
export const ACCOUNT_STATUS = { offline: 0, online: 1, connect: 2 } as const;

const log = logger("onebot.account");

/** adapter-onebot's response timeout. */
const ACTION_TIMEOUT_MS = 60_000;

/** A QQ user as adapter-onebot decoded one (`decodeUser`): the nickname as name, never the remark or group card. */
export interface OneBotUser {
  readonly id: string;
  readonly name?: string;
  readonly userId: string;
  readonly avatar?: string;
  readonly username?: string;
}

export interface OneBotAccountOptions {
  readonly clock: Clock;
  /** Every event NapCat posts on the current connection. */
  onEvent(event: OneBotEvent): void;
}

/**
 * The QQ account NapCat logs in, as Core sends through it and the console lists it. NapCat dials in; a new connection
 * replaces the one before. Without a connection every action fails with `onebot_disconnected`.
 */
export class OneBotAccount implements ChatAccount {
  public readonly platform = "onebot";
  public status: number = ACCOUNT_STATUS.connect;
  public error?: { readonly message: string };
  public user: OneBotUser;
  /** The OneBot actions plugins use (`ONEBOT_ACTIONS`): each one's `data`, a refusal thrown. */
  public readonly actions: ConnectorActions;
  private connection?: OneBotSocket;

  public constructor(
    public readonly selfId: string,
    private readonly options: OneBotAccountOptions,
  ) {
    this.user = { id: selfId, userId: selfId, avatar: avatarOf(selfId) };
    this.actions = Object.freeze(
      Object.fromEntries(ONEBOT_ACTIONS.map((action) => [oneBotActionName(action), (input: Readonly<Record<string, unknown>>) => this.call(action, input)])),
    );
  }

  /** Takes NapCat's new connection and logs the account in on it. */
  public attach(socket: ConnectorSocket): void {
    const previous = this.connection;
    const connection = new OneBotSocket(socket, {
      timeoutMs: ACTION_TIMEOUT_MS,
      onEvent: (event) => {
        if (this.connection === connection) this.options.onEvent(event);
      },
      onClose: () => {
        if (this.connection !== connection) return;
        this.connection = undefined;
        this.status = ACCOUNT_STATUS.offline;
        log.info("account.disconnected", { selfId: this.selfId });
      },
    });
    this.connection = connection;
    previous?.close(1000, "replaced");
    log.info("account.connected", { selfId: this.selfId, replaced: Boolean(previous) });
    void this.login(connection);
  }

  /** Closes the connection; the account stays offline until NapCat dials in again. */
  public detach(): void {
    const connection = this.connection;
    this.connection = undefined;
    this.status = ACCOUNT_STATUS.offline;
    connection?.close(1001, "stopping");
  }

  /** One action's `data`, its `*_id` arguments converted as adapter-onebot did; anything but retcode 0 throws. */
  public call(action: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    return this.socket().call(action, oneBotArgs(action, params));
  }

  public sendMessage(channelId: string, content: readonly Part[]): Promise<string[]> {
    return sendParts(
      { call: (action, params) => this.call(action, params), self: { name: this.user.name, id: this.selfId }, now: () => this.options.clock.now() },
      channelId,
      content,
    );
  }

  /** Satori's list shape, as the console reads it; QQ gives every friend at once. */
  public async getFriendList(): Promise<{ data: OneBotUser[] }> {
    const list = (await this.call("get_friend_list")) as readonly Record<string, unknown>[];
    return { data: list.map(decodeUser) };
  }

  public async getGuildList(): Promise<{ data: { id: string; name?: string }[] }> {
    const list = (await this.call("get_group_list")) as readonly Record<string, unknown>[];
    return { data: list.map((group) => ({ id: `${group.group_id}`, name: group.group_name as string | undefined })) };
  }

  private socket(): OneBotSocket {
    const connection = this.connection;
    if (!connection?.isOpen) throw new AppError(ONEBOT_PROTOCOL_ERRORS.onebot_disconnected, { effect: "none", detail: this.selfId });
    return connection;
  }

  private async login(connection: OneBotSocket): Promise<void> {
    try {
      const user = decodeUser((await connection.call("get_login_info")) as Record<string, unknown>);
      if (this.connection !== connection) return;
      if (user.id !== this.selfId) log.warn("account.login_mismatch", { selfId: this.selfId, loggedIn: user.id });
      this.user = user;
      this.error = undefined;
      this.status = ACCOUNT_STATUS.online;
      log.info("account.online", { selfId: this.selfId });
    } catch (error) {
      if (this.connection !== connection) return;
      // The connection stays: events still come, and NapCat may log in later.
      this.error = { message: error instanceof Error ? error.message : String(error) };
      this.status = ACCOUNT_STATUS.offline;
      log.warn("account.login_failed", { selfId: this.selfId, ...errorFields(error) });
    }
  }
}

/** `decodeUser`: the QQ number (or guild tiny ID) as ID, the nickname as name, the QQ avatar. */
export function decodeUser(user: Record<string, unknown>): OneBotUser {
  const id = `${(user.tiny_id as string | undefined) || user.user_id}`;
  const name = user.nickname as string | undefined;
  return { id, name, userId: id, avatar: user.user_id ? avatarOf(`${user.user_id}`) : undefined, username: name };
}

function avatarOf(userId: string): string {
  return `http://q.qlogo.cn/headimg_dl?dst_uin=${userId}&spec=640`;
}

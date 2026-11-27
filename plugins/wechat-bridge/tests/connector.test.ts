import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemClock } from "@yesimbot/foundation";
import type { ChatAccount } from "koishi-plugin-yesimbot/kernel";
import { describe, expect, it, vi } from "vitest";

import type { Config } from "../src/config.js";
import { ACCOUNT_STATUS, connector, WechatAccount } from "../src/connector.js";

const config: Config = {
  allowedRooms: ["123@chatroom"],
  allowedPeers: ["wxid_peer"],
  autoReply: { direct: true, group: false },
  // Nothing listens here: the daemon is unreachable.
  endpoint: "http://127.0.0.1:9",
  tokenFile: "data/agent-wechat/api-token",
  account: "bot",
};

describe("the WeChat account on the new host", () => {
  it("reports what the daemon says: an error is offline with it, online clears it, logged out is no error", () => {
    const account = new WechatAccount(config, async () => []);
    account.report({ online: false, error: "微信服务暂不可用" });
    expect(account).toMatchObject({ status: ACCOUNT_STATUS.offline, error: { message: "微信服务暂不可用" } });
    account.rename("wxid_self");
    account.report({ selfId: "wxid_self", online: true });
    expect(account).toMatchObject({ selfId: "wxid_self", user: { id: "wxid_self" }, status: ACCOUNT_STATUS.online, error: undefined });
    account.report({ online: false });
    expect(account).toMatchObject({ status: ACCOUNT_STATUS.offline, error: undefined });
  });

  it("lists only the allowed chats", async () => {
    const account = new WechatAccount(config, async () => []);
    expect(await account.getGuildList()).toEqual({ data: [{ id: "123@chatroom" }] });
    expect(await account.getFriendList()).toEqual({ data: [{ user: { id: "wxid_peer" } }] });
  });

  it("starts listed before login, says when the daemon cannot be reached, and takes everything back on stop", async () => {
    const accounts = new Map<string, ChatAccount>();
    const withdrawWill = vi.fn();
    const withdrawPlugin = vi.fn();
    const ctx = {
      config,
      baseDir: await mkdtemp(join(tmpdir(), "wechat-connector-")),
      clock: systemClock(),
      core: { agent: { will: vi.fn(() => withdrawWill), use: vi.fn(() => withdrawPlugin) }, messenger: { accept: vi.fn() } },
      account: (account: ChatAccount) => {
        const key = `${account.platform}:${account.selfId}`;
        accounts.set(key, account);
        return () => void accounts.delete(key);
      },
    };
    const stop = (await connector.start(ctx as never)) as () => Promise<void>;
    const account = accounts.get("wechat-bridge:") as WechatAccount;
    expect(account).toBeInstanceOf(WechatAccount);
    await vi.waitFor(() => expect(account.error).toEqual({ message: "微信服务暂不可用" }), { timeout: 5000 });
    expect(account.status).toBe(ACCOUNT_STATUS.offline);
    expect(ctx.core.agent.will).toHaveBeenCalledOnce();
    expect(ctx.core.agent.use).toHaveBeenCalledOnce();
    await stop();
    expect(accounts.size).toBe(0);
    expect(withdrawWill).toHaveBeenCalledOnce();
    expect(withdrawPlugin).toHaveBeenCalledOnce();
    expect(ctx.core.messenger.accept).not.toHaveBeenCalled();
  });
});

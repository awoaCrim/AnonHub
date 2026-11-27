import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

import { ONEBOT_ACTIONS, oneBotActionName } from "@yesimbot/contracts/platforms";
import type { ChatAccount, ConnectorContext, ConnectorSocket } from "koishi-plugin-yesimbot/kernel";
import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_STATUS, OneBotAccount } from "../src/account.js";
import type { Config } from "../src/config.js";
import { admits, connector } from "../src/connector.js";
import type { OneBotEvent } from "../src/protocol.js";

/** NapCat's socket; it answers each action with `answer` unless told to stay quiet. */
class NapCatSocket extends EventEmitter {
  readyState = 1;
  readonly sent: { action: string; params: Record<string, unknown>; echo: string }[] = [];
  closed?: number;

  public constructor(private readonly answer: (action: string) => unknown = () => ({ status: "ok", retcode: 0, data: null })) {
    super();
  }

  send(data: string) {
    const request = JSON.parse(data) as { action: string; params: Record<string, unknown>; echo: string };
    this.sent.push(request);
    const reply =
      request.action === "get_login_info" ? { status: "ok", retcode: 0, data: { user_id: 10001, nickname: "Athena" } } : this.answer(request.action);
    if (reply) queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ ...(reply as object), echo: request.echo })), false));
  }

  close(code = 1000) {
    this.closed = code;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(""));
  }

  ping() {}

  post(event: OneBotEvent) {
    this.emit("message", Buffer.from(JSON.stringify(event)), false);
  }
}

const request = (headers: Record<string, string>, url = "/onebot") => ({ headers, url }) as unknown as IncomingMessage;
const napcat = { "x-self-id": "10001", "x-client-role": "Universal" };

function account() {
  const events: OneBotEvent[] = [];
  const qq = new OneBotAccount("10001", { clock: { now: () => 0 }, onEvent: (event) => events.push(event) });
  return { qq, events };
}

describe("the QQ connector's endpoint", () => {
  it("admits NapCat for this account only, and checks the token when one is set", () => {
    const config = { selfId: "10001" };
    expect(admits(config, request(napcat))).toBe(true);
    expect(admits(config, request({ ...napcat, "x-self-id": "10002" }))).toBe(false);
    expect(admits(config, request({ "x-self-id": "10001" }))).toBe(false);
    expect(admits(config, request({ ...napcat, "x-client-role": "universal" }))).toBe(false);

    const guarded = { selfId: "10001", token: "s3cret" };
    expect(admits(guarded, request(napcat))).toBe(false);
    expect(admits(guarded, request({ ...napcat, authorization: "Bearer s3cret" }))).toBe(true);
    expect(admits(guarded, request({ ...napcat, authorization: "Bearer s3cre" }))).toBe(false);
    expect(admits(guarded, request(napcat, "/onebot?access_token=s3cret"))).toBe(true);
  });

  it("admits whichever QQ NapCat signed in to when no QQ number is configured", () => {
    expect(admits({}, request(napcat))).toBe(true);
    expect(admits({}, request({ ...napcat, "x-self-id": "10002" }))).toBe(true);
    expect(admits({}, request({ "x-client-role": "Universal" }))).toBe(false);
    expect(admits({}, request({ ...napcat, "x-self-id": "not-a-qq" }))).toBe(false);
  });

  it("puts the QQ NapCat dials in as online, and a different QQ in its place", async () => {
    const online = new Map<string, ChatAccount>();
    let endpoint: ((socket: ConnectorSocket, request: IncomingMessage) => void) | undefined;
    const ctx = {
      config: { protocol: "ws-reverse", path: "/onebot/secret" },
      clock: { now: () => 0 },
      account: (qq: ChatAccount) => {
        online.set(qq.selfId, qq);
        return () => online.delete(qq.selfId);
      },
      ws: (_path: string, handler: typeof endpoint) => {
        endpoint = handler;
        return () => {};
      },
    } as unknown as ConnectorContext<Config>;
    const stop = await connector.start(ctx);
    expect(online.size).toBe(0);

    const first = new NapCatSocket();
    endpoint!(first as unknown as ConnectorSocket, request(napcat));
    expect([...online.keys()]).toEqual(["10001"]);
    await vi.waitFor(() => expect(online.get("10001")?.status).toBe(ACCOUNT_STATUS.online));

    endpoint!(new NapCatSocket() as unknown as ConnectorSocket, request({ ...napcat, "x-self-id": "10002" }));
    expect([...online.keys()]).toEqual(["10002"]);
    expect(first.closed).toBe(1001);
    if (typeof stop === "function") await stop();
  });
});

describe("the QQ account", () => {
  it("is connecting until NapCat logs in, online after, offline once the connection closes", async () => {
    const { qq } = account();
    expect(qq.status).toBe(ACCOUNT_STATUS.connect);
    await expect(qq.sendMessage("300", [{ type: "text", text: "hi" }])).rejects.toMatchObject({ code: "onebot_disconnected" });
    const socket = new NapCatSocket();
    qq.attach(socket as never);
    await vi.waitFor(() => expect(qq.status).toBe(ACCOUNT_STATUS.online));
    expect(qq.user).toMatchObject({ id: "10001", name: "Athena" });
    socket.close();
    expect(qq.status).toBe(ACCOUNT_STATUS.offline);
  });

  it("takes a new connection in place of the old one: the old one is closed and no longer heard", async () => {
    const { qq, events } = account();
    const first = new NapCatSocket();
    qq.attach(first as never);
    const second = new NapCatSocket();
    qq.attach(second as never);
    expect(first.closed).toBe(1000);
    first.post({ post_type: "notice", notice_type: "notify" });
    second.post({ post_type: "notice", notice_type: "group_recall" });
    expect(events).toEqual([{ post_type: "notice", notice_type: "group_recall" }]);
    await vi.waitFor(() => expect(qq.status).toBe(ACCOUNT_STATUS.online));
  });

  it("declares exactly the OneBot actions: each one's data, IDs as numbers, a refusal thrown", async () => {
    const { qq } = account();
    const socket = new NapCatSocket((action) =>
      action === "get_forward_msg"
        ? { status: "ok", retcode: 0, data: { messages: [{ id: 1 }] } }
        : action === "send_group_forward_msg"
          ? { status: "ok", retcode: 0, data: { message_id: 88, res_id: "r" } }
          : { status: "failed", retcode: 1404, data: null, wording: "不支持" },
    );
    qq.attach(socket as never);
    expect(Object.keys(qq.actions)).toEqual(ONEBOT_ACTIONS.map(oneBotActionName));
    expect(await qq.actions["onebot.get_forward_msg"]!({ message_id: "12345" })).toEqual({ messages: [{ id: 1 }] });
    expect(await qq.actions["onebot.send_group_forward_msg"]!({ group_id: "300", messages: [] })).toEqual({ message_id: 88, res_id: "r" });
    await expect(qq.actions["onebot.set_msg_emoji_like"]!({ message_id: "9", emoji_id: "76" })).rejects.toMatchObject({
      code: "onebot_action_failed",
      detail: "set_msg_emoji_like: 1404 不支持",
    });
    expect(socket.sent.filter((sent) => sent.action !== "get_login_info").map(({ action, params }) => ({ action, params }))).toEqual([
      { action: "get_forward_msg", params: { message_id: 12345 } },
      { action: "send_group_forward_msg", params: { group_id: 300, messages: [] } },
      { action: "set_msg_emoji_like", params: { message_id: 9, emoji_id: 76 } },
    ]);
  });

  it("sends a file as a message of its file segment and resolves with QQ's IDs; an answer without one is an empty ID (spec 09 rule 3)", async () => {
    const { qq } = account();
    const answers = [{ message_id: 70 }, { file: "/napcat/cache/a.bin" }, { message_id: "71" }, {}];
    const socket = new NapCatSocket(() => ({ status: "ok", retcode: 0, data: answers.shift() }));
    qq.attach(socket as never);
    expect(await qq.sendMessage("private:200", [{ type: "file", src: "file:///srv/out/报告.pdf", title: "报告.pdf" }])).toEqual(["70"]);
    expect(await qq.sendMessage("300", [{ type: "file", src: "https://files.example/a.txt" }])).toEqual(["71"]);
    expect(await qq.sendMessage("300", [{ type: "text", text: "没有 ID" }])).toEqual([""]);
    expect(socket.sent.filter((sent) => sent.action !== "get_login_info").map(({ action, params }) => ({ action, params }))).toEqual([
      { action: "send_private_msg", params: { user_id: 200, message: [{ type: "file", data: { file: "/srv/out/报告.pdf", name: "报告.pdf" } }] } },
      { action: "download_file", params: { url: "https://files.example/a.txt" } },
      { action: "send_group_msg", params: { group_id: 300, message: [{ type: "file", data: { file: "/napcat/cache/a.bin", name: "a.txt" } }] } },
      { action: "send_group_msg", params: { group_id: 300, message: [{ type: "text", data: { text: "没有 ID" } }] } },
    ]);
  });

  it("lists friends and groups the way the console reads them", async () => {
    const { qq } = account();
    qq.attach(
      new NapCatSocket((action) => ({
        status: "ok",
        retcode: 0,
        data: action === "get_friend_list" ? [{ user_id: 200, nickname: "小明", remark: "同学" }] : [{ group_id: 300, group_name: "测试群" }],
      })) as never,
    );
    expect(await qq.getFriendList()).toEqual({
      data: [{ id: "200", name: "小明", userId: "200", avatar: "http://q.qlogo.cn/headimg_dl?dst_uin=200&spec=640", username: "小明" }],
    });
    expect(await qq.getGuildList()).toEqual({ data: [{ id: "300", name: "测试群" }] });
  });
});

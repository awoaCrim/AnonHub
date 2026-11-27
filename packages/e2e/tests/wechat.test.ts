import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeModel, replyOnce } from "../src/fake-model.js";
import { FakeWechat } from "../src/fake-wechat.js";
import { startHost, waitUntil, type Host } from "../src/host.js";

// Each file boots a whole host; also holds when the repository-wide run uses its shorter defaults.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const FRIEND = "wxid_friend";
const STRANGER = "wxid_stranger";
const ROOM = "123456789@chatroom";
const QUIET_MS = 1500;

let model: FakeModel;
let daemon: FakeWechat;
let host: Host;

const settle = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));
const sendsTo = (thread: string) => daemon.sends.filter((send) => send.threadId === thread);
const debug = () =>
  `${host.output().slice(-3000)}\nmodel requests: ${model.requests.length}\nsends: ${JSON.stringify(daemon.sends)}\ndaemon: ${daemon.log.slice(-30).join("\n")}`;

beforeAll(async () => {
  model = await FakeModel.start();
  daemon = await FakeWechat.start();
  host = await startHost({
    model,
    wechat: { endpoint: daemon.url, token: daemon.token, account: daemon.alias, peers: [FRIEND], rooms: [ROOM], autoReply: { direct: true, group: true } },
    allowedChannels: [
      { platform: "wechat-bridge", channelId: FRIEND },
      { platform: "wechat-bridge", channelId: ROOM },
    ],
  });
  await waitUntil(() => daemon.following, 20_000, debug);
});

afterAll(async () => {
  await host?.stop();
  await daemon?.close();
  await model?.close();
});

beforeEach(() => {
  model.requests.length = 0;
  daemon.sends.length = 0;
  daemon.failSends = undefined;
});

describe("WeChat through agent-wechat", () => {
  it("answers a direct message from an allowed contact with exactly what the model sent", async () => {
    model.script = replyOnce("微信这边收到");
    daemon.directMessage(FRIEND, "微信私聊你好");
    await waitUntil(() => sendsTo(FRIEND).length > 0, 20_000, debug);
    await settle();
    expect(sendsTo(FRIEND).map((send) => send.text)).toEqual(["微信这边收到"]);
    expect(model.turns()[0]!.prompt).toContain("微信私聊你好");
    expect(daemon.unauthorized).toBe(0);
  });

  it("answers in an allowed group when mentioned", async () => {
    model.script = replyOnce("群聊收到");
    daemon.groupMessage(ROOM, FRIEND, "群里问一下", { atSelf: true });
    await waitUntil(() => sendsTo(ROOM).length > 0, 20_000, debug);
    await settle();
    expect(sendsTo(ROOM).map((send) => send.text)).toEqual(["群聊收到"]);
    expect(model.turns()[0]!.prompt).toContain("群里问一下");
  });

  it("never reaches the model for a contact that is not allowed", async () => {
    daemon.directMessage(STRANGER, "陌生微信消息");
    await settle();
    expect(model.requests.filter((request) => request.prompt.includes("陌生微信消息"))).toEqual([]);
    expect(daemon.sends).toEqual([]);
  });

  it("tells the model when WeChat refuses a send, and sends it only once", async () => {
    daemon.failSends = "failed";
    model.script = replyOnce("这条会被拒");
    daemon.directMessage(FRIEND, "测试微信发送失败");
    await waitUntil(() => model.turns().length >= 2, 20_000, debug);
    await settle();
    expect(daemon.sends).toEqual([]);
    const result = model.turns()[1]!.messages.find((message) => message.role === "tool");
    expect(JSON.stringify(result)).not.toMatch(/"messageIds?"\s*:\s*\[\s*"/);
  });
});

describe("WeChat with auto-reply left off (the default)", () => {
  let quietModel: FakeModel;
  let quietDaemon: FakeWechat;
  let quietHost: Host;

  beforeAll(async () => {
    quietModel = await FakeModel.start();
    quietDaemon = await FakeWechat.start();
    quietHost = await startHost({
      model: quietModel,
      wechat: { endpoint: quietDaemon.url, token: quietDaemon.token, account: quietDaemon.alias, peers: [FRIEND], rooms: [ROOM] },
      allowedChannels: [
        { platform: "wechat-bridge", channelId: FRIEND },
        { platform: "wechat-bridge", channelId: ROOM },
      ],
    });
    await waitUntil(() => quietDaemon.following, 20_000, quietHost.output);
  });

  afterAll(async () => {
    await quietHost?.stop();
    await quietDaemon?.close();
    await quietModel?.close();
  });

  it("takes allowed messages in but starts no reply", async () => {
    quietModel.script = replyOnce("不该发出");
    quietDaemon.directMessage(FRIEND, "关着自动回复的私聊");
    quietDaemon.groupMessage(ROOM, FRIEND, "关着自动回复的群聊", { atSelf: true });
    await waitUntil(() => quietDaemon.log.filter((line) => line.includes("/messages/msg_")).length === 2, 10_000, quietHost.output);
    await settle();
    expect(quietModel.turns()).toEqual([]);
    expect(quietDaemon.sends).toEqual([]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeModel, replyOnce } from "../src/fake-model.js";
import { FakeNapcat } from "../src/fake-napcat.js";
import { startHost, waitUntil, type Host } from "../src/host.js";

// Each file boots a whole host; also holds when the repository-wide run uses its shorter defaults.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const BOT = "10001";
const FRIEND = "20002";
const STRANGER = "20009";
const GROUP = "30003";
const OTHER_GROUP = "30009";
const QUIET_MS = 1500;

let model: FakeModel;
let host: Host;
let napcat: FakeNapcat;

const settle = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));
const sendsTo = (target: string) => napcat.sends.filter((send) => (send.target.kind === "group" ? send.target.groupId : send.target.userId) === target);
const debug = () =>
  `${host.output().slice(-3000)}\nmodel requests: ${model.requests.length}\nonebot calls: ${napcat.calls.map((call) => call.action).join(", ")}`;

beforeAll(async () => {
  model = await FakeModel.start();
  host = await startHost({
    model,
    qq: { account: BOT },
    allowedChannels: [
      { platform: "onebot", channelId: `private:${FRIEND}` },
      { platform: "onebot", channelId: GROUP },
    ],
  });
  napcat = await FakeNapcat.connect(host.onebotUrl!, BOT);
  await waitUntil(() => napcat.calls.some((call) => call.action === "get_login_info"), 10_000, debug);
});

afterAll(async () => {
  napcat?.close();
  await host?.stop();
  await model?.close();
});

beforeEach(() => {
  model.requests.length = 0;
  napcat.sends.length = 0;
  for (const key of Object.keys(napcat.handlers)) delete napcat.handlers[key];
});

describe("QQ through NapCat", () => {
  it("answers a private message from an allowed friend with exactly what the model sent", async () => {
    model.script = replyOnce("你好，我在。");
    napcat.privateMessage(FRIEND, "在吗？");
    await waitUntil(() => sendsTo(FRIEND).length > 0, 20_000, debug);
    await settle();
    expect(sendsTo(FRIEND)).toEqual([expect.objectContaining({ target: { kind: "private", userId: FRIEND }, text: "你好，我在。" })]);
    expect(model.turns()[0]!.prompt).toContain("在吗？");
  });

  it("keeps the conversation: the next turn sees the earlier message and the bot's own reply", async () => {
    model.script = replyOnce("第一条回复");
    napcat.privateMessage(FRIEND, "第一个问题");
    await waitUntil(() => sendsTo(FRIEND).length === 1, 20_000, debug);
    await settle();
    model.requests.length = 0;
    model.script = replyOnce("第二条回复");
    napcat.privateMessage(FRIEND, "第二个问题");
    await waitUntil(() => sendsTo(FRIEND).length === 2, 20_000, debug);
    const prompt = model.turns()[0]!.prompt;
    expect(prompt).toContain("第一个问题");
    expect(prompt).toContain("第一条回复");
    expect(prompt).toContain("第二个问题");
    expect(sendsTo(FRIEND).map((send) => send.text)).toEqual(["第一条回复", "第二条回复"]);
  });

  it("answers in an allowed group when mentioned", async () => {
    model.script = replyOnce("群里收到");
    napcat.groupMessage(GROUP, FRIEND, "机器人你好", { atSelf: true });
    await waitUntil(() => sendsTo(GROUP).length > 0, 20_000, debug);
    await settle();
    expect(sendsTo(GROUP)).toEqual([expect.objectContaining({ target: { kind: "group", groupId: GROUP }, text: "群里收到" })]);
    expect(model.turns()[0]!.prompt).toContain("机器人你好");
  });

  it("never reaches the model for a stranger or a group that is not allowed", async () => {
    napcat.privateMessage(STRANGER, "陌生人的消息");
    napcat.groupMessage(OTHER_GROUP, FRIEND, "别的群的消息", { atSelf: true });
    await settle();
    expect(model.requests.filter((request) => /陌生人的消息|别的群的消息/.test(request.prompt))).toEqual([]);
    expect(napcat.sends).toEqual([]);
  });

  it("tries a failed send once and tells the model it failed, without a platform message ID", async () => {
    let attempts = 0;
    napcat.handlers.send_private_msg = () => {
      attempts++;
      throw new Error("发送失败：风控");
    };
    model.script = replyOnce("这条发不出去");
    napcat.privateMessage(FRIEND, "测试发送失败");
    await waitUntil(() => model.turns().length >= 2, 20_000, debug);
    await settle();
    expect(attempts).toBe(1);
    expect(napcat.sends).toEqual([]);
    const after = model.turns()[1]!;
    const result = after.messages.find((message) => message.role === "tool");
    expect(JSON.stringify(result)).not.toMatch(/"messageIds?"\s*:\s*\[\s*"/);
  });
});

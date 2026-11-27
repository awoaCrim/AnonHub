import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeModel, replyOnce } from "../src/fake-model.js";
import { startHost, waitUntil, type Host } from "../src/host.js";
import { WebChatClient } from "../src/web-client.js";

let model: FakeModel;
let host: Host;
let owner: WebChatClient;

// Each file boots a whole host; also holds when the repository-wide run uses its shorter defaults.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const debug = () => `${host.output().slice(-3000)}\nmodel requests: ${model.requests.length}`;

beforeAll(async () => {
  model = await FakeModel.start();
  // The web chat needs no allow rule: only the logged-in owner can reach it.
  host = await startHost({ model, allowedChannels: [] });
  owner = await WebChatClient.login(host.url, host.admin.username, host.admin.password);
});

afterAll(async () => {
  await host?.stop();
  await model?.close();
});

beforeEach(() => {
  model.requests.length = 0;
});

describe("web chat in the console", () => {
  it("shows the owner's message and then the model's reply", async () => {
    model.script = replyOnce("网页这边收到了");
    const id = await owner.send("网页里的第一句话");
    await waitUntil(async () => (await owner.botMessages()).length > 0, 20_000, debug);
    const messages = await owner.messages();
    expect(messages.find((message) => message.id === id)).toMatchObject({ role: "user", text: "网页里的第一句话", status: "sent" });
    expect(messages.filter((message) => message.role === "bot").map((message) => message.text)).toEqual(["网页这边收到了"]);
    expect(model.turns()[0]!.prompt).toContain("网页里的第一句话");
  });

  it("keeps the conversation across turns", async () => {
    model.script = replyOnce("第二句的回复");
    await owner.send("网页里的第二句话");
    await waitUntil(async () => (await owner.botMessages()).length === 2, 20_000, debug);
    const prompt = model.turns()[0]!.prompt;
    expect(prompt).toContain("网页里的第一句话");
    expect(prompt).toContain("网页这边收到了");
    expect(prompt).toContain("网页里的第二句话");
  });

  it("refuses a send without the owner's session", async () => {
    expect(await WebChatClient.anonymousSend(host.url, "陌生人")).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(model.requests.filter((request) => request.prompt.includes("陌生人"))).toEqual([]);
  });
});

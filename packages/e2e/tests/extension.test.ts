import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { callThenReport, currentMessage, FakeModel } from "../src/fake-model.js";
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
  host = await startHost({ model, allowedChannels: [], modules: { "yesimbot-memorizer": {} } });
  owner = await WebChatClient.login(host.url, host.admin.username, host.admin.password);
});

afterAll(async () => {
  await host?.stop();
  await model?.close();
});

beforeEach(() => {
  model.requests.length = 0;
});

describe("an extension's tools in the main conversation", () => {
  it("offers memorizer's tools, keeps what the model remembered and finds it again next turn", async () => {
    model.script = callThenReport("remember", (request) => {
      const id = /id=\\?"([^"\\]+)/.exec(currentMessage(request))?.[1];
      return { action: "create", content: "主人最喜欢的水果是山竹", sources: [id], type: "preference", scope: "user" };
    });
    await owner.send("记住，我最喜欢山竹");
    await waitUntil(async () => (await owner.botMessages()).length === 1, 20_000, debug);
    expect(model.turns()[0]!.tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["remember", "recall"]));
    expect((await owner.botMessages())[0]!.text).not.toMatch(/失败|错误|error/i);

    model.requests.length = 0;
    model.script = callThenReport("recall", () => ({ query: "山竹" }));
    await owner.send("我最喜欢什么水果？");
    await waitUntil(async () => (await owner.botMessages()).length === 2, 20_000, debug);
    expect((await owner.botMessages())[1]!.text).toContain("主人最喜欢的水果是山竹");
  });
});

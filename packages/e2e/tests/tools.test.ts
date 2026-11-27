import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { callThenReport, FakeModel, replyOnce } from "../src/fake-model.js";
import { startHost, waitUntil, type Host } from "../src/host.js";
import { WebChatClient } from "../src/web-client.js";

// Each file boots a whole host; also holds when the repository-wide run uses its shorter defaults.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let model: FakeModel;
let host: Host;
let owner: WebChatClient;

const debug = () => `${host.output().slice(-3000)}\nmodel requests: ${model.requests.length}`;

beforeAll(async () => {
  model = await FakeModel.start();
  host = await startHost({ model, allowedChannels: [], modules: { "yesimbot-workspace": {} } });
  owner = await WebChatClient.login(host.url, host.admin.username, host.admin.password);
});

afterAll(async () => {
  await host?.stop();
  await model?.close();
});

describe("an ordinary tool in a conversation", () => {
  it("runs the tool, answers with what it returned and shows the call to the next turn", async () => {
    model.script = callThenReport("bash", () => ({ command: "echo $((4321 * 8765))" }));
    await owner.send("帮我算一下 4321 乘 8765");
    await waitUntil(async () => (await owner.botMessages()).length === 1, 20_000, debug);
    expect((await owner.botMessages())[0]!.text).toContain("37873565");

    // The next turn is shown the call and its output.
    model.script = replyOnce("记得");
    await owner.send("刚才算的是什么");
    await waitUntil(async () => (await owner.botMessages()).length === 2, 20_000, debug);
    const prompt = model.promptFor("刚才算的是什么");
    expect(prompt).toContain('"name":"bash"');
    expect(prompt).toContain("echo $((4321 * 8765))");
    expect(prompt).toContain("37873565");
  });
});

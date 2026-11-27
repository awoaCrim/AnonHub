import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { callThenReport, FakeModel, replyOnce } from "../src/fake-model.js";
import { startHost, waitUntil, type Host } from "../src/host.js";
import { WebChatClient } from "../src/web-client.js";

// Each file boots a whole host; also holds when the repository-wide run uses its shorter defaults.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const TENANT = randomUUID();
const DEVICE = randomUUID();

let model: FakeModel;
let host: Host;
let owner: WebChatClient;

const debug = () => `${host.output().slice(-3000)}\nmodel requests: ${model.requests.length}`;

beforeAll(async () => {
  model = await FakeModel.start();
  host = await startHost({
    model,
    allowedChannels: [],
    files: {
      "data/yesimbot/runtime-identity.json": { version: 1, tenantId: TENANT },
      "device/local.json": {
        version: 1,
        tenantId: TENANT,
        deviceId: DEVICE,
        name: "测试电脑",
        createdAt: 1,
        stateDirectory: "state",
        workspaceRoot: "workspace",
        policy: { version: 1, direct: { enabled: true, tools: ["*"] }, group: { enabled: false, tools: [] }, actors: [] },
        capabilities: { files: true, shell: true },
      },
    },
    modules: {
      "yesimbot-device-connection": { localConfigFile: "device/local.json" },
      "yesimbot-workspace": { computer: { deviceId: DEVICE } },
    },
  });
  owner = await WebChatClient.login(host.url, host.admin.username, host.admin.password);
});

afterAll(async () => {
  await host?.stop();
  await model?.close();
});

describe("a local device", () => {
  it("runs the model's command in its workspace and the output comes back in the reply", async () => {
    model.script = callThenReport("computer_exec", () => ({ command: "echo $((321 * 654)) > result.txt && cat result.txt" }));
    await owner.send("在我的电脑上算一下 321 乘 654，存到 result.txt");
    await waitUntil(async () => (await owner.botMessages()).length === 1, 20_000, debug);
    expect(model.turns()[0]!.tools.map((tool) => tool.function.name)).toContain("computer_exec");
    expect((await owner.botMessages())[0]!.text).toContain("209934");
    expect(await findFile(join(host.stateDir, "device/workspace"), "result.txt")).toBe("209934\n");

    // The next turn is shown the call and its result.
    model.script = replyOnce("记得");
    await owner.send("刚才在电脑上做了什么");
    await waitUntil(async () => (await owner.botMessages()).length === 2, 20_000, debug);
    const prompt = model.promptFor("刚才在电脑上做了什么");
    expect(prompt).toContain("computer_exec");
    expect(prompt).toContain("result.txt");
    expect(prompt).toContain("209934");
  });
});

/** The content of the first file called `name` below `directory`. */
async function findFile(directory: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found !== undefined) return found;
    } else if (entry.name === name) return readFile(path, "utf8");
  }
  return undefined;
}

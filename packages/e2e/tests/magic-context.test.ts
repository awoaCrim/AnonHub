import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FakeModel, replyOnce, type ModelRequest, type ModelScript } from "../src/fake-model.js";
import { FakeNapcat } from "../src/fake-napcat.js";
import { startHost, waitUntil, type Host } from "../src/host.js";

// Each file boots a whole host; also holds when the repository-wide run uses its shorter defaults.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const BOT = "10001";
const FRIEND = "20002";
const DIGEST = "整理后的要点：用户一直在聊第三号话题";

let model: FakeModel;
let host: Host;
let napcat: FakeNapcat;

const debug = () => `${host.output().slice(-3000)}\nmodel requests: ${model.requests.length}\nsends: ${napcat.sends.length}`;
const isSummary = (request: ModelRequest) => !request.tools.some((tool) => tool.function.name === "send_message");

beforeAll(async () => {
  model = await FakeModel.start();
  host = await startHost({
    model,
    qq: { account: BOT },
    contextTriggerTokens: 8000,
    allowedChannels: [{ platform: "onebot", channelId: `private:${FRIEND}` }],
  });
  napcat = await FakeNapcat.connect(host.onebotUrl!, BOT);
  await waitUntil(() => napcat.calls.some((call) => call.action === "get_login_info"), 10_000, debug);
});

afterAll(async () => {
  napcat?.close();
  await host?.stop();
  await model?.close();
});

describe("Magic Context", () => {
  it("summarizes a long conversation in the background and shows the model the summary afterwards", async () => {
    const answer = replyOnce("收到");
    const script: ModelScript = (request) =>
      isSummary(request) ? { text: JSON.stringify({ tiers: { P1: DIGEST, P2: DIGEST, P3: DIGEST, P4: DIGEST }, importance: 0.5 }) } : answer(request);
    model.script = script;
    // The model reports an input beyond the trigger, so each turn asks for a summary of what came before.
    model.promptTokens = 9000;

    // Summarizing runs in the background after a turn, so keep talking until a turn is shown the digest.
    const texts = Array.from({ length: 14 }, (_, index) => `第${index + 1}条：${"关于第三号话题的长篇讨论，".repeat(150)}`);
    let prompt: string | undefined;
    let current = "";
    for (const [index, text] of texts.entries()) {
      napcat.privateMessage(FRIEND, text);
      await waitUntil(() => napcat.sends.length === index + 1, 20_000, debug);
      // The previous turn's last model step can still arrive after its reply, so the turn is picked by its current message
      // (the prompt is the JSON of the messages, so the newline is escaped).
      current = text;
      prompt = model.promptFor(text);
      if (prompt?.includes(DIGEST)) break;
    }
    expect(prompt).toContain(DIGEST);
    expect(prompt).not.toContain("第1条");
    expect(prompt).toContain(current);
    expect(model.requests.filter(isSummary).length).toBeGreaterThan(0);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FakeModel, replyOnce } from "../src/fake-model.js";
import { FakeNapcat } from "../src/fake-napcat.js";
import { startHost, waitUntil, type Host } from "../src/host.js";

// Each file boots a whole host; also holds when the repository-wide run uses its shorter defaults.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const BOT = "10001";
const FRIEND = "20002";
/** A 1x1 red PNG. */
const PICTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

let model: FakeModel;
let host: Host;
let napcat: FakeNapcat;
let directory: string;

const debug = () => `${host.output().slice(-3000)}\nmodel requests: ${model.requests.length}\nsends: ${JSON.stringify(napcat.sends.map((send) => send.text))}`;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "yesimbot-e2e-media-"));
  model = await FakeModel.start();
  host = await startHost({ model, qq: { account: BOT }, vision: true, allowedChannels: [{ platform: "onebot", channelId: `private:${FRIEND}` }] });
  napcat = await FakeNapcat.connect(host.onebotUrl!, BOT);
  await waitUntil(() => napcat.calls.some((call) => call.action === "get_login_info"), 10_000, debug);
});

afterAll(async () => {
  napcat?.close();
  await host?.stop();
  await model?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("a picture sent on QQ", () => {
  it("reaches the model as image input, is kept as an asset for later turns and the reply is delivered", async () => {
    // NapCat saves what it receives on the machine it runs on and hands out the path.
    const file = join(directory, "photo.png");
    await writeFile(file, PICTURE);
    model.script = replyOnce("看到图片了");
    napcat.privateMessage(FRIEND, "看看这张图", { images: [pathToFileURL(file).href] });
    await waitUntil(() => napcat.sends.length > 0, 20_000, debug);
    expect(napcat.sends.map((send) => send.text)).toEqual(["看到图片了"]);

    const request = model.turns()[0]!;
    const parts = request.messages.flatMap((message) =>
      Array.isArray(message.content) ? (message.content as Array<{ type?: string; image_url?: { url: string } }>) : [],
    );
    const image = parts.find((part) => part.type === "image_url");
    expect(image?.image_url?.url).toBe(`data:image/png;base64,${PICTURE.toString("base64")}`);
    expect(request.prompt).toContain("看看这张图");

    // Later turns refer to it by its asset address.
    model.requests.length = 0;
    model.script = replyOnce("还记得");
    napcat.privateMessage(FRIEND, "刚才那张图还在吗");
    await waitUntil(() => napcat.sends.length === 2, 20_000, debug);
    expect(model.promptFor("刚才那张图还在吗")).toMatch(/asset:\/\/[0-9a-f]{32}/);
  });
});

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Channels } from "../src/channels/index.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Channels", () => {
  it("keeps one stable resources owner for each canonical scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-"));
    roots.push(root);
    const channels = new Channels({ basePath: root });
    const shared = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
    const direct = { type: "direct", platform: "test", selfId: "bot", channelId: "room", userId: "room" } as const;

    const [first, second] = await Promise.all([channels.get(shared), channels.get(shared)]);

    expect(first).toBe(second);
    expect(await channels.get(direct)).not.toBe(first);
  });
  it("keeps old channel configuration video-disabled and propagates video opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-video-"));
    roots.push(root);
    const shared = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
    const old = new Channels({ basePath: root });
    expect((await old.get(shared)).videoInput).toBe(false);
    const enabled = new Channels({ basePath: root, videoInput: true });
    expect((await enabled.get(shared)).videoInput).toBe(true);
  });

  it("passes image input and read timeout to newly created resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-config-"));
    roots.push(root);
    const channels = new Channels({ basePath: root, imageInput: true, readTimeoutMs: 5 });
    channels.use({
      scheme: "slow",
      prompt: "slow reader",
      setup: async (_resources, _uri, { signal }) =>
        new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    });
    const resources = await channels.get({ type: "guild", platform: "test", channelId: "room", guildId: "room" });

    expect(resources.imageInput).toBe(true);
    await expect(resources.open("slow:///file")).resolves.toBeUndefined();
  });
  it("leaves an old-layout directory alone and gives the conversation its canonical directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-old-layout-"));
    roots.push(root);
    // Records are versionless: Core neither migrates nor adopts the layouts it wrote before.
    const oldRoot = join(root, "channels", "shared-onebot-101");
    await mkdir(oldRoot, { recursive: true });
    await Promise.all([
      writeFile(join(oldRoot, "channel.json"), '{"type":"shared","platform":"onebot","channelId":"101","createdAt":"2026-08-01T00:00:00.000Z"}\n'),
      writeFile(join(oldRoot, "old.txt"), "old data\n"),
    ]);
    const channels = new Channels({ basePath: root });
    await channels.start();
    const channel = await channels.resolve({ type: "guild", platform: "onebot", channelId: "101", guildId: "101" });
    expect(channel.root).toBe(join(root, "channels", "guild-onebot-101"));
    await expect(readFile(join(oldRoot, "old.txt"), "utf8")).resolves.toBe("old data\n");
    expect((await readdir(join(root, "channels"))).sort()).toEqual(["guild-onebot-101", "shared-onebot-101"]);
    expect(JSON.parse(await readFile(join(channel.root, "channel.json"), "utf8"))).toMatchObject({
      type: "guild",
      platform: "onebot",
      channelId: "101",
      guildId: "101",
    });
  });

  it("refuses a conversation context that cannot name its directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-invalid-"));
    roots.push(root);
    const channels = new Channels({ basePath: root });
    await expect(channels.resolve({ type: "direct", platform: "onebot", channelId: "private", selfId: "bot" } as never)).rejects.toMatchObject({
      code: "channel_context_invalid",
    });
  });
});

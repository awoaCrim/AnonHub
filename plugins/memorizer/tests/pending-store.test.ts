import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PendingStore } from "../src/store/pending.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const channel = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;

async function store(): Promise<PendingStore> {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-pending-"));
  roots.push(root);
  const pending = new PendingStore(root);
  await pending.init();
  return pending;
}

describe("PendingStore", () => {
  it("deduplicates repeated candidate delivery and separates bots in the same group", async () => {
    const pending = await store();
    const one = { ...channel, selfId: "one" };
    const two = { ...channel, selfId: "two" };
    const input = { content: "稳定偏好", sources: ["source"], channel: one, turnId: "turn", messageCount: 1, queuedAt: 1 };
    const first = await pending.enqueue(input);
    expect((await pending.enqueue(input)).id).toBe(first.id);
    await pending.enqueue({ ...input, channel: two });
    expect(await pending.list()).toHaveLength(2);
    expect(await pending.nextBatch(one, 10, 300)).toHaveLength(1);
    expect(await pending.nextBatch(two, 10, 300)).toHaveLength(1);
  });
  it("keeps equal channel IDs on different platforms in separate batches and wakeups", async () => {
    const pending = await store();
    const qq = { ...channel, platform: "onebot" };
    const xhk = { ...channel, platform: "xiaoheihe" };
    const first = await pending.enqueue({ content: "qq", sources: ["same"], channel: qq, turnId: "same", messageCount: 1, queuedAt: 1 });
    await pending.enqueue({ content: "xhk", sources: ["same"], channel: xhk, turnId: "same", messageCount: 1, queuedAt: 1 });
    expect((await pending.nextBatch(qq, 10, 300)).map((row) => row.content)).toEqual(["qq"]);
    expect((await pending.nextBatch(xhk, 10, 300)).map((row) => row.content)).toEqual(["xhk"]);
    await pending.fail([first.id], new Error("pause"), 1, 1);
    await pending.enqueue({ content: "new xhk", sources: [], channel: xhk, turnId: "new", messageCount: 1, queuedAt: 2 });
    expect((await pending.list()).find((row) => row.id === first.id)?.suspended).toBe(true);
  });

  it("stores only requests and selects the ordered prefix with the overflow item", async () => {
    const pending = await store();
    await pending.enqueue({ content: "first", sources: ["one"], channel, turnId: "turn", messageCount: 200, queuedAt: 1 });
    await pending.enqueue({ content: "second", sources: ["two"], channel, turnId: "turn", messageCount: 200, queuedAt: 2 });
    const batch = await pending.nextBatch(channel, 10, 300);

    expect(batch.map((item) => item.content)).toEqual(["first", "second"]);
    expect(JSON.stringify(await pending.list())).not.toContain("messages");
  });

  it("only completes or retries selected entries and unsuspends a channel on new input", async () => {
    const pending = await store();
    const first = await pending.enqueue({ content: "first", sources: ["one"], channel, turnId: "turn", messageCount: 1, queuedAt: 1 });
    const second = await pending.enqueue({ content: "second", sources: ["two"], channel, turnId: "turn", messageCount: 1, queuedAt: 2 });
    await pending.fail([first.id], new Error("offline"), 1_000, 8);
    await pending.complete([second.id]);
    expect(await pending.list()).toMatchObject([{ id: first.id, attempts: 1, suspended: false, nextAttemptAt: 61_000 }]);

    await pending.fail([first.id], new Error("offline"), 2_000, 8);
    await pending.fail([first.id], new Error("offline"), 3_000, 8);
    await pending.fail([first.id], new Error("offline"), 4_000, 8);
    await pending.fail([first.id], new Error("offline"), 5_000, 8);
    await pending.fail([first.id], new Error("offline"), 6_000, 8);
    await pending.fail([first.id], new Error("offline"), 7_000, 8);
    await pending.fail([first.id], new Error("offline"), 8_000, 8);
    expect((await pending.list())[0]).toMatchObject({ suspended: true, attempts: 8 });
    await pending.enqueue({ content: "wake", sources: ["three"], channel, turnId: "turn", messageCount: 1, queuedAt: 9_000 });
    expect((await pending.list()).find((item) => item.id === first.id)).toMatchObject({ suspended: false, attempts: 8, nextAttemptAt: 9_000 });
  });
});

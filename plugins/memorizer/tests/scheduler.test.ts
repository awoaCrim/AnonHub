import { manualClock } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";

import { MemoryScheduler } from "../src/scheduler.js";

const host = { clock: manualClock(0), timer: () => () => undefined, interval: () => () => undefined };
const channel = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;

describe("MemoryScheduler", () => {
  it("schedules identical channel IDs separately for QQ and Xiaoheihe", async () => {
    const channels = ["onebot", "xiaoheihe"].map((platform) => ({ ...channel, platform }));
    const run = vi.fn(async (_context: unknown) => undefined);
    const scheduler = new MemoryScheduler(
      {
        nextDueAt: async () => undefined,
        list: async () => channels.map((context) => ({ id: context.platform, channel: context, nextAttemptAt: 0, suspended: false })),
        nextBatch: async (context: typeof channel) => [{ id: context.platform, channel: context }],
        complete: async () => undefined,
        fail: async () => undefined,
      } as never,
      run,
      host,
    );
    await scheduler.runDue(0);
    expect(run.mock.calls.map(([context]) => context)).toEqual(channels);
  });

  it("groups due pending requests by channel and serializes same-channel runs", async () => {
    const run = vi.fn(async () => undefined);
    const scheduler = new MemoryScheduler(
      {
        nextDueAt: async () => undefined,
        list: async () => [
          { id: "one", channel, nextAttemptAt: 0, suspended: false },
          { id: "two", channel, nextAttemptAt: 0, suspended: false },
        ],
        nextBatch: async () => [{ id: "one", channel, nextAttemptAt: 0, suspended: false }],
        complete: async () => undefined,
        fail: async () => undefined,
      } as never,
      run,
      host,
    );
    await Promise.all([scheduler.runDue(0), scheduler.runDue(0)]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(channel, [{ id: "one", channel, nextAttemptAt: 0, suspended: false }]);
  });
});

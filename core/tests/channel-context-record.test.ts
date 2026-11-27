import { describe, expect, it } from "vitest";

import { contextFromRecord, deriveChannelKey } from "../src/channels/context.js";
import type { EventRecord } from "../src/messages/index.js";

describe("contextFromRecord", () => {
  it("keeps the bot of guild and channel records so plugin claims can match it", () => {
    const record = { platform: "xiaoheihe", selfId: "33785756", channel: { id: "account:33785756", type: 0 }, timestamp: 1 } as unknown as EventRecord;
    const guild = contextFromRecord(record)!;
    expect(guild).toMatchObject({ type: "guild", selfId: "33785756" });
    // The storage key does not depend on the bot, so existing channel history is unchanged.
    expect(deriveChannelKey(guild)).toBe(JSON.stringify(["guild-v2", "xiaoheihe", "33785756", "account:33785756"]));
    const channel = contextFromRecord({ ...record, guild: { id: "g" } } as unknown as EventRecord)!;
    expect(channel).toMatchObject({ type: "channel", guildId: "g", selfId: "33785756" });
  });
});

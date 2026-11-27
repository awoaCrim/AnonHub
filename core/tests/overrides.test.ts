import { describe, expect, it, vi } from "vitest";

import { ChannelOverrides } from "../src/overrides.js";
import { Runtimes } from "../src/runtimes/index.js";

const web = (userId: string) => ({ type: "direct", platform: "web", selfId: "bot", userId, channelId: userId }) as const;

describe("ChannelOverrides", () => {
  it("keeps each conversation's choices apart and releases its runtime only when they change", async () => {
    const release = vi.fn(async () => {});
    const overrides = new ChannelOverrides(release);
    await overrides.set(web("owner.0a1b2c3d"), { chatModel: "openai:gpt", roleCard: "" });
    expect(overrides.get(web("owner.0a1b2c3d"))).toEqual({ chatModel: "openai:gpt", roleCard: "" });
    expect(overrides.get(web("owner"))).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
    await overrides.set(web("owner.0a1b2c3d"), { roleCard: "", chatModel: "openai:gpt" });
    expect(release).toHaveBeenCalledTimes(1);
    await overrides.set(web("owner.0a1b2c3d"), undefined);
    expect(overrides.get(web("owner.0a1b2c3d"))).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("uses a conversation's own model only while it is registered", () => {
    const overrides = { get: (context: { userId?: string }) => (context.userId === "owner.0a1b2c3d" ? { chatModel: "openai:gpt" } : undefined) };
    const models = ["openai:gpt", "google:gemini"];
    const runtimes = new Runtimes(
      { logger: () => ({ level: 2, debug() {}, warn() {} }), on: () => () => {} } as never,
      {} as never,
      { listChatModels: () => models.map((fullId) => ({ fullId, config: {} })) } as never,
      { chatModel: "google:gemini" } as never,
      {} as never,
      undefined,
      overrides,
    );
    expect(runtimes.chatModelFor(web("owner.0a1b2c3d"))).toBe("openai:gpt");
    expect(runtimes.chatModelFor(web("owner"))).toBe("google:gemini");
    models.splice(0, 1);
    expect(runtimes.chatModelFor(web("owner.0a1b2c3d"))).toBe("google:gemini");
  });
});

import { systemClock } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";

import { identity, policy } from "../../../tests/tool-policy.js";
import { extension } from "../src/extension.js";

describe("search-service extension", () => {
  it("registers with Core when started and withdraws when stopped", async () => {
    const dispose = vi.fn();
    const use = vi.fn(() => dispose);
    const get = vi.fn(async () => ({ artifacts: { forTool: () => ({ put: vi.fn() }) }, maxBytes: 1024 }));
    const config = extension.parse({ provider: "tavily", tavily: { apiKey: "test" } });
    expect(use).not.toHaveBeenCalled();

    const stop = extension.start({ config, clock: systemClock(), core: { identity, resource: { get }, agent: { use } } } as never) as () => void;
    expect(use).toHaveBeenCalledOnce();
    const registered = (use.mock.calls[0] as unknown as [{ id: string; setup: (...args: unknown[]) => Promise<{ tools?: { name: string }[] } | null> }])[0];
    expect(registered.id).toBe("yesimbot-search-service");
    const plugin = await registered.setup({ type: "guild", platform: "onebot", channelId: "room", guildId: "room" }, { selfId: "bot" });
    expect(plugin?.tools?.map((tool) => tool.name)).toContain("search_web");
    expect(get).toHaveBeenCalledOnce();

    stop();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

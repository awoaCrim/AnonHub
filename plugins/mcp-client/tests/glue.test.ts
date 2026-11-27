import { systemClock } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";

import { identity, policy } from "../../../tests/tool-policy.js";
import { extension } from "../src/extension.js";

describe("mcp-client extension", () => {
  it("publishes its plugin to Core when started and withdraws it when stopped", async () => {
    const dispose = vi.fn();
    const use = vi.fn(() => dispose);
    const config = extension.parse({ mcpServers: {} });
    expect(use).not.toHaveBeenCalled();

    const stop = (await extension.start({
      config,
      clock: systemClock(),
      core: { identity, resource: { get: vi.fn() }, agent: { use } },
    } as never)) as () => Promise<void>;
    expect(use).toHaveBeenCalledOnce();
    expect((use.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe("yesimbot-mcp-client");

    await stop();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

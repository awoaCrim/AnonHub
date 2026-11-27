import { manualClock, type Clock } from "@yesimbot/foundation";

import type { Config } from "../src/config.js";
import { McpService } from "../src/service.js";

/** What the tests' fake host context offers Core, in the shape the service takes. */
interface FakeContext {
  readonly yesimbot: {
    identity: { conversation(scope: never): Promise<never> };
    resource: { get(scope: never): Promise<never> };
    agent: { use(plugin: never): () => void };
  };
}

/** The service on a fake host. The clock starts at a fixed instant; advance it to age confirmations. */
export function createService(ctx: FakeContext, config: Config, clock: Clock = manualClock(Date.UTC(2026, 10, 24))): McpService {
  return new McpService(
    config,
    {
      conversation: (scope) => ctx.yesimbot.identity.conversation(scope as never),
      resources: (scope) => ctx.yesimbot.resource.get(scope as never),
      publish: (plugin) => ctx.yesimbot.agent.use(plugin as never),
    },
    clock,
  );
}

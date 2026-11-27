import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { McpService } from "./service.js";

/** MCP servers' tools, published to Core as one agent plugin once connected. */
export const extension = defineExtension({
  moduleConfig,
  async start(ctx) {
    const service = new McpService(
      ctx.config,
      {
        conversation: (scope) => ctx.core.identity.conversation(scope),
        resources: (scope) => ctx.core.resource.get(scope),
        publish: (plugin) => ctx.core.agent.use(plugin),
      },
      ctx.clock,
    );
    await service.start();
    return () => service.stop();
  },
});

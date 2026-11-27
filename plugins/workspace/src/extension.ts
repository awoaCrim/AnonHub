import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { WorkspaceService } from "./service.js";

/** The virtual file system and the Bash sandbox for the agent. */
export const extension = defineExtension({
  moduleConfig,
  async start(ctx) {
    const service = new WorkspaceService({ host: ctx.core, baseDir: ctx.baseDir, clock: ctx.clock }, ctx.config);
    await service.start();
    return () => service.stop();
  },
});

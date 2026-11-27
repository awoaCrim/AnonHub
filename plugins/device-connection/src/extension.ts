import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { openDeviceConnection } from "./connection.js";

/** Opens the configured device connection and attaches it to Core's device registry. */
export const extension = defineExtension({
  moduleConfig,
  async start(ctx) {
    const connection = await openDeviceConnection(ctx.config, ctx.baseDir, await ctx.core.identity.tenantId());
    let detach: () => void;
    try {
      detach = ctx.core.devices.use(connection.transport);
    } catch (error) {
      await connection.close();
      throw error;
    }
    return async () => {
      detach();
      await connection.close();
    };
  },
});

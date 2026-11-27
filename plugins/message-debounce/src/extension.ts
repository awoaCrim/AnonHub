import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { MessageDebounce } from "./debounce.js";

/** Trailing-edge debounce of ordinary group messages: one batch registration with Core, timers from the host. */
export const extension = defineExtension({
  moduleConfig,
  start(ctx) {
    const debounce = new MessageDebounce(ctx.config, (callback, milliseconds) => ctx.setTimeout(callback, milliseconds));
    const unregister = ctx.core.message.use(debounce);
    return () => {
      unregister();
      debounce.stop();
    };
  },
});

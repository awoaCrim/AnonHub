import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { OnebotUtils } from "./tools.js";

/** QQ-only actions (forwards, reactions, essence, group management): one agent plugin registered with Core. */
export const extension = defineExtension({
  moduleConfig,
  start(ctx) {
    return ctx.core.agent.use(new OnebotUtils(ctx.core, ctx.config));
  },
});

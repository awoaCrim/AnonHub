import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { Roleplay } from "./roleplay-service.js";

/** Role cards: the chosen card's character for a conversation, and the bot's own card. */
export const extension = defineExtension({
  moduleConfig,
  async start(ctx) {
    const roleplay = new Roleplay(ctx.core, ctx.config, ctx.baseDir);
    await roleplay.start();
    return () => roleplay.stop();
  },
});

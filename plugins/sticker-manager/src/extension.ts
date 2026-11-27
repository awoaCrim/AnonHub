import { join } from "node:path";

import { parseConfig } from "@yesimbot/foundation";
import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { StickerFileStore } from "./files.js";
import { StickerManager } from "./manager.js";
import { StickerStore } from "./store.js";
import { SqliteStickerTable } from "./table.js";

/** Sticker files live under `<baseDir>/data/yesimbot/sticker-manager/files`. */
const STICKER_STORAGE_PATH = "data/yesimbot/sticker-manager";

/** Stickers: the SQLite table, the files and one agent plugin registered with Core. */
export const extension = defineExtension({
  moduleConfig,
  parse: (raw) => parseConfig(moduleConfig, raw ?? {}),
  async start(ctx) {
    const files = new StickerFileStore(join(ctx.baseDir, STICKER_STORAGE_PATH, "files"));
    const manager = new StickerManager(ctx.config, new StickerStore(new SqliteStickerTable(), files, ctx.clock), {
      resources: (scope) => ctx.core.resource.get(scope),
      conversation: (scope) => ctx.core.identity.conversation(scope),
    });
    await manager.start();
    const unregister = ctx.core.agent.use(manager);
    return async () => {
      await manager.stop();
      unregister();
    };
  },
});

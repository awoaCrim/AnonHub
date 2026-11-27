import { resolve } from "node:path";

import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { memoryLibraryService } from "./library-service.js";
import { MemorizerService } from "./service.js";
import { sqliteMemoryTable } from "./store/sqlite.js";

/** Long-term memory with evidence: the memory table in the shared SQLite, host timers, the owner check and the `yesimbotMemory` service. */
export const extension = defineExtension({
  moduleConfig,
  async start(ctx) {
    const service = new MemorizerService(
      {
        host: ctx.core,
        table: sqliteMemoryTable(),
        root: resolve(ctx.baseDir, "data/yesimbot/memorizer"), // Evidence and legacy pending-queue directory, resolved against the instance directory.
        clock: ctx.clock,
        timer: (callback, milliseconds) => ctx.setTimeout(callback, milliseconds),
        interval: (callback, milliseconds) => ctx.setInterval(callback, milliseconds),
        isOwner: (context) => ctx.isOwnerContext(context),
      },
      ctx.config,
    );
    ctx.provide("yesimbotMemory", memoryLibraryService(service.library));
    await service.start();
    return () => service.stop();
  },
});

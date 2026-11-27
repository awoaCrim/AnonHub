import { stateDb } from "@yesimbot/foundation";
import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { ScheduleService } from "./service.js";
import { sqliteScheduleTable } from "./table.js";

/** Persistent schedules: the table in the shared SQLite, host timers and the `yesimbotSchedule` service the console reads. */
export const extension = defineExtension({
  moduleConfig,
  async start(ctx) {
    const service = new ScheduleService(
      {
        table: sqliteScheduleTable(),
        host: ctx.core,
        timer: (callback, milliseconds) => ctx.setTimeout(callback, milliseconds),
        clock: ctx.clock,
        stateHost: stateDb(),
        publish: (manager) => {
          ctx.provide("yesimbotSchedule", manager);
          // The host removes the provided service when the extension stops.
          return () => {};
        },
      },
      ctx.config,
    );
    await service.start();
    return () => service.stop();
  },
});

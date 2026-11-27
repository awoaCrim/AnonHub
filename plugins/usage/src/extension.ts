import { resolve } from "node:path";

import { defineExtension, type ModelUsageEvent } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { JsonlUsageHistory } from "./jsonl.js";
import { normalizeLanguageUsage } from "./middleware.js";
import { UsageService } from "./service.js";
import { UsageStore } from "./store.js";
import { sqliteUsageTable } from "./table.js";

/** Token usage of every model call, kept in the aggregate table and read back as a dashboard snapshot. */
export const extension = defineExtension({
  moduleConfig,
  start(ctx) {
    // History is scanned from the session JSONL files under Core's data directory; the aggregate table is still written for every call.
    const dataRoot = resolve(ctx.baseDir, ctx.core.config.basePath || "data/yesimbot");
    const store = new UsageStore(sqliteUsageTable(), new JsonlUsageHistory(dataRoot), ctx.clock);
    const service = new UsageService(store);
    let cancelChanged: (() => void) | undefined;
    // Trailing-edge debounce: every call restarts the quiet window.
    const changedSoon = () => {
      cancelChanged?.();
      cancelChanged = ctx.setTimeout(() => {
        cancelChanged = undefined;
        service.changed();
      }, CHANGED_DEBOUNCE_MS);
    };
    ctx.on("yesimbot/model-usage", (event: ModelUsageEvent) => {
      store.record({
        providerId: event.providerId,
        modelId: event.providerModelId,
        timestamp: event.timestamp,
        kind: event.kind,
        usage: normalizeLanguageUsage(event.usage),
      });
      changedSoon();
    });
    ctx.provide("yesimbotUsage", service);
    ctx.setInterval(() => service.changed(), REFRESH_INTERVAL_MS);
    ctx.setInterval(() => store.tickRate(), 1_000);
    return () => cancelChanged?.();
  },
});

/** How often subscribers (status bar, overview, usage page) are told to re-read the snapshot. */
const REFRESH_INTERVAL_MS = 5_000;

/** Quiet time after a model call before subscribers are told. */
const CHANGED_DEBOUNCE_MS = 1_000;

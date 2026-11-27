import { resolve } from "node:path";

import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { GoogleManager } from "./connector.js";
import { googleError } from "./errors.js";
import { GOOGLE_PLUGIN_ID, googlePlugin } from "./plugin.js";
import { sharedAppReader, usesSharedApp } from "./shared-app.js";
import { GoogleStore } from "./store.js";

/** Google OAuth connections and tools: the manager is provided as `yesimbotGoogle`, the tools register per conversation. */
export const extension = defineExtension({
  moduleConfig,
  async start(ctx) {
    const config = ctx.config;
    const tenant = await ctx.core.identity.tenantId();
    const store = await vault(resolve(ctx.baseDir, "data/yesimbot/google"), tenant);
    const shared = usesSharedApp();
    const manager = new GoogleManager(store, shared ? sharedAppReader() : config, ctx.clock, shared);
    let stopped = false;
    ctx.provide("yesimbotGoogle", manager);
    const unregister = ctx.core.agent.use({
      id: GOOGLE_PLUGIN_ID,
      async setup(scope, bot) {
        if (stopped) return null;
        return googlePlugin(manager, await ctx.core.identity.conversation({ ...scope, selfId: scope.selfId ?? bot.selfId }));
      },
    });
    return () => {
      stopped = true;
      manager.close();
      unregister();
    };
  },
});

// Loader can start the replacement before the previous plugin drains. Share one serialization
// queue for a vault throughout this process; a hot reload must never create competing writers.
const registryKey = Symbol.for("yesimbot.google.vaults.v1");

const processState = globalThis as unknown as Record<symbol, Vaults>;

const vaults = (processState[registryKey] ??= new Map());

type Vaults = Map<string, { tenant: string; store: Promise<GoogleStore> }>;

function vault(directory: string, tenant: string): Promise<GoogleStore> {
  const previous = vaults.get(directory);
  if (previous) {
    if (previous.tenant !== tenant) throw googleError("google_store_invalid", { detail: "tenant" });
    return previous.store;
  }
  const store = GoogleStore.open(directory, tenant);
  const entry = { tenant, store };
  vaults.set(directory, entry);
  void store.catch(() => {
    if (vaults.get(directory) === entry) vaults.delete(directory);
  });
  return store;
}

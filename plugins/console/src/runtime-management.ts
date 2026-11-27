import { readAdminLoginBody, type AdminAuth } from "./admin-auth.js";
import { isObject } from "./config/secrets.js";
import { ConfigStore } from "./config/store.js";
import { contextPolicy } from "./context-policy.js";
import type { Host } from "./host.js";
import { pluginBaseName } from "./shared/plugin-catalog.js";
import type { TenantManagerClient } from "./tenant-manager-client.js";

/** Parent-only routes: never proxied to a local bot or exposed with a member identity. */
export function installRuntimeManagement(ctx: Host, auth: AdminAuth, manager: TenantManagerClient, ownerRuntimeId?: string) {
  ctx.server.get("/yesimbot/admin/runtime", async (http) => {
    if (!auth.requireOwner(http)) return;
    if (!ownerRuntimeId) {
      http.body = { available: false };
      return;
    }
    try {
      http.body = { available: true, runtime: await manager.runtime(ownerRuntimeId) };
    } catch {
      http.body = { available: true, runtime: { id: ownerRuntimeId, state: "error", location: "local", errorCode: "local_runtime_offline" } };
    }
  });
  ctx.server.post("/yesimbot/admin/runtime", async (http) => {
    if (!auth.requireOwner(http)) return;
    if (!auth.sameOrigin(http)) {
      http.status = 403;
      return;
    }
    const body = (await readAdminLoginBody(http, 2048)) as { action?: unknown };
    if (!ownerRuntimeId || !["start", "stop"].includes(String(body.action))) {
      http.status = 400;
      return;
    }
    http.body = { available: true, runtime: await manager.runtime(ownerRuntimeId, body.action as "start" | "stop") };
  });
  const store = new ConfigStore(ctx);
  const core = (tree: Record<string, unknown>, prefix = ""): { path: string; config: Record<string, unknown> } | undefined => {
    for (const [key, value] of Object.entries(tree)) {
      if (key.startsWith("~") || !isObject(value)) continue;
      if (pluginBaseName(key) === "yesimbot") return { path: prefix + key, config: value };
      if (pluginBaseName(key) === "group") {
        const found = core(value, prefix + key + "/");
        if (found) return found;
      }
    }
  };
  ctx.server.get("/yesimbot/admin/context-policy", (http) => {
    if (!auth.requireOwner(http)) return;
    const entry = core(ctx.loader.config.plugins as Record<string, unknown>);
    if (!entry) {
      http.status = 503;
      return;
    }
    http.body = { revision: store.revision(), policy: contextPolicy(entry.config.session) };
  });
  ctx.server.post("/yesimbot/admin/context-policy", async (http) => {
    if (!auth.requireOwner(http)) return;
    if (!auth.sameOrigin(http)) {
      http.status = 403;
      return;
    }
    try {
      const input = (await readAdminLoginBody(http, 16384)) as { revision?: unknown; session?: unknown };
      if (typeof input.revision !== "string") {
        http.status = 400;
        return;
      }
      const policy = contextPolicy(input.session);
      await store.transaction(input.revision, async () => {
        const entry = core(ctx.loader.config.plugins as Record<string, unknown>);
        if (!entry) throw new Error("core_unavailable");
        await store.updateRaw(entry.path, { ...entry.config, session: policy.session });
      });
      http.body = { revision: store.revision(), policy };
    } catch {
      http.status = 409;
      http.body = { message: "context_policy_update_failed" };
    }
  });
}

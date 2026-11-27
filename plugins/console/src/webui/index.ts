import { resolve } from "node:path";

import type { AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import { installInstanceManagement } from "../instance-management.js";
import { log } from "../log.js";
import { PanelSource } from "../panel-source.js";
import type { QQPresence } from "../qq-presence.js";
import type { BootstrapResponse, WebUIFeatures } from "../shared/webui.js";
import type { DesktopRelay } from "../tenant-runtime-proxy.js";
import { installUsageRead } from "./accounts-usage.js";
import { installBotHooks } from "./bot-hooks.js";
import { installCallCounter } from "./call-counter.js";
import { installCharacters } from "./characters.js";
import { installChat } from "./chat.js";
import { installContacts } from "./contacts.js";
import { installDevices } from "./devices.js";
import { installEvents, type EventsOptions } from "./events.js";
import { installExtensions } from "./extensions.js";
import { installFiles } from "./files.js";
import { installGlobalBrain } from "./global-brain.js";
import { installGoogle } from "./google.js";
import { installHistory } from "./history.js";
import { installMemory } from "./memory.js";
import { installPlugins } from "./plugins.js";
import { installPromptOverview } from "./prompt.js";
import { installSchedules } from "./schedules.js";
import { fillContact, installStatic, loadAssets } from "./static.js";
import { installSummary } from "./summary.js";
import { installSystem } from "./system.js";
import { installTasks } from "./tasks.js";
import { installToolCatalog } from "./tool-catalog.js";
import { TopicRegistry } from "./topics.js";
import { installXiaoheihe } from "./xiaoheihe.js";

export const BOOTSTRAP_PATH = "/yesimbot/api/v1/bootstrap";

export const FEATURES_PATH = "/yesimbot/api/v1/features";

export interface WebUIOptions {
  desktopRelay?: DesktopRelay;
  assetsDir: string;
  /** Named on the public pages; empty says 本实例管理员. */
  contactEmail?: string;
  features: Pick<WebUIFeatures, "napcat" | "wechat" | "accounts" | "tenant">;
  /** Extra path prefixes still owned by another UI, e.g. the Koishi console while both coexist. */
  excludedPrefixes?: readonly string[];
  events?: EventsOptions;
  /** NapCat's QQ online state, for the platform state in the panel. */
  qqPresence?: QQPresence;
}

/** Console-independent WebUI backend: no Koishi console frontend, protocol or config-writer imports. */
export function installWebUI(ctx: Host, auth: AdminAuth, options: WebUIOptions) {
  const assets = fillContact(loadAssets(options.assetsDir), options.contactEmail ?? "");
  const topics = new TopicRegistry();
  installEvents(ctx, auth, topics, options.events);
  installUsageRead(ctx, auth, topics);
  installChat(ctx, auth, topics);
  installTasks(ctx, auth, topics);
  installExtensions(ctx, auth);
  const { store, catalog, logSecrets } = installPlugins(ctx, auth, topics);
  installInstanceManagement(ctx, logSecrets);
  installSystem(ctx, auth, topics, catalog, logSecrets, options.features.tenant);
  installFiles(ctx, auth);
  installCharacters(ctx, auth, store);
  installToolCatalog(ctx, auth);
  installMemory(ctx, auth);
  installContacts(ctx, auth);
  installSchedules(ctx, auth, () => store.permitted("yesimbot-schedule"));
  installGoogle(ctx, auth, store, options.features.tenant, assets.get("/google-callback.html")?.body.toString("utf8"));
  const calls = installCallCounter(ctx, resolve(ctx.baseDir, "data/console-admin/today-calls.json"));
  installSummary(ctx, auth, topics, calls);
  const features = (): WebUIFeatures => ({
    ...options.features,
    usage: store.permitted("yesimbot-usage"),
  });

  // Parent-local for members: it reports the member identity, not the child's backend login.
  ctx.server.get(BOOTSTRAP_PATH, (http) => {
    http.set("Cache-Control", "private, no-store");
    const session = auth.sessionFromCookie(http.get("cookie"));
    const body: BootstrapResponse = {
      authenticated: !!session,
      features: features(),
      ...(session ? { session: { username: session.username, role: session.role === "member" ? "member" : "owner", expiresAt: session.expiresAt } } : {}),
    };
    http.body = body;
  });
  // Relayed for running members, so it describes whichever runtime serves their data.
  ctx.server.get(FEATURES_PATH, (http) => {
    http.set("Cache-Control", "private, no-store");
    if (!auth.sessionFromCookie(http.get("cookie"))) {
      http.status = 401;
      http.body = { message: "login_required" };
      return;
    }
    http.body = { features: features() };
  });

  ctx.inject(["yesimbot"], (ctx) => {
    installDevices(ctx, auth, options.desktopRelay);
    installBotHooks(ctx, auth);
    installXiaoheihe(ctx, auth);
    const panel = new PanelSource(ctx, options.qqPresence);
    ctx.on(
      "dispose",
      topics.register({
        name: "panel",
        authorize: (session) => session.role !== "member",
        get: () => panel.get(),
        subscribe: (listener) => panel.subscribe(listener),
      }),
    );
    installHistory(ctx, auth, topics);
    installGlobalBrain(ctx, auth);
    installPromptOverview(ctx, auth);
  });
  // Provided by koishi-plugin-yesimbot-usage when installed; no package dependency.
  ctx.inject(["yesimbotUsage"], (ctx) => {
    const usage = ctx.get("yesimbotUsage") as { snapshot(): Promise<unknown>; subscribe(listener: () => void): () => void };
    ctx.on(
      "dispose",
      topics.register({
        name: "usage",
        authorize: (session) => session.role !== "member" && store.permitted("yesimbot-usage"),
        get: () => usage.snapshot(),
        subscribe: (listener) => usage.subscribe(listener),
      }),
    );
  });

  if (assets.has("/index.html")) installStatic(ctx, assets, { excludedPrefixes: options.excludedPrefixes });
  else log.warn("webui.assets_missing", { dir: options.assetsDir });
  return { topics, calls };
}

export type { BootstrapResponse, WebUIFeatures } from "../shared/webui.js";

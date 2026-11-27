import { resolve } from "node:path";

import { AppError, defineErrors, type Clock } from "@yesimbot/foundation";

import { AccountStore, installAccountRoutes, memberId } from "./accounts.js";
import { installAdminAuth, type AdminAuth } from "./admin-auth.js";
import type { Config } from "./config.js";
import { ConfigStore } from "./config/store.js";
import type { Host } from "./host.js";
import { installLocalOneBotRelay } from "./local-onebot-relay.js";
import { installManagedOneBotIngress } from "./managed-ingress.js";
import { installModelSettings } from "./model-settings.js";
import { installNapCatGateway } from "./napcat.js";
import { QQPresence } from "./qq-presence.js";
import { installRuntimeManagement } from "./runtime-management.js";
import { TenantManagerClient } from "./tenant-manager-client.js";
import { installTenantRuntimeProxy } from "./tenant-runtime-proxy.js";
import { installAccountsHealth } from "./webui/accounts-health.js";
import { installAccountsUsage } from "./webui/accounts-usage.js";
import { installGoogleAppPublisher } from "./webui/google.js";
import { installWebUI } from "./webui/index.js";
import { installInstanceOps } from "./webui/instance-ops.js";
import { readSummary } from "./webui/summary.js";
import { installWechatLogin } from "./wechat-login.js";

export const CONSOLE_ERRORS = defineErrors({
  console_host_unsupported: { model: "这个宿主还不能运行这种实例的控制台。", user: "这个宿主还不能运行这种实例的控制台。", status: 500 },
});

/** What only one host has; the host passes what it supports. */
export interface ConsoleHooks {
  /** A member runtime (the host manager sets `YESIMBOT_TENANT_ID`): the plugin grant and the member context. */
  memberRuntime?(): void;
  /** `YESIMBOT_MANAGED_CONTEXT=1` outside a member runtime. */
  managedContext?(): void;
  /** The admin login also guards the host's own console. */
  adminAuth?(auth: AdminAuth): void;
  /** Called after a logout. */
  loggedOut?(): void;
  /** Accounts are on: publish the context policy members read. */
  contextPublisher?(): void;
}

/** The console's settings that need the admin login; thrown when the module loads. */
export function checkConsoleConfig(config: Config): void {
  const { admin, napcat, wechat } = config;
  if (napcat.enabled && !admin.enabled) throw new Error("NapCat 管理需要先启用单管理员登录。");
  if (wechat.enabled && !admin.enabled) throw new Error("微信登录管理需要先启用单管理员登录。");
  if (config.webui.enabled && !admin.enabled) throw new Error("独立 WebUI 需要先启用单管理员登录。");
  if (config.accounts?.enabled && !admin.enabled) throw new Error("Accounts require administrator authentication.");
}

/** The console on a host: admin login, account management, the WebUI and its routes. */
export function installConsole(host: Host, config: Config, clock: Clock, hooks: ConsoleHooks = {}): void {
  const { admin, napcat, wechat } = config;
  // Member runtimes only: the host manager sets this ID and mounts the plugin grant read-only. A host that cannot enforce
  // the grant, the member context or the published policy does not run the console at all.
  const need = (hook: (() => void) | undefined, what: string) => {
    if (!hook) throw new AppError(CONSOLE_ERRORS.console_host_unsupported, { effect: "none", detail: what });
    hook();
  };
  if (config.accounts?.enabled && !hooks.contextPublisher) throw new AppError(CONSOLE_ERRORS.console_host_unsupported, { effect: "none", detail: "accounts" });
  if (memberId.test(process.env.YESIMBOT_TENANT_ID ?? "")) need(hooks.memberRuntime, "member runtime");
  else if (process.env.YESIMBOT_MANAGED_CONTEXT === "1") need(hooks.managedContext, "managed context");
  const auth = installAdminAuth(host, admin, { onLogout: () => hooks.loggedOut?.() });
  hooks.adminAuth?.(auth);
  // Shared by the NapCat gateway (which checks it) and the panel (which shows it).
  const qqPresence = new QQPresence();
  let accounts: { store: AccountStore; manager: TenantManagerClient } | undefined;
  let desktopRelay: ReturnType<typeof installTenantRuntimeProxy> | undefined;
  if (config.accounts?.enabled) {
    const store = new AccountStore(resolve(host.baseDir, config.accounts.usersFile ?? "data/console-admin/accounts.json"), () => auth.ownerUsername(), clock);
    auth.accounts = store;
    store.ready.catch(() => {});
    host.on("ready", () => store.ready);
    const manager = new TenantManagerClient(
      config.accounts.managerEndpoint ?? "",
      resolve(host.baseDir, config.accounts.managerKeyFile ?? "data/console-admin/runtime-manager.key"),
    );
    desktopRelay = installTenantRuntimeProxy(host, auth, manager, config.accounts.ownerRuntimeId);
    installAccountRoutes(host, auth, store, manager);
    installRuntimeManagement(host, auth, manager, config.accounts.ownerRuntimeId);
    installInstanceOps(host, auth, manager);
    if (config.accounts.ownerRuntimeId && napcat.enabled)
      installLocalOneBotRelay(host, manager, config.accounts.ownerRuntimeId, config.accounts.ownerOneBotPath);
    accounts = { store, manager };
    need(hooks.contextPublisher, "accounts");
    installGoogleAppPublisher(host, new ConfigStore(host));
  }
  // After the tenant proxy: static assets are identical for members and stay cacheable.
  if (config.webui?.enabled) {
    const { topics, calls } = installWebUI(host, auth, {
      qqPresence,
      desktopRelay,
      // The built SPA, next to this package's `lib/`.
      assetsDir: resolve(__dirname, "../dist/app"),
      contactEmail: config.webui.contactEmail,
      features: {
        napcat: napcat.enabled,
        wechat: wechat.enabled,
        accounts: !!config.accounts?.enabled,
        tenant: memberId.test(process.env.YESIMBOT_TENANT_ID ?? ""),
      },
      excludedPrefixes: [config.webui.koishiPath ?? "/koishi", ...(process.env.YESIMBOT_LOCAL_INSTANCE_ID ? ["/yesimbot/local/"] : [])],
    });
    if (accounts) installAccountsUsage(host, auth, accounts.store, accounts.manager);
    if (accounts) installAccountsHealth(host, auth, accounts.store, accounts.manager, (session) => readSummary(topics, session, calls));
  }
  if (napcat.enabled) installManagedOneBotIngress(host);
  installNapCatGateway(host, napcat, auth, qqPresence);
  installWechatLogin(host, wechat, auth);
  installModelSettings(host, auth);
  host.inject(["yesimbot"], (scope) => {
    if (process.env.YESIMBOT_LOCAL_INSTANCE_ID)
      scope.server.get("/yesimbot/local/health", async (http) => {
        const id = await scope.yesimbot.identity.tenantId();
        const ready = id === process.env.YESIMBOT_LOCAL_INSTANCE_ID && scope.yesimbot.devices.available;
        http.status = ready ? 200 : 503;
        http.body = { ready, instanceId: id };
      });
  });
}

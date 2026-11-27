import { AppError, defineErrors, errorFields, logger, systemClock } from "@yesimbot/foundation";
import type { CoreService } from "koishi-plugin-yesimbot/kernel";

import { Accounts } from "./accounts.js";
import { loadHostConfig, type HostConfig } from "./config.js";
import { serveDownloads } from "./downloads.js";
import { EventBus } from "./events.js";
import type { Module, ModuleState, Services } from "./extensions.js";
import { HttpServer } from "./http.js";
import { Installs, type Installer } from "./installs.js";
import { LogFanout } from "./logs.js";
import { MemberPolicy } from "./member.js";
import { CONSOLE_MODULE, CORE_MODULE, Modules } from "./modules.js";
import { EXTENSIONS } from "./registry.js";

export const HOST_ERRORS = defineErrors({
  host_core_missing: { model: "宿主没有 Core 的配置，无法启动。", user: "config/yesimbot.json 不存在或被停用了。", status: 500 },
});

const log = logger("host");

export interface ServerOptions {
  /** The instance directory: `config/` and `data/` live here. */
  readonly stateDir: string;
  /** `YESIMBOT_TENANT_ID` names the member runtime this instance serves. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The extensions to run, in start order; the registry when absent. */
  readonly extensions?: readonly Module[];
  /** How a package is installed (tests); Yarn from npm when absent. */
  readonly installer?: Installer;
  /** Where the account manager's policy files are (`/run/yesimbot/policy/…` when absent) and how often they are read. */
  readonly policyFiles?: { readonly plugins?: string; readonly context?: string; readonly intervalMs?: number };
}

export interface RunningServer {
  readonly config: HostConfig;
  /** The running Core; a console edit of its config replaces it. */
  readonly core: CoreService;
  readonly http: HttpServer;
  readonly events: EventBus;
  readonly accounts: Accounts;
  /** Services by name: Core (`yesimbot`) and what the extensions provide. */
  readonly services: Services;
  /** Each registered extension's state. */
  readonly modules: ReadonlyMap<string, ModuleState>;
  /** Core's and the console's states, and the extensions'. */
  state(id: string): ModuleState | undefined;
  /** Packages installed from npm, as the console installs and removes them; `ids` are the modules the console lists. */
  readonly installs: Pick<Modules, "extensions" | "install" | "uninstall" | "ids">;
  /** Resolves once every change the console applied settled. */
  idle(): Promise<void>;
  /** Stops taking requests, then the console, the extensions and Core. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * The host: reads `config/`, composes Core, starts the console and the registry's extensions and connectors, then
 * listens. A start that fails part way stops what it had started and
 * rethrows; one extension that fails is left out (`modules`) and the others run.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const config = await loadHostConfig(options.stateDir);
  if (!config.modules.get(CORE_MODULE)?.enabled) throw new AppError(HOST_ERRORS.host_core_missing, { effect: "none" });
  const events = new EventBus();
  const accounts = new Accounts();
  const http = new HttpServer();
  serveDownloads(http, options.stateDir);
  const logs = new LogFanout();
  const extensions = options.extensions ?? EXTENSIONS;
  const installs = await Installs.open(
    options.stateDir,
    new Set(["app", CORE_MODULE, CONSOLE_MODULE, ...extensions.map((extension) => extension.moduleConfig.id)]),
    options.installer,
  );
  const policy = MemberPolicy.from({
    tenantId: options.env?.YESIMBOT_TENANT_ID,
    managedContext: options.env?.YESIMBOT_MANAGED_CONTEXT === "1",
    pluginsFile: options.policyFiles?.plugins,
    contextFile: options.policyFiles?.context,
  });
  const modules = new Modules({
    stateDir: options.stateDir,
    tenantId: options.env?.YESIMBOT_TENANT_ID,
    policy,
    extensions,
    installs,
    entries: config.modules,
    server: config.app.server,
    events,
    accounts,
    http,
    logs,
    clock: systemClock(),
  });
  const registered = new Set(modules.ids);
  const unused = [...config.modules.keys()].filter((id) => !registered.has(id));

  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      await step("http", () => http.close());
      await step("modules", () => modules.stop());
      log.info("host.stopped");
    })());
  try {
    // The log level is Core's `logLevel` unless app.json sets one; Core's config is checked when it is built.
    logs.configure(config.app.log.level ?? coreLogLevel(config.modules.get(CORE_MODULE)?.config));
    // Modules this host does not run yet keep their files; they are listed so a missing one is never silent.
    if (unused.length) log.warn("host.modules_not_run", { modules: unused });
    await modules.startCore();
    await Promise.all([modules.startExtensions(), http.listen(config.app.server.host, config.app.server.port)]);
    modules.followPolicy(options.policyFiles?.intervalMs);
  } catch (error) {
    await stop();
    throw error;
  }
  log.info("host.started", { stateDir: options.stateDir, console: modules.state(CONSOLE_MODULE)?.state });
  return {
    config,
    get core() {
      return modules.core as CoreService;
    },
    http,
    events,
    accounts,
    services: modules.runner.services,
    modules: modules.runner.states,
    state: (id) => modules.state(id),
    installs: modules,
    idle: () => modules.idle(),
    stop,
  };
}

/** Koishi's scale, which `logLevel` uses; 2 (info and warnings) when Core's config does not say. */
function coreLogLevel(config: unknown): number {
  const level = (config as { logLevel?: unknown } | undefined)?.logLevel;
  return typeof level === "number" && Number.isInteger(level) && level >= 0 && level <= 3 ? level : 2;
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log.error("host.stop_failed", { part: name, ...errorFields(error) });
  }
}

import { errorFields, logger, parseConfig, type Clock, type ModuleConfig } from "@yesimbot/foundation";
import { checkConsoleConfig, installConsole, moduleConfig as consoleModuleConfig, type Config as ConsoleConfig } from "koishi-plugin-yesimbot-console/server";
import { moduleConfig as coreModuleConfig, YesImBotCore } from "koishi-plugin-yesimbot/kernel";

import type { Accounts } from "./accounts.js";
import type { ModuleEntry } from "./config.js";
import { ConsoleHost } from "./console-host.js";
import { ConsoleLoader, type ModuleControl } from "./console-loader.js";
import type { EventBus } from "./events.js";
import { ExtensionRunner, type Module, type ModuleState } from "./extensions.js";
import type { HttpServer } from "./http.js";
import type { Install, Installs } from "./installs.js";
import type { LogFanout } from "./logs.js";
import { contextPublisher, type MemberPolicy } from "./member.js";

/** Core's module ID: `config/yesimbot.json`. */
export const CORE_MODULE = "yesimbot";

/** The console's module ID: `config/yesimbot-console.json`. */
export const CONSOLE_MODULE = "yesimbot-console";

const log = logger("host.modules");

export interface ModulesOptions {
  readonly stateDir: string;
  readonly tenantId?: string;
  readonly extensions: readonly Module[];
  /** What the owner installed from npm; its modules run after the registry's. */
  readonly installs?: Installs;
  readonly entries: ReadonlyMap<string, ModuleEntry>;
  readonly server: { readonly host: string; readonly port: number };
  readonly events: EventBus;
  readonly accounts: Accounts;
  readonly http: HttpServer;
  readonly logs: LogFanout;
  readonly clock: Clock;
  /** A member runtime's or managed context's policy from the account manager. */
  readonly policy?: MemberPolicy;
}

/**
 * What runs on the host and how a change reaches it: Core, the registry's extensions on it, and the console. Changes
 * apply one at a time. A new Core config replaces Core: the extensions stop, Core is rebuilt and they start again on
 * it, as Koishi restarts the plugins that inject `yesimbot`.
 */
export class Modules implements ModuleControl {
  public readonly runner: ExtensionRunner;
  public readonly loader: ConsoleLoader;

  private current: YesImBotCore | undefined;
  private withdrawCore: (() => void) | undefined;
  private console: ConsoleHost | undefined;
  private readonly entries: Map<string, ModuleEntry>;
  private readonly own = new Map<string, ModuleState>();
  private readonly listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();
  private publisher: { stop(): void } | undefined;
  private unwatch: (() => void) | undefined;
  /** Module IDs of installed packages: the owner's own, which a member runtime's grant does not cover. */
  private readonly installed = new Set<string>();

  public constructor(private readonly options: ModulesOptions) {
    this.entries = new Map(options.entries);
    this.runner = new ExtensionRunner(
      { baseDir: options.stateDir, events: options.events, accounts: options.accounts, http: options.http, clock: options.clock },
      [...options.extensions, ...(options.installs?.modules ?? [])],
    );
    this.runner.onChange(() => this.changed());
    for (const module of options.installs?.modules ?? []) this.installed.add(module.moduleConfig.id);
    this.loader = new ConsoleLoader(options.stateDir, this, this.entries, options.server);
  }

  public get core(): YesImBotCore | undefined {
    return this.current;
  }

  /** The modules the console lists, in its order: Core, the extensions (installed ones last), the console. */
  public get ids(): readonly string[] {
    return [CORE_MODULE, ...this.runner.ids, CONSOLE_MODULE];
  }

  public definition(id: string): ModuleConfig | undefined {
    if (id === CORE_MODULE) return coreModuleConfig;
    if (id === CONSOLE_MODULE) return consoleModuleConfig;
    return this.runner.extension(id)?.moduleConfig;
  }

  /** Whether the policy lets this module run (every module without one); what this instance installed always may. */
  public admits(id: string): boolean {
    return this.installed.has(id) || (this.options.policy?.admits(id) ?? true);
  }

  /** Whether the console may not change this module (a member runtime's own console). */
  public locks(id: string): boolean {
    return this.options.policy?.locks(id) ?? false;
  }

  public state(id: string): ModuleState | undefined {
    return this.own.get(id) ?? this.runner.states.get(id);
  }

  /** Core first (a Core that does not start refuses the host), then the console; the extensions start beside `listen`. */
  public async startCore(): Promise<YesImBotCore> {
    const core = this.createCore(this.entries.get(CORE_MODULE)!);
    this.current = core;
    await core.start();
    // Koishi's order: Core's `ready` comes first (providers registering later only bump the registry's revision).
    core.ready();
    this.provideCore(core);
    this.set(CORE_MODULE, { state: "running" });
    this.startConsole();
    return core;
  }

  public startExtensions(): Promise<void> {
    return this.runner.start(this.current, this.gated());
  }

  /**
   * Follows the account manager's policy from now on, as the Koishi glue did: revoked modules are turned off in
   * `config/` (their settings kept), Core's stored session becomes the policy's, and a new session policy replaces Core.
   */
  public followPolicy(intervalMs?: number): void {
    const policy = this.options.policy;
    if (!policy) return;
    const enforce = (replaceCore: boolean) => {
      this.chain = this.chain
        .then(() => this.enforce(policy, replaceCore))
        .catch((error: unknown) => log.warn("policy.enforce_failed", { ...errorFields(error) }));
      return this.chain;
    };
    void enforce(false);
    this.unwatch = policy.watch((changed) => void enforce(changed.context), intervalMs);
  }

  public apply(id: string, entry: ModuleEntry | undefined): Promise<void> {
    const run = this.chain.then(() => this.applyNow(id, entry));
    this.chain = run.catch((error: unknown) => log.error("module.apply_failed", { module: id, ...errorFields(error) }));
    return this.chain;
  }

  public idle(): Promise<void> {
    return this.chain;
  }

  /** The installed packages and how each runs. */
  public extensions(): (Install & { state?: ModuleState })[] {
    return (this.options.installs?.list() ?? []).map((item) => (item.module ? { ...item, state: this.state(item.module) } : item));
  }

  /**
   * Checks the request, then installs in the background: the package's module joins and starts on, enabled with the
   * settings it had or none (its form says what it still needs). `extensions()` shows how it goes.
   */
  public install(name: unknown, version: unknown): { name: string } {
    const installs = this.requireInstalls();
    const request = installs.begin(name, version);
    void installs
      .complete(request, (id) => id === "app" || this.ids.includes(id))
      .then((module) =>
        this.serial(async () => {
          const id = module.moduleConfig.id;
          this.runner.add(module);
          this.installed.add(id);
          const entry = this.entries.get(id) ?? { enabled: true, config: {} };
          await this.loader.add(id, entry);
          await this.applyNow(id, entry);
        }),
      )
      .catch(() => {
        // Listed as failed (`Installs`), and logged there.
      });
    return { name: request.name };
  }

  /** Stops the package's module, deletes its settings, then its files. */
  public async uninstall(name: unknown): Promise<void> {
    const installs = this.requireInstalls();
    const id = typeof name === "string" ? installs.moduleOf(name) : undefined;
    if (id && this.runner.has(id))
      await this.serial(async () => {
        await this.runner.remove(id);
        this.installed.delete(id);
        this.entries.delete(id);
        await this.loader.forget(id);
      });
    await installs.remove(name);
    this.changed();
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** An install still running, the console, then the extensions, then Core. */
  public async stop(): Promise<void> {
    this.unwatch?.();
    await this.options.installs?.close();
    await this.chain;
    this.publisher?.stop();
    this.console?.dispose();
    this.console = undefined;
    await this.runner.stop();
    this.withdrawCore?.();
    await this.current?.stop();
    this.current = undefined;
  }

  /** Runs after the changes before it; the returned promise has its outcome, the chain goes on either way. */
  private serial(action: () => Promise<void>): Promise<void> {
    const run = this.chain.then(action);
    this.chain = run.catch((error: unknown) => log.error("module.change_failed", { ...errorFields(error) }));
    return run;
  }

  private requireInstalls(): Installs {
    if (!this.options.installs) throw new Error("installs_unavailable");
    return this.options.installs;
  }

  private async applyNow(id: string, entry: ModuleEntry | undefined): Promise<void> {
    if (entry) this.entries.set(id, entry);
    else this.entries.delete(id);
    if (id === CORE_MODULE) await this.replaceCore(entry);
    else if (id === CONSOLE_MODULE) {
      this.console?.dispose();
      this.console = undefined;
      this.startConsole();
    } else await this.runner.apply(id, this.gate(id, entry));
  }

  private async enforce(policy: MemberPolicy, replaceCore: boolean): Promise<void> {
    const tree = this.loader.config.plugins;
    const next: [string, ModuleEntry][] = [];
    for (const id of this.ids) {
      if (!Object.hasOwn(tree, id)) continue;
      if (!this.admits(id)) {
        renameKey(tree, id, `~${id}`);
        next.push([id, { enabled: false, config: structuredClone(tree[`~${id}`]) as Record<string, unknown> }]);
      } else if (id === CORE_MODULE && !policy.holdsSession(tree[id])) {
        tree[id] = policy.withSession(tree[id]);
        next.push([id, { enabled: true, config: structuredClone(tree[id]) as Record<string, unknown> }]);
      }
    }
    if (next.length) await this.loader.writeConfig();
    for (const [id, entry] of next) {
      // The running Core already has the policy's session unless the policy itself changed.
      if (id === CORE_MODULE && !replaceCore) this.entries.set(id, entry);
      else await this.applyNow(id, entry);
    }
    if (replaceCore && !next.some(([id]) => id === CORE_MODULE)) await this.applyNow(CORE_MODULE, this.entries.get(CORE_MODULE));
  }

  /** An entry the policy refuses does not run; its file stays as it is until enforcement turns it off. */
  private gate(id: string, entry: ModuleEntry | undefined): ModuleEntry | undefined {
    if (!entry?.enabled || this.admits(id)) return entry;
    log.warn("plugin.policy.denied", { module: id });
    return { ...entry, enabled: false };
  }

  private gated(): Map<string, ModuleEntry> {
    return new Map([...this.entries].map(([id, entry]) => [id, this.gate(id, entry)!]));
  }

  private async replaceCore(entry: ModuleEntry | undefined): Promise<void> {
    await this.runner.stop();
    this.withdrawCore?.();
    this.withdrawCore = undefined;
    await this.current?.stop();
    this.current = undefined;
    if (!entry?.enabled) this.set(CORE_MODULE, { state: "disabled" });
    else {
      let core: YesImBotCore | undefined;
      try {
        core = this.createCore(entry);
      } catch (error) {
        this.fail(CORE_MODULE, "config", error);
      }
      if (core)
        try {
          await core.start();
          core.ready();
          this.current = core;
          this.provideCore(core);
          this.set(CORE_MODULE, { state: "running" });
        } catch (error) {
          await core.stop().catch(() => {});
          this.fail(CORE_MODULE, "start", error);
        }
    }
    await this.runner.start(this.current, this.gated());
  }

  private createCore(entry: ModuleEntry): YesImBotCore {
    const { stateDir, events, accounts, tenantId, policy } = this.options;
    return new YesImBotCore({
      baseDir: stateDir,
      // A member's sessions follow the owner's published policy, whatever its own file says.
      config: policy ? policy.withSession(entry.config) : entry.config,
      events,
      account: (platform, selfId) => accounts.find(platform, selfId),
      assignee: async (context) => accounts.sole(context.platform)?.selfId,
      tenantId,
    });
  }

  /** Core is the `yesimbot` service: the console's `inject(["yesimbot"])` parts follow it. */
  private provideCore(core: YesImBotCore): void {
    this.withdrawCore = this.runner.services.provide(CORE_MODULE, "yesimbot", core);
  }

  private startConsole(): void {
    const entry = this.entries.get(CONSOLE_MODULE);
    if (!entry?.enabled) return this.set(CONSOLE_MODULE, { state: "disabled" });
    let config: ConsoleConfig;
    try {
      config = parseConfig(consoleModuleConfig, entry.config ?? {});
      checkConsoleConfig(config);
    } catch (error) {
      return this.fail(CONSOLE_MODULE, "config", error);
    }
    const { stateDir, clock, http, events, accounts, logs } = this.options;
    const host = new ConsoleHost({
      baseDir: stateDir,
      clock,
      http,
      loader: this.loader,
      events,
      accounts,
      services: this.runner.services,
      logs,
      extensions: { list: () => this.extensions(), install: (name, version) => this.install(name, version), remove: (name) => this.uninstall(name) },
      onModulesChanged: (listener) => this.onChange(listener),
    });
    this.loader.entry = host;
    const policy = this.options.policy;
    // This host enforces the account manager's policy from before Core starts (followPolicy); the console only checks.
    const enforced = () => {};
    try {
      installConsole(host, config, clock, {
        ...(policy?.plugins ? { memberRuntime: enforced } : {}),
        ...(policy ? { managedContext: enforced } : {}),
        contextPublisher: () => {
          this.publisher?.stop();
          this.publisher = contextPublisher(stateDir, () => this.current?.config.session);
        },
      });
    } catch (error) {
      host.dispose();
      return this.fail(CONSOLE_MODULE, "start", error);
    }
    this.console = host;
    this.set(CONSOLE_MODULE, { state: "running" });
  }

  private fail(id: string, stage: "config" | "start", error: unknown): void {
    this.set(id, { state: "failed", stage, error: errorFields(error) });
    log.error("module.failed", { module: id, stage, ...errorFields(error) });
  }

  private set(id: string, state: ModuleState): void {
    this.own.set(id, state);
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        log.error("module.listener_failed", { ...errorFields(error) });
      }
    }
  }
}

/** Renames a key in place, keeping the order of the others. */
function renameKey(tree: Record<string, unknown>, from: string, to: string): void {
  const entries = Object.entries(tree).map(([key, value]) => [key === from ? to : key, value] as const);
  for (const key of Object.keys(tree)) delete tree[key];
  for (const [key, value] of entries) tree[key] = value;
}

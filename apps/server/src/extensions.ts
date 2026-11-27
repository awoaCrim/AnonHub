import { AppError, defineErrors, errorFields, logger, type Clock, type ErrorFields } from "@yesimbot/foundation";
import type { ChannelContext, Connector, ConnectorContext, CoreEvents, CoreService, Extension, ExtensionContext, Undo } from "koishi-plugin-yesimbot/kernel";

import type { Accounts } from "./accounts.js";
import type { ModuleEntry } from "./config.js";
import type { EventBus } from "./events.js";
import type { HttpServer, SocketHandler } from "./http.js";

export const EXTENSION_ERRORS = defineErrors({
  host_service_duplicate: { model: "两个模块提供了同名的服务。", user: "两个模块提供了同名的服务。", status: 500 },
});

const log = logger("host.extensions");

/** What the registry lists: extensions, and connectors, which also bring chat accounts and HTTP endpoints. */
export type Module = Extension | Connector;

/** What became of one module. `waiting`: enabled, but Core is not running, so it cannot start. */
export type ModuleState =
  | { readonly state: "disabled" }
  | { readonly state: "waiting" }
  | { readonly state: "running" }
  | { readonly state: "failed"; readonly stage: "config" | "start"; readonly error: ErrorFields };

export interface ExtensionHost {
  readonly baseDir: string;
  readonly events: EventBus;
  readonly accounts: Accounts;
  readonly http: HttpServer;
  readonly clock: Clock;
}

/** Services by name (the console reads them), each removed with the module that provided it. */
export class Services {
  private readonly services = new Map<string, { readonly module: string; readonly service: object }>();
  private readonly listeners = new Set<() => void>();

  public get(name: string): object | undefined {
    return this.services.get(name)?.service;
  }

  public provide(module: string, name: string, service: object): () => void {
    if (this.services.has(name)) throw new AppError(EXTENSION_ERRORS.host_service_duplicate, { effect: "none", detail: name });
    const entry = { module, service };
    this.services.set(name, entry);
    this.changed();
    return () => {
      if (this.services.get(name) !== entry) return;
      this.services.delete(name);
      this.changed();
    };
  }

  /** Called after any service came or went. */
  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        log.error("service.listener_failed", { ...errorFields(error) });
      }
    }
  }
}

/**
 * Runs the registry's extensions: each one parsed from its `config/<id>.json` and started against the running Core.
 * At start they all start together; afterwards one module at a time is applied again (a console edit), and stopping
 * goes in reverse registry order. A module whose config does not fit or whose start throws is left out and reported;
 * the others run.
 */
export class ExtensionRunner {
  public readonly services = new Services();
  public readonly states = new Map<string, ModuleState>();

  private readonly scopes = new Map<string, Scope>();
  private readonly listeners = new Set<() => void>();
  private core: CoreService | undefined;
  private starting: Promise<unknown> = Promise.resolve();

  private readonly extensions: Module[];

  public constructor(
    private readonly host: ExtensionHost,
    extensions: readonly Module[],
  ) {
    this.extensions = [...extensions];
  }

  /** Module IDs in start order. */
  public get ids(): string[] {
    return this.extensions.map((extension) => extension.moduleConfig.id);
  }

  public has(id: string): boolean {
    return this.extensions.some((extension) => extension.moduleConfig.id === id);
  }

  public extension(id: string): Module | undefined {
    return this.extensions.find((extension) => extension.moduleConfig.id === id);
  }

  /** Starts every module of `entries` against `core` (absent: enabled modules wait for it). */
  public async start(core: CoreService | undefined, entries: ReadonlyMap<string, ModuleEntry>): Promise<void> {
    this.core = core;
    // Like Koishi's `ready` listeners, starts run side by side: one that waits on the network holds up no other.
    const starting = Promise.all(this.extensions.map((extension) => this.launch(extension, entries.get(extension.moduleConfig.id))));
    this.starting = starting;
    await starting;
  }

  /** One module again with `entry` (absent: stopped and left off): what a console edit does. */
  public async apply(id: string, entry: ModuleEntry | undefined): Promise<void> {
    const extension = this.extension(id);
    if (!extension) return;
    await this.halt(id);
    await this.launch(extension, entry);
  }

  /** One more module (an install): it starts with `apply`. */
  public add(extension: Module): void {
    if (this.has(extension.moduleConfig.id)) throw new Error(`module_duplicate: ${extension.moduleConfig.id}`);
    this.extensions.push(extension);
  }

  /** Stops a module and forgets it (an uninstall). */
  public async remove(id: string): Promise<void> {
    await this.halt(id);
    const index = this.extensions.findIndex((extension) => extension.moduleConfig.id === id);
    if (index >= 0) this.extensions.splice(index, 1);
    this.states.delete(id);
    this.notify();
  }

  /** Waits for starts still running, then stops every module in reverse registry order; their states stay as they were. */
  public async stop(): Promise<void> {
    await this.starting;
    for (const extension of [...this.extensions].reverse()) await this.halt(extension.moduleConfig.id, true);
    this.core = undefined;
  }

  /** Called after a module's state changed. */
  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async launch(extension: Module, entry: ModuleEntry | undefined): Promise<void> {
    const id = extension.moduleConfig.id;
    if (!entry?.enabled) return this.set(id, { state: "disabled" });
    let config: unknown;
    try {
      config = extension.parse(entry.config);
    } catch (error) {
      return this.fail(id, "config", error);
    }
    const core = this.core;
    if (!core) return this.set(id, { state: "waiting" });
    const scope = new Scope(id);
    this.scopes.set(id, scope);
    try {
      const context = this.context(scope, core, config);
      const undo = (await (isConnector(extension) ? extension.start(this.connectorContext(scope, context)) : extension.start(context))) ?? undefined;
      // Halted while it started (a console edit): what the start returned is undone now, and the new start reports.
      if (scope.closed) return void (await undo?.());
      scope.undo = undo;
      this.set(id, { state: "running" });
    } catch (error) {
      if (this.scopes.get(id) === scope) this.scopes.delete(id);
      await scope.close();
      this.fail(id, "start", error);
    }
  }

  private async halt(id: string, keepState = false): Promise<void> {
    const scope = this.scopes.get(id);
    if (!scope) return;
    this.scopes.delete(id);
    try {
      await scope.close();
    } catch (error) {
      log.error("extension.stop_failed", { module: id, ...errorFields(error) });
    }
    if (!keepState) this.set(id, { state: "disabled" });
  }

  private context<C>(scope: Scope, core: CoreService, config: C): ExtensionContext<C> {
    const { baseDir, clock, events, accounts } = this.host;
    return {
      config,
      core,
      baseDir,
      clock,
      setTimeout: (callback, ms) => scope.timer(false, callback, ms),
      setInterval: (callback, ms) => scope.timer(true, callback, ms),
      on: <K extends keyof CoreEvents>(name: K, listener: CoreEvents[K]) => scope.track(events.on(name, listener)),
      provide: (name, service) => {
        scope.track(this.services.provide(scope.id, name, service));
      },
      isOwnerContext: (context) => isOwnerContext(accounts, core, context),
    };
  }

  private connectorContext<C>(scope: Scope, context: ExtensionContext<C>): ConnectorContext<C> {
    const { accounts, http } = this.host;
    return {
      ...context,
      account: (account) => scope.track(accounts.register(account)),
      ws: (path, handler, accept) => scope.track(http.ws(path, handler as unknown as SocketHandler, accept)),
    };
  }

  private fail(id: string, stage: "config" | "start", error: unknown): void {
    this.set(id, { state: "failed", stage, error: errorFields(error) });
    log.error("extension.failed", { module: id, stage, ...errorFields(error) });
  }

  private set(id: string, state: ModuleState): void {
    this.states.set(id, state);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        log.error("extension.listener_failed", { ...errorFields(error) });
      }
    }
  }
}

/** One running extension: what it registered with the host, removed when it stops. */
class Scope {
  public undo: Undo | undefined;
  public closed = false;

  private readonly disposers = new Set<() => void>();

  public constructor(public readonly id: string) {}

  /** Once the scope closed, what is still registered is removed straight away. */
  public track(dispose: () => void): () => void {
    if (this.closed) {
      dispose();
      return () => {};
    }
    const once = () => {
      if (this.disposers.delete(once)) dispose();
    };
    this.disposers.add(once);
    return once;
  }

  /** A one-shot timer leaves the scope once it fired; a callback that throws is logged, not raised. */
  public timer(repeat: boolean, callback: () => void, ms: number): () => void {
    const run = () => {
      if (!repeat) dispose();
      try {
        callback();
      } catch (error) {
        log.error("extension.timer_failed", { module: this.id, ...errorFields(error) });
      }
    };
    const handle = repeat ? setInterval(run, ms) : setTimeout(run, ms);
    const dispose = this.track(() => (repeat ? clearInterval(handle) : clearTimeout(handle)));
    return dispose;
  }

  /** The extension's own undo first, then what it registered. */
  public async close(): Promise<void> {
    this.closed = true;
    const undo = this.undo;
    this.undo = undefined;
    try {
      await undo?.();
    } finally {
      for (const dispose of [...this.disposers].reverse()) dispose();
    }
  }
}

function isConnector(module: Module): module is Connector {
  return (module as { kind?: unknown }).kind === "connector";
}

/** Trusted ingress only: a live account of this instance that authenticated the very context (the web chat's). */
function isOwnerContext(accounts: Accounts, core: CoreService, context: ChannelContext): boolean {
  const account = accounts.find(context.platform, context.selfId ?? "") as
    | { isAuthenticatedContext?: (context: ChannelContext) => boolean; belongsToRuntime?: (core: CoreService) => boolean }
    | undefined;
  return account?.belongsToRuntime?.(core) === true && account.isAuthenticatedContext?.(context) === true;
}

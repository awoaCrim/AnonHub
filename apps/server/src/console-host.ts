import { errorFields, logger, type Clock, type LogRecord } from "@yesimbot/foundation";
import {
  modelPickers,
  projectChatContent,
  WebChat,
  type BotLike,
  type ExtensionInstalls,
  type Host,
  type RuntimeLike,
  type Server,
  type WebUILogEntry,
} from "koishi-plugin-yesimbot-console/server";
import type { CoreService } from "koishi-plugin-yesimbot/kernel";

import type { Accounts } from "./accounts.js";
import type { ConsoleLoader } from "./console-loader.js";
import type { EventBus } from "./events.js";
import type { Services } from "./extensions.js";
import type { HttpServer } from "./http.js";
import type { LogFanout } from "./logs.js";

const log = logger("host.console");

/** Koishi `Status.ONLINE` / `OFFLINE`. */
const ONLINE = 1;
const OFFLINE = 0;

let nextLogId = 0;

export interface ConsoleHostDeps {
  readonly baseDir: string;
  readonly clock: Clock;
  readonly http: HttpServer;
  readonly loader: ConsoleLoader;
  readonly events: EventBus;
  readonly accounts: Accounts;
  /** Core is the `yesimbot` service while it runs. */
  readonly services: Services;
  readonly logs: LogFanout;
  /** Packages installed from npm (`Modules.install`). */
  readonly extensions: ExtensionInstalls;
  /** A module started, stopped or failed. */
  onModulesChanged(listener: () => void): () => void;
}

/**
 * The console's host on `apps/server` (`Host` in `plugins/console/src/host.ts`), from the host's parts. A scope owns what it registered (routes, listeners, timers, the web chat account) and removes it
 * when disposed; `inject` makes a child scope that lives while its services are there, as Koishi's does.
 */
export class ConsoleHost implements Host {
  public readonly server: Server;
  public readonly registry: { values(): Iterable<RuntimeLike> };
  public readonly lifecycle: { flush(): Promise<void> };
  public readonly schema: Host["schema"];

  private readonly disposers: (() => unknown)[] = [];
  private disposed = false;

  public constructor(
    private readonly deps: ConsoleHostDeps,
    parent?: ConsoleHost,
  ) {
    parent?.track(() => this.dispose());
    const { http } = deps;
    this.server = {
      get: (path, handler) => this.track(http.get(path, handler as never)),
      post: (path, handler) => this.track(http.post(path, handler as never)),
      ws: (path, handler) => this.track(http.ws(path, handler)),
      prepend: (middleware) => this.track(http.prepend(middleware as never)),
      get http() {
        return http.http;
      },
      get port() {
        return http.port;
      },
      get listenHost() {
        return http.listenHost;
      },
    };
    this.registry = { values: () => deps.loader.runtimes() };
    this.lifecycle = { flush: () => deps.loader.flush() };
    this.schema = {
      get: (name) => {
        const node = this.core ? modelPickers(this.core.model)[name] : undefined;
        return node ? { toJSON: () => node } : undefined;
      },
    };
  }

  public get baseDir(): string {
    return this.deps.baseDir;
  }

  public get clock(): Clock {
    return this.deps.clock;
  }

  public get loader(): ConsoleLoader {
    return this.deps.loader;
  }

  /** Inside `inject(["yesimbot"])` it is always there, as `ctx.yesimbot` is under Koishi. */
  public get yesimbot(): CoreService {
    return this.core as CoreService;
  }

  /** A connector's account that reports its status (QQ) is listed as itself, with its name and contact lists; others as online. */
  public get bots(): readonly BotLike[] {
    return this.deps.accounts.list().map((account) => {
      if (typeof (account as Partial<BotLike>).status === "number") return account as unknown as BotLike;
      const online = (account as { isOnline?: () => boolean }).isOnline?.() ?? true;
      return { platform: account.platform, selfId: account.selfId, status: online ? ONLINE : OFFLINE, user: { name: "YesImBot" } };
    });
  }

  public get scope(): unknown {
    return this.deps.loader.root;
  }

  public get extensions(): ExtensionInstalls {
    return this.deps.extensions;
  }

  public projectChatContent = projectChatContent;

  /** The web chat as a chat account of the running Core, for as long as this scope lives. */
  public openWebChat(changed: (conversation: string) => void): WebChat {
    const core = this.core;
    if (!core) throw new Error("web chat needs Core");
    const chat = new WebChat(core, changed, this.deps.clock, () => !this.disposed);
    this.track(this.deps.accounts.register(chat));
    return chat;
  }

  public onLog(listener: (record: WebUILogEntry) => void): () => void {
    return this.track(this.deps.logs.subscribe((record) => listener(logEntry(record))));
  }

  public get(name: string): unknown {
    return this.deps.services.get(name);
  }

  public inject(deps: readonly string[], callback: (host: Host) => void): void {
    let child: ConsoleHost | undefined;
    let bound: unknown[] = [];
    const update = () => {
      const current = deps.map((name) => this.get(name));
      if (child && current.every((service, index) => service === bound[index])) return;
      child?.dispose();
      child = undefined;
      if (this.disposed || current.some((service) => service === undefined)) return;
      bound = current;
      child = new ConsoleHost(this.deps, this);
      try {
        callback(child);
      } catch (error) {
        log.error("console.inject_failed", { services: [...deps], ...errorFields(error) });
        child.dispose();
        child = undefined;
      }
    };
    this.track(this.deps.services.onChange(update));
    this.track(() => child?.dispose());
    update();
  }

  public setInterval(callback: () => void, ms: number): () => void {
    const handle = setInterval(() => this.guard("interval", callback), ms);
    return this.track(() => clearInterval(handle));
  }

  /** Koishi's `debounce`: the returned function runs `callback` once calls stop for `ms`. */
  public debounce(callback: () => void, ms: number): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.track(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      if (!this.disposed) timer = setTimeout(() => this.guard("debounce", callback), ms);
    };
  }

  public on: Host["on"] = ((event: string, listener: (...args: never[]) => unknown) => {
    const call = listener as (...args: unknown[]) => unknown;
    switch (event) {
      case "dispose": {
        // Removing a dispose listener does not run it.
        const listen = () => call();
        this.disposers.push(listen);
        return () => {
          const index = this.disposers.indexOf(listen);
          if (index >= 0) this.disposers.splice(index, 1);
        };
      }
      case "ready":
        // Already started: Koishi runs a late `ready` listener right away.
        queueMicrotask(() => {
          if (!this.disposed) void this.guardAsync("ready", call);
        });
        return () => {};
      case "config":
        return this.track(this.deps.loader.onConfig(() => this.guard("config", call)));
      case "internal/runtime":
      case "internal/fork":
      case "internal/status":
      case "internal/schema":
        return this.track(this.deps.onModulesChanged(() => this.guard(event, call)));
      default:
        return this.track(this.deps.events.on(event, call));
    }
  }) as Host["on"];

  /** Runs the scope's disposers, the latest first. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        const result = dispose();
        if (result instanceof Promise) result.catch((error: unknown) => log.error("console.dispose_failed", { ...errorFields(error) }));
      } catch (error) {
        log.error("console.dispose_failed", { ...errorFields(error) });
      }
    }
  }

  private get core(): CoreService | undefined {
    return this.deps.services.get("yesimbot") as CoreService | undefined;
  }

  private track(dispose: () => unknown): () => void {
    if (this.disposed) {
      void dispose();
      return () => {};
    }
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      const index = this.disposers.indexOf(once);
      if (index >= 0) this.disposers.splice(index, 1);
      return dispose();
    };
    this.disposers.push(once);
    return () => void once();
  }

  private guard(name: string, callback: () => unknown): void {
    try {
      const result = callback();
      if (result instanceof Promise) result.catch((error: unknown) => log.error("console.listener_failed", { listener: name, ...errorFields(error) }));
    } catch (error) {
      log.error("console.listener_failed", { listener: name, ...errorFields(error) });
    }
  }

  private async guardAsync(name: string, callback: () => unknown): Promise<void> {
    try {
      await callback();
    } catch (error) {
      log.error("console.listener_failed", { listener: name, ...errorFields(error) });
    }
  }
}

/** A log record as the console's log page lists it. */
function logEntry(record: LogRecord): WebUILogEntry {
  const { time, level, scope, event, ...fields } = record;
  return {
    id: ++nextLogId,
    timestamp: Date.parse(time),
    level,
    name: scope,
    content: Object.keys(fields).length ? `${event} ${JSON.stringify(fields)}` : event,
  };
}

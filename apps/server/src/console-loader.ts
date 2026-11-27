import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { configForm, errorFields, logger, writeJsonAtomic, type ModuleConfig, isRecord } from "@yesimbot/foundation";
import { formNode, kRecord, splitSecrets, type ForkLike, type Host, type Loader, type RuntimeLike } from "koishi-plugin-yesimbot-console/server";

import type { ModuleEntry } from "./config.js";
import type { ModuleState } from "./extensions.js";

const log = logger("host.console");

type Tree = Record<string, unknown>;

/** What the console's loader needs of the host's modules. */
export interface ModuleControl {
  /** The modules the console lists, in its order. */
  readonly ids: readonly string[];
  definition(id: string): ModuleConfig | undefined;
  state(id: string): ModuleState | undefined;
  /** Whether the module may run here: a member runtime lists only what the account manager granted. */
  admits(id: string): boolean;
  /** Whether the console may not change the module: a member runtime's own console. */
  locks(id: string): boolean;
  /** Applies one module again (absent: stops it); resolves once it settled. */
  apply(id: string, entry: ModuleEntry | undefined): Promise<void>;
  /** Resolves once every applied change settled. */
  idle(): Promise<void>;
}

/**
 * The console's config editor over `config/` instead of `koishi.yml` (`Loader` in `plugins/console/src/host.ts`). The
 * tree is flat: one key per module, `~<id>` when it is off, the values with their secrets in place, as `koishi.yml`
 * held them. Writing puts each changed module back in `config/<id>.json`, its secrets in `config/secrets/<id>.json`;
 * a reload applies that module again (Core: every module, since they all run on it).
 */
export class ConsoleLoader implements Loader {
  public readonly config: { plugins: Tree; port?: unknown; host?: unknown };
  public readonly writable = true;
  /** The console's root scope; set when the console starts. */
  public entry: Host | undefined;
  /** The root plugin scope: running modules by key, as Koishi's loader records its forks. */
  public readonly root: object;

  /** Each module as last read or written, to rewrite only what changed. */
  private readonly written = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  public constructor(
    private readonly stateDir: string,
    private readonly modules: ModuleControl,
    entries: ReadonlyMap<string, ModuleEntry>,
    server: { readonly host: string; readonly port: number },
  ) {
    const plugins: Tree = {};
    for (const id of modules.ids) {
      const entry = entries.get(id) ?? { enabled: false, config: {} };
      plugins[entry.enabled ? id : `~${id}`] = structuredClone(entry.config ?? {});
      this.written.set(id, signature(entry));
    }
    this.config = { plugins, port: server.port, host: server.host };
    const forks = () => this.forks();
    this.root = {
      get [kRecord]() {
        return forks();
      },
    };
  }

  public get baseDir(): string {
    return this.stateDir;
  }

  public isTruthyLike(value: unknown): boolean {
    return value === undefined || value === null || Boolean(value);
  }

  public keyFor(plugin: unknown): string {
    return typeof (plugin as { id?: unknown } | undefined)?.id === "string" ? (plugin as { id: string }).id : "";
  }

  public async resolve(name: string): Promise<{ moduleConfig: ModuleConfig; usage: string } | undefined> {
    if (!this.modules.admits(name)) return undefined;
    const definition = this.modules.definition(name);
    return definition ? { moduleConfig: definition, usage: "" } : undefined;
  }

  /** No fork for a module the policy refuses or locks: the console's config store then rolls the edit back, as on Koishi. */
  public async reload(_parent: Host, key: string, config: unknown): Promise<ForkLike | undefined> {
    const id = this.idOf(key);
    if (this.modules.locks(id)) return undefined;
    await this.modules.apply(id, { enabled: true, config: structuredClone(config) });
    return this.fork(id);
  }

  public unload(_parent: Host, key: string): void {
    const id = this.idOf(key);
    if (this.modules.locks(id)) return;
    void this.modules.apply(id, undefined);
  }

  public flush(): Promise<void> {
    return this.modules.idle();
  }

  public async writeConfig(): Promise<void> {
    const next = new Map<string, ModuleEntry>();
    for (const [key, value] of Object.entries(this.config.plugins)) {
      if (key.startsWith("$")) continue;
      const id = this.idOf(key);
      if (next.has(id)) throw new Error(`module_duplicate: ${id}`);
      next.set(id, { enabled: !key.startsWith("~"), config: withoutMeta(value) });
    }
    for (const id of this.modules.ids) {
      const entry = next.get(id);
      const written = entry ? signature(entry) : undefined;
      if (written === this.written.get(id)) continue;
      if (this.modules.locks(id)) throw new Error(`module_locked: ${id}`);
      if (entry) await this.write(id, entry);
      else await this.remove(id);
      if (written) this.written.set(id, written);
      else this.written.delete(id);
    }
    this.notify();
  }

  /** A module that joined (an install): its entry goes into the tree and `config/<id>.json`. */
  public async add(id: string, entry: ModuleEntry): Promise<void> {
    delete this.config.plugins[id];
    delete this.config.plugins[`~${id}`];
    this.config.plugins[entry.enabled ? id : `~${id}`] = structuredClone(entry.config ?? {});
    await this.write(id, entry);
    this.written.set(id, signature(entry));
    this.notify();
  }

  /** A module that left (an uninstall): out of the tree, its config and secrets files deleted. */
  public async forget(id: string): Promise<void> {
    delete this.config.plugins[id];
    delete this.config.plugins[`~${id}`];
    this.written.delete(id);
    await this.remove(id);
    this.notify();
  }

  public async forkPlugin(): Promise<unknown> {
    throw new Error("forkPlugin is not supported on this host");
  }

  /** After every write, as Koishi's `config` event. */
  public onConfig(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The plugin runtimes of Koishi's registry: one per module, with one fork while it is on. */
  public runtimes(): RuntimeLike[] {
    return this.modules.ids
      .filter((id) => this.modules.admits(id))
      .map((id) => {
        const state = this.modules.state(id);
        const error = state?.state === "failed" ? state.error : undefined;
        const isActive = state?.state === "running";
        const key = Object.keys(this.config.plugins).find((item) => !item.startsWith("~") && this.idOf(item) === id);
        const suffix = key?.includes(":") ? key.slice(key.indexOf(":") + 1) : "";
        return {
          plugin: { id },
          error,
          isReusable: false,
          isActive,
          children: key ? [{ key: suffix, error, isActive, parent: { scope: this.root } }] : [],
        };
      });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        log.error("config.listener_failed", { ...errorFields(error) });
      }
    }
  }

  private forks(): Record<string, ForkLike & { ctx: Host | undefined }> {
    const forks: Record<string, ForkLike & { ctx: Host | undefined }> = {};
    for (const key of Object.keys(this.config.plugins)) {
      if (key.startsWith("~") || key.startsWith("$")) continue;
      const fork = this.fork(this.idOf(key));
      if (fork) forks[key] = fork;
    }
    return forks;
  }

  private fork(id: string): (ForkLike & { ctx: Host | undefined }) | undefined {
    const state = this.modules.state(id);
    if (!state || state.state === "disabled") return undefined;
    const error = state.state === "failed" ? state.error : undefined;
    const isActive = state.state === "running";
    return { ctx: this.entry, error, isActive, runtime: { error, isReusable: false, isActive } };
  }

  private idOf(key: string): string {
    const id = key.replace(/^~/, "").split(":", 1)[0]!;
    if (!this.modules.ids.includes(id)) throw new Error(`module_unknown: ${id}`);
    return id;
  }

  private async write(id: string, entry: ModuleEntry): Promise<void> {
    const dir = join(this.stateDir, "config");
    const definition = this.modules.definition(id);
    const config = isRecord(entry.config) ? entry.config : {};
    const { stored, secrets } = definition ? splitSecrets(config, formNode(configForm(definition.schema))) : { stored: config, secrets: {} };
    const secretFile = join(dir, "secrets", `${id}.json`);
    // Secrets first: the config may name a reference only the new secrets file has.
    if (Object.keys(secrets).length) {
      await mkdir(join(dir, "secrets"), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(secretFile, secrets);
    }
    await writeJsonAtomic(join(dir, `${id}.json`), { enabled: entry.enabled, config: stored });
    if (!Object.keys(secrets).length) await rm(secretFile, { force: true });
  }

  private async remove(id: string): Promise<void> {
    const dir = join(this.stateDir, "config");
    await rm(join(dir, `${id}.json`), { force: true });
    await rm(join(dir, "secrets", `${id}.json`), { force: true });
  }
}

function signature(entry: ModuleEntry): string {
  return JSON.stringify({ enabled: entry.enabled, config: entry.config ?? {} });
}

/** Koishi's entry metadata (`$label`, `$if` …) has no place in a module file. */
function withoutMeta(value: unknown): Tree {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("$")));
}

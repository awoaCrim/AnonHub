import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AppError,
  defineErrors,
  defineModuleConfig,
  errorFields,
  isRecord,
  logger,
  newId,
  parseConfig,
  proxyFor,
  readJson,
  resolveInside,
  writeJsonAtomic,
  type ModuleConfig,
} from "@yesimbot/foundation";
import { z } from "zod/v4";

import type { Module } from "./extensions.js";

export const INSTALL_ERRORS = defineErrors({
  extension_name_invalid: { model: "扩展包名不对，应为 npm 包名。", user: "请填写 npm 包名。", status: 400 },
  extension_version_invalid: { model: "版本应为 1.2.3 这样的确定版本，或者不填（装最新版）。", user: "版本应为 1.2.3 这样的确定版本。", status: 400 },
  extension_installed: { model: "这个扩展已经装了。", user: "这个扩展已经装了。", status: 409 },
  extension_install_busy: { model: "另一个扩展正在安装，等它装完再试。", user: "另一个扩展正在安装，请等它装完。", status: 409 },
  extension_limit: { model: "扩展数量已达上限，先移除不用的。", user: "扩展数量已达上限，请先移除不用的。", status: 409 },
  extension_install_failed: {
    model: "安装失败：npm 上没有这个包或这个版本，或者网络不通。",
    user: "安装失败：npm 上没有这个包或这个版本，或者网络不通。",
    status: 502,
  },
  extension_not_extension: { model: "这个包不是扩展：它没有导出 ./extension。", user: "这个包不是扩展。", status: 422 },
  extension_id_taken: { model: "这个扩展的模块 ID 已被别的模块占用。", user: "这个扩展和已有的模块重名了。", status: 409 },
  extension_not_found: { model: "没有装这个扩展。", user: "没有装这个扩展。", status: 404 },
});

const log = logger("host.installs");

/** At most this many packages per instance. */
const MAX_INSTALLS = 32;
/** A slow link still finishes; a hung registry does not hold the install forever. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** npm's rules for a package name, scope included. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/**
 * The host's own copies an extension resolves as its peers: its config schema is the host's zod (`zod/v4`), and
 * `koishi-plugin-yesimbot/kernel` (`defineExtension`, Core's types) is the running kernel.
 */
const HOST_PACKAGES = ["zod", "koishi-plugin-yesimbot"];
const REGISTRY = "https://registry.npmjs.org";

const stateFile = z.object({
  version: z.literal(1),
  items: z.array(z.object({ dir: z.uuid(), name: z.string().regex(PACKAGE_NAME), version: z.string().regex(VERSION) })).max(MAX_INSTALLS),
});

/** Installs one package into `dir` (its own project); `range` is an exact version or `latest`. */
export type Installer = (dir: string, name: string, range: string, signal: AbortSignal) => Promise<void>;

type InstallRecord = z.output<typeof stateFile>["items"][number];

/** One installed package as the console lists it. `error` is a registered code: why it did not install or load. */
export interface Install {
  readonly name: string;
  readonly version?: string;
  /** Its module ID, once it loaded. */
  readonly module?: string;
  readonly installing?: boolean;
  readonly error?: string;
}

/**
 * Extensions the instance's owner installs from npm (user, 2026-11-26: 「允许用户自己给自己的实例安装拓展，目前莫名其妙的
 * 绑定了koishi的拓展市场」). A package is one when its `./extension` export has an `extension` of the same kind as the
 * registry's (`core/src/extension.ts`); it runs in this host as trusted code, as n8n's community nodes and OpenClaw's
 * plugins do, and as the stdio MCP commands this instance already runs. Each install is a project of its own
 * (`data/extensions/<dir>/`, its own lockfile and dependency tree), whose install scripts never run.
 */
export class Installs {
  private records: InstallRecord[] = [];
  private readonly loaded = new Map<string, Module>();
  /** Why a package did not install or load, by name; a failed install is listed until it is removed. */
  private readonly failures = new Map<string, string>();
  private pending: { name: string; controller: AbortController; job?: Promise<unknown> } | undefined;

  private constructor(
    private readonly root: string,
    private readonly installer: Installer,
  ) {}

  /**
   * Loads what `data/extensions/state.json` lists. A package that does not load, or whose module ID `reserved` or an
   * earlier package holds, is listed as failed and the others run.
   */
  public static async open(stateDir: string, reserved: ReadonlySet<string>, installer: Installer = installPackage): Promise<Installs> {
    const installs = new Installs(join(stateDir, "data", "extensions"), installer);
    installs.records = (await readJson(join(installs.root, "state.json"), stateFile))?.items ?? [];
    const taken = new Set(reserved);
    for (const record of installs.records) {
      try {
        const module = await load(installs.directory(record), record.name);
        if (taken.has(module.moduleConfig.id)) throw new AppError(INSTALL_ERRORS.extension_id_taken, { effect: "none", detail: module.moduleConfig.id });
        taken.add(module.moduleConfig.id);
        installs.loaded.set(record.name, module);
      } catch (error) {
        installs.failures.set(record.name, codeOf(error, INSTALL_ERRORS.extension_not_extension));
        log.error("extension.load_failed", { package: record.name, ...errorFields(error) });
      }
    }
    await installs.sweep();
    return installs;
  }

  /** The modules that loaded, in install order. */
  public get modules(): Module[] {
    return this.records.flatMap((record) => this.loaded.get(record.name) ?? []);
  }

  public list(): Install[] {
    const items: Install[] = this.records.map((record) => ({
      name: record.name,
      version: record.version,
      ...(this.loaded.has(record.name) ? { module: this.loaded.get(record.name)!.moduleConfig.id } : {}),
      ...(this.failures.has(record.name) ? { error: this.failures.get(record.name) } : {}),
    }));
    for (const [name, error] of this.failures) if (!this.records.some((record) => record.name === name)) items.push({ name, error });
    if (this.pending) items.push({ name: this.pending.name, installing: true });
    return items;
  }

  /** The module ID a package brought, when it loaded. */
  public moduleOf(name: string): string | undefined {
    return this.loaded.get(name)?.moduleConfig.id;
  }

  /**
   * Checks a request and marks it pending; `complete` then installs it. Refused: a name or version that is not one, another
   * install still running, a package already installed, or the limit reached.
   */
  public begin(name: unknown, version: unknown): { name: string; range: string } {
    if (typeof name !== "string" || name.length > 214 || !PACKAGE_NAME.test(name.trim()))
      throw new AppError(INSTALL_ERRORS.extension_name_invalid, { effect: "none" });
    const range = version === undefined || version === null || version === "" ? "latest" : version;
    if (typeof range !== "string" || (range !== "latest" && !VERSION.test(range)))
      throw new AppError(INSTALL_ERRORS.extension_version_invalid, { effect: "none" });
    const request = { name: name.trim(), range };
    if (this.pending) throw new AppError(INSTALL_ERRORS.extension_install_busy, { effect: "none" });
    if (this.records.some((record) => record.name === request.name)) throw new AppError(INSTALL_ERRORS.extension_installed, { effect: "none" });
    if (this.records.length >= MAX_INSTALLS) throw new AppError(INSTALL_ERRORS.extension_limit, { effect: "none" });
    this.failures.delete(request.name);
    this.pending = { name: request.name, controller: new AbortController() };
    return request;
  }

  /**
   * Installs and loads what `begin` accepted, and records it. A failure is listed (its directory removed) and thrown; the
   * pending mark goes either way. `taken` says which module IDs are in use.
   */
  public complete(request: { name: string; range: string }, taken: (id: string) => boolean): Promise<Module> {
    const pending = this.pending;
    if (pending?.name !== request.name) throw new Error("install_not_pending");
    const record: InstallRecord = { dir: newId(), name: request.name, version: "0.0.0" };
    const job = (async () => {
      const dir = this.directory(record);
      try {
        try {
          await this.installer(dir, request.name, request.range, pending.controller.signal);
        } catch (error) {
          throw new AppError(INSTALL_ERRORS.extension_install_failed, { effect: "none", cause: error });
        }
        await linkHostPackages(dir);
        record.version = await installedVersion(dir, request.name);
        const module = await load(dir, request.name);
        if (taken(module.moduleConfig.id)) throw new AppError(INSTALL_ERRORS.extension_id_taken, { effect: "none", detail: module.moduleConfig.id });
        this.records.push(record);
        await this.persist();
        this.loaded.set(request.name, module);
        log.info("extension.installed", { package: request.name, version: record.version, module: module.moduleConfig.id });
        return module;
      } catch (error) {
        this.records = this.records.filter((item) => item !== record);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        this.failures.set(request.name, codeOf(error, INSTALL_ERRORS.extension_install_failed));
        log.warn("extension.install_failed", { package: request.name, ...errorFields(error) });
        throw error;
      } finally {
        if (this.pending === pending) this.pending = undefined;
      }
    })();
    pending.job = job.catch(() => {});
    return job;
  }

  /** Forgets a package and deletes its files; a failed install only leaves the list. Its module must be stopped first. */
  public async remove(name: unknown): Promise<void> {
    if (typeof name !== "string") throw new AppError(INSTALL_ERRORS.extension_not_found, { effect: "none" });
    if (this.pending?.name === name) throw new AppError(INSTALL_ERRORS.extension_install_busy, { effect: "none" });
    const record = this.records.find((item) => item.name === name);
    if (!record) {
      if (!this.failures.delete(name)) throw new AppError(INSTALL_ERRORS.extension_not_found, { effect: "none" });
      return;
    }
    this.records = this.records.filter((item) => item !== record);
    await this.persist();
    this.loaded.delete(name);
    this.failures.delete(name);
    await rm(this.directory(record), { recursive: true, force: true });
    log.info("extension.removed", { package: name });
  }

  /** Stops an install still running. */
  public async close(): Promise<void> {
    this.pending?.controller.abort();
    await this.pending?.job;
  }

  private directory(record: InstallRecord): string {
    return join(this.root, record.dir);
  }

  private async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(this.root, "state.json"), { version: 1, items: this.records }, { mode: 0o600 });
  }

  /** Directories no record names: an install the process did not live to finish. */
  private async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return;
    }
    const kept = new Set(this.records.map((record) => record.dir));
    for (const name of names) if (name !== "state.json" && !kept.has(name)) await rm(join(this.root, name), { recursive: true, force: true }).catch(() => {});
  }
}

/** With the host's own Yarn (`.yarn/releases`), as a project of its own: no install scripts, no shared cache. */
export async function installPackage(dir: string, name: string, range: string, signal: AbortSignal): Promise<void> {
  const yarn = hostYarn();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, dependencies: { [name]: range } }) + "\n", { mode: 0o600 });
  // The egress policy's proxy, as every other outbound request of this host (convention 05).
  const proxy = proxyFor(new URL(REGISTRY).hostname);
  const settings = {
    nodeLinker: "node-modules",
    // The install writes its own lockfile; Yarn would otherwise refuse that wherever `CI` is set.
    enableImmutableInstalls: false,
    enableScripts: false,
    enableGlobalCache: false,
    enableTelemetry: false,
    npmRegistryServer: REGISTRY,
    ...(proxy ? { httpProxy: proxy, httpsProxy: proxy } : {}),
  };
  // JSON is YAML: each value written as a JSON literal.
  await writeFile(
    join(dir, ".yarnrc.yml"),
    Object.entries(settings)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
      .join(""),
    { mode: 0o600 },
  );
  // An empty lockfile makes the directory a project of its own, even inside the repository.
  await writeFile(join(dir, "yarn.lock"), "");
  // The host's own Yarn settings (a dev run under `yarn`) are not the install's.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:npm_|YARN_|BERRY_)/i.test(key)));
  await new Promise<void>((resolve, reject) =>
    execFile(
      process.execPath,
      [yarn, "install", "--mode=skip-build"],
      { cwd: dir, env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout) => {
        if (!error) return resolve();
        log.warn("extension.yarn_failed", { package: name, output: String(stdout).slice(-2000) });
        reject(error);
      },
    ),
  );
}

/** The package's `extension`, as a module of the registry; `parse` defaults as `defineExtension`'s does. */
async function load(dir: string, name: string): Promise<Module> {
  const root = join(dir, "node_modules", ...name.split("/"));
  const notOne = (detail: string, cause?: unknown) =>
    new AppError(INSTALL_ERRORS.extension_not_extension, { effect: "none", detail: `${name}: ${detail}`, cause });
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch (error) {
    throw notOne("package.json 读不出来", error);
  }
  const target = isRecord(manifest) && isRecord(manifest.exports) ? exportTarget(manifest.exports["./extension"]) : undefined;
  if (!target) throw notOne("没有导出 ./extension");
  let value: unknown;
  try {
    const file = await resolveInside(root, target, { links: "within" });
    value = ((await import(pathToFileURL(file).href)) as { extension?: unknown }).extension;
  } catch (error) {
    throw notOne("./extension 加载失败", error);
  }
  if (!isRecord(value) || !isRecord(value.moduleConfig) || typeof value.start !== "function") throw notOne("extension 应有 moduleConfig 和 start");
  const { id, schema } = value.moduleConfig;
  if (typeof id !== "string" || !isRecord(schema) || typeof schema.safeParse !== "function") throw notOne("moduleConfig 应有 id 和 zod schema");
  let moduleConfig: ModuleConfig;
  try {
    moduleConfig = defineModuleConfig(id, schema as unknown as z.ZodType);
  } catch (error) {
    throw notOne("moduleConfig 不合要求", error);
  }
  const extension = value as { parse?: (raw: unknown) => unknown; start: Module["start"]; kind?: unknown };
  const parse = typeof extension.parse === "function" ? extension.parse.bind(value) : (raw: unknown) => parseConfig(moduleConfig, raw ?? {});
  const start = extension.start.bind(value) as Module["start"];
  return (extension.kind === "connector" ? { kind: "connector", moduleConfig, parse, start } : { moduleConfig, parse, start }) as Module;
}

/** An `exports` entry's file for `import`: a string, or the first of `import`, `node`, `default`, `require`. */
function exportTarget(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.startsWith("./") ? entry : undefined;
  if (!isRecord(entry)) return undefined;
  for (const condition of ["import", "node", "default", "require"]) {
    const target = exportTarget(entry[condition]);
    if (target) return target;
  }
  return undefined;
}

async function installedVersion(dir: string, name: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(dir, "node_modules", ...name.split("/"), "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !VERSION.test(manifest.version)) throw new AppError(INSTALL_ERRORS.extension_not_extension, { effect: "none" });
  return manifest.version;
}

/** Puts the host's copies of its shared packages in place of whatever the install brought. */
async function linkHostPackages(dir: string): Promise<void> {
  const require = createRequire(import.meta.url);
  await mkdir(join(dir, "node_modules"), { recursive: true });
  for (const name of HOST_PACKAGES) {
    const target = join(dir, "node_modules", name);
    await rm(target, { recursive: true, force: true });
    await symlink(dirname(require.resolve(`${name}/package.json`)), target, "dir");
  }
}

function codeOf(error: unknown, fallback: string): string {
  return error instanceof AppError && error.code in INSTALL_ERRORS ? error.code : fallback;
}

/** The Yarn release the host ships with: `.yarn/releases/yarn-*.cjs` in the nearest directory above this file. */
function hostYarn(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    try {
      const release = readdirSync(join(dir, ".yarn", "releases")).find((file) => /^yarn-.*\.cjs$/.test(file));
      if (release) return join(dir, ".yarn", "releases", release);
    } catch {
      /* Not here; one level up. */
    }
    if (dirname(dir) === dir) throw new Error("extension_package_manager_unavailable");
  }
}

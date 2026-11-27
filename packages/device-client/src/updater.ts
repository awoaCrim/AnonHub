import { execFile } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Clock, contentHash, createDirectory, newId, systemClock, writeFileAtomic } from "@yesimbot/foundation";

import { readPrivateJson, writePrivateJson } from "./config.js";
import { RELEASE_PUBLIC_KEY } from "./release-key.js";
import { CLIENT_VERSION, compareVersions, isReleaseVersion } from "./version.js";
import { readFlatZip, type ZipEntry } from "./zip.js";

const MAX_MANIFEST_BYTES = 64 * 1024;

const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;

const RUNTIME_DIRECTORY = /^runtime-v([0-9.]+)-[a-f0-9]{8}$/;

/** What a crash in the middle of an unpack leaves: the staging folder (`createDirectory`) or, before 4.11, `….partial`. */
const UNPACK_LEFTOVER = /^(?:\.runtime-v.+\.staging|runtime-v.+\.partial)$/;

/**
 * Self-update. The client reads the site's download manifest (`/downloads/client.json` beside its
 * gateway), and when a newer release for its own package is listed and signed with the release key, it
 * downloads it, checks the package against its SHA256SUMS, unpacks it into a new `runtime-v…` folder in
 * the state directory, makes sure it starts, and then restarts into it while nothing is running. The
 * previous runtime stays on disk; pairing, settings and ledgers are never touched.
 */
export type ReleasePlatform = "windows-x64" | "portable";

export interface ClientRelease {
  platform: ReleasePlatform;
  url: string;
  size: number;
  sha256: string;
  version: string;
  signature: string;
}

/** An unpacked release in the state directory; paths are relative to it. */
export interface InstalledRuntime {
  version: string;
  directory: string;
  client: "client.cjs";
  node?: "node.exe";
  sha256: string;
}

export interface UpdateSnapshot {
  version: string;
  /** Packaged releases update themselves; builds from source do not. */
  supported: boolean;
  auto: boolean;
  status: "idle" | "checking" | "downloading" | "installing" | "waiting" | "restarting" | "error";
  /** Newest release listed for this package at the last check. */
  latest?: string;
  checkedAt?: number;
  error?: string;
}

export interface UpdaterOptions {
  state: string;
  /** The configured gateway; the manifest is read from the same site. */
  gateway: () => Promise<{ url: string; allowLoopback?: boolean } | undefined>;
  /** Restart into the installed runtime. */
  restart: (runtime: InstalledRuntime) => Promise<void>;
  /** Nothing is running on this computer for the bot right now. */
  idle?: () => boolean;
  version?: string;
  platform?: ReleasePlatform;
  publicKey?: string;
  fetch?: typeof fetch;
  smokeTest?: (state: string, runtime: InstalledRuntime) => Promise<void>;
  /** First check after start, then every `interval` (with jitter). */
  delay?: number;
  interval?: number;
  idlePoll?: number;
  /** After this long busy, the update is applied anyway. */
  maxWait?: number;
  clock?: Clock;
}

export class ClientUpdater {
  private auto = true;
  private status: UpdateSnapshot["status"] = "idle";
  private latest?: string;
  private checkedAt?: number;
  private error?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  readonly version: string;
  readonly platform: ReleasePlatform;
  private readonly clock: Clock;
  private constructor(private readonly options: UpdaterOptions) {
    this.clock = options.clock ?? systemClock();
    this.version = options.version ?? CLIENT_VERSION;
    this.platform = options.platform ?? currentPlatform();
  }
  static async open(options: UpdaterOptions): Promise<ClientUpdater> {
    const updater = new ClientUpdater(options);
    try {
      const preference = (await readPrivateJson(join(options.state, "update.json"))) as { auto?: unknown };
      updater.auto = preference?.auto !== false;
    } catch {
      // No preference yet: updates are automatic.
    }
    return updater;
  }
  get supported(): boolean {
    return isReleaseVersion(this.version);
  }
  snapshot(): UpdateSnapshot {
    return {
      version: this.version,
      supported: this.supported,
      auto: this.auto,
      status: this.status,
      ...(this.latest ? { latest: this.latest } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  start(): void {
    if (!this.supported || this.stopped) return;
    const delay = this.options.delay ?? 2 * 60_000;
    this.schedule(delay);
    setTimeout(() => void this.cleanup(), delay).unref();
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  async setAuto(auto: boolean): Promise<void> {
    await writePrivateJson(join(this.options.state, "update.json"), { version: 1, auto });
    this.auto = auto;
  }
  /** Checks now; installs and restarts only when `install` (or automatic updates) says so. */
  check(install = this.auto): Promise<void> {
    if (!this.supported) return Promise.resolve();
    return (this.running ??= this.run(install).finally(() => (this.running = undefined)));
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.check().finally(() => {
        const interval = this.options.interval ?? 6 * 3600_000;
        this.schedule(interval * (0.9 + Math.random() * 0.2));
      });
    }, delay);
    this.timer.unref();
  }
  private async run(install: boolean): Promise<void> {
    this.status = "checking";
    this.error = undefined;
    try {
      const gateway = await this.options.gateway();
      if (!gateway) throw new Error("gateway_not_configured");
      const site = new URL(gateway.url);
      const loopback = gateway.allowLoopback && site.protocol === "http:" && site.hostname === "127.0.0.1";
      if (site.protocol !== "https:" && !loopback) throw new Error("gateway_not_https");
      const manifest = JSON.parse((await this.download(new URL("/downloads/client.json", site), MAX_MANIFEST_BYTES)).toString("utf8"));
      const release = pickRelease(manifest, this.platform);
      this.checkedAt = this.clock.now();
      if (!release) {
        this.latest = undefined;
        this.status = "idle";
        return;
      }
      if (!verifyRelease(release, this.options.publicKey)) throw new Error("release_signature_invalid");
      this.latest = release.version;
      if (compareVersions(release.version, this.version) <= 0 || !install) {
        this.status = "idle";
        return;
      }
      const runtime = await this.install(release, site);
      if (this.stopped) return;
      this.status = "waiting";
      const deadline = this.clock.now() + (this.options.maxWait ?? 6 * 3600_000);
      while (!this.stopped && this.options.idle && !this.options.idle() && this.clock.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, this.options.idlePoll ?? 30_000).unref());
      if (this.stopped) return;
      this.status = "restarting";
      await this.options.restart(runtime);
    } catch (error) {
      this.status = "error";
      this.error = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : "update_failed";
    }
  }
  private async install(release: ClientRelease, site: URL): Promise<InstalledRuntime> {
    const state = this.options.state;
    const existing = await readInstalledRuntime(state).catch(() => undefined);
    if (existing?.version === release.version && (await newerRuntime(state, this.version))) return existing;
    this.status = "downloading";
    const zip = await this.download(new URL(release.url, site), release.size, 15 * 60_000);
    if (zip.length !== release.size || sha256(zip) !== release.sha256) throw new Error("update_download_mismatch");
    this.status = "installing";
    const files = checkPackage(readFlatZip(zip, { maxEntries: 64, maxTotalBytes: 400 * 1024 * 1024 }), this.platform);
    // The suffix keeps a reinstall of one version apart; the first 8 characters of a v4 UUID are random hex.
    const directory = `runtime-v${release.version}-${newId().slice(0, 8)}`;
    const runtime: InstalledRuntime = {
      version: release.version,
      directory,
      client: "client.cjs",
      ...(files.has("node.exe") ? { node: "node.exe" as const } : {}),
      sha256: sha256(files.get("client.cjs")!),
    };
    // Unpacked and started in a staging folder; only a runtime that starts takes its name.
    await createDirectory(join(state, directory), async (staging) => {
      for (const [name, data] of files) await writeFile(join(staging, name), data, { flag: "wx", mode: /\.(cjs|exe)$/.test(name) ? 0o700 : 0o600 });
      await (this.options.smokeTest ?? smokeTest)(state, { ...runtime, directory: basename(staging) });
    });
    await writePrivateJson(join(state, "runtime.json"), { version: 1, runtime });
    return runtime;
  }
  private async download(url: URL, limit: number, timeout = 15_000): Promise<Buffer> {
    const response = await (this.options.fetch ?? fetch)(url, {
      redirect: "error",
      cache: "no-store",
      headers: { "user-agent": `YesImBot-device/${this.version}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("update_site_unavailable");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) throw new Error("update_download_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  }
  /** Unfinished unpacks go; finished runtimes other than this one, the installed one and the newest other one go too. */
  async cleanup(): Promise<void> {
    const state = this.options.state;
    const keep = new Set<string>([dirname(ownBundle())]);
    const installed = await readInstalledRuntime(state).catch(() => undefined);
    if (installed) keep.add(join(state, installed.directory));
    let names: string[];
    try {
      names = await readdir(state);
    } catch {
      return;
    }
    const finished = names
      .filter((name) => RUNTIME_DIRECTORY.test(name) && !keep.has(join(state, name)))
      .sort((a, b) => compareVersions(RUNTIME_DIRECTORY.exec(b)![1]!, RUNTIME_DIRECTORY.exec(a)![1]!));
    const remove = [...names.filter((name) => UNPACK_LEFTOVER.test(name)), ...finished.slice(1)];
    // Files of a running process (Windows) cannot be removed; they go on a later start.
    await Promise.allSettled(remove.map((name) => rm(join(state, name), { recursive: true, force: true })));
  }
}

/** The exact bytes a release signature covers. */
export function releaseMessage(release: Omit<ClientRelease, "signature">): Buffer {
  return Buffer.from(["yesimbot-client-release:v1", release.platform, release.version, release.url, String(release.size), release.sha256].join("\n"));
}

export function verifyRelease(release: ClientRelease, publicKey = RELEASE_PUBLIC_KEY): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return verify(null, releaseMessage(release), key, Buffer.from(release.signature, "base64"));
  } catch {
    return false;
  }
}

/** The file this client runs from (the bundle in a release). */
export const ownBundle = () => fileURLToPath(import.meta.url);

/** The Windows package runs its bundled node.exe; everything else is the portable package. */
export function currentPlatform(bundle = ownBundle()): ReleasePlatform {
  return process.platform === "win32" && resolve(process.execPath).toLowerCase() === join(dirname(bundle), "node.exe").toLowerCase()
    ? "windows-x64"
    : "portable";
}

/** This package's entry in a version 1 manifest; malformed entries are skipped, a malformed manifest is an error. */
export function pickRelease(manifest: unknown, platform: ReleasePlatform): ClientRelease | undefined {
  const value = manifest as { version?: unknown; releases?: unknown } | null;
  if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.releases)) throw new Error("invalid_release_manifest");
  for (const item of value.releases as Partial<ClientRelease>[]) {
    if (!item || typeof item !== "object" || item.platform !== platform) continue;
    if (
      typeof item.url === "string" &&
      /^\/downloads\/[A-Za-z0-9._-]+\.zip$/.test(item.url) &&
      Number.isSafeInteger(item.size) &&
      item.size! > 0 &&
      item.size! <= MAX_PACKAGE_BYTES &&
      typeof item.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(item.sha256) &&
      typeof item.version === "string" &&
      isReleaseVersion(item.version) &&
      typeof item.signature === "string" &&
      item.signature.length <= 256
    )
      return item as ClientRelease;
  }
}

/** Every file is listed in SHA256SUMS with its hash, and nothing else is in the package. */
export function checkPackage(entries: ZipEntry[], platform: ReleasePlatform): Map<string, Buffer> {
  const files = new Map(entries.map((entry) => [entry.name, entry.data]));
  const sums = files.get("SHA256SUMS");
  if (!sums) throw new Error("package_checksums_missing");
  const listed = new Map<string, string>();
  for (const line of sums.toString("utf8").split("\n")) {
    if (!line) continue;
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(line);
    if (!match || listed.has(match[2]!)) throw new Error("package_checksums_invalid");
    listed.set(match[2]!, match[1]!);
  }
  for (const [name, data] of files) if (name !== "SHA256SUMS" && listed.get(name) !== sha256(data)) throw new Error("package_checksum_mismatch");
  for (const name of listed.keys()) if (!files.has(name)) throw new Error("package_file_missing");
  if (!files.has("client.cjs") || (platform === "windows-x64" && !files.has("node.exe"))) throw new Error("package_file_missing");
  return files;
}

export function runtimePaths(state: string, runtime: InstalledRuntime) {
  const directory = join(state, runtime.directory);
  return { directory, client: join(directory, runtime.client), node: runtime.node ? join(directory, runtime.node) : process.execPath };
}

export async function readInstalledRuntime(state: string): Promise<InstalledRuntime | undefined> {
  let value: { version?: unknown; runtime?: Partial<InstalledRuntime> };
  try {
    value = (await readPrivateJson(join(state, "runtime.json"))) as typeof value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const runtime = value?.runtime;
  if (
    value?.version !== 1 ||
    !runtime ||
    typeof runtime.version !== "string" ||
    !isReleaseVersion(runtime.version) ||
    typeof runtime.directory !== "string" ||
    !RUNTIME_DIRECTORY.test(runtime.directory) ||
    runtime.client !== "client.cjs" ||
    (runtime.node !== undefined && runtime.node !== "node.exe") ||
    typeof runtime.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(runtime.sha256)
  )
    throw new Error("invalid_runtime_record");
  return runtime as InstalledRuntime;
}

/**
 * A newer installed runtime this (older) client should hand over to, e.g. when an old shortcut or a
 * service manager starts the previous version. Only an intact client file is used.
 */
export async function newerRuntime(state: string, own = CLIENT_VERSION): Promise<string | undefined> {
  if (!isReleaseVersion(own)) return;
  const runtime = await readInstalledRuntime(state).catch(() => undefined);
  if (!runtime || compareVersions(runtime.version, own) <= 0) return;
  const { client } = runtimePaths(state, runtime);
  try {
    return sha256(await readFile(client)) === runtime.sha256 ? client : undefined;
  } catch {
    return undefined;
  }
}

/** Windows shortcuts and the login task run these launchers; point them at the new runtime. */
export async function rewriteLaunchers(state: string, runtime: InstalledRuntime): Promise<void> {
  if (process.platform !== "win32") return;
  const { client, node } = runtimePaths(state, runtime);
  for (const [name, args] of [
    ["chat.vbs", "ui --open-chat --auto-start"],
    ["settings.vbs", "ui --open"],
    ["run-hidden.vbs", "ui --auto-start"],
    ["exit.vbs", "quit"],
  ] as const) {
    const file = join(state, name);
    if (!existsSync(file)) continue;
    const command = `"${node}" "${client}" ${args} --state "${state}"`;
    const script = `WScript.Quit CreateObject("WScript.Shell").Run("${command.replaceAll('"', '""')}", 0, True)`;
    // Same encoding install.ps1 writes: UTF-16LE with a byte order mark.
    await writeFileAtomic(file, Buffer.from("\ufeff" + script, "utf16le"));
  }
}

const sha256 = (data: Buffer) => contentHash(data);

/** The new runtime must start and report the version it was published as. */
function smokeTest(state: string, runtime: InstalledRuntime): Promise<void> {
  const { client, node } = runtimePaths(state, runtime);
  return new Promise((resolve, reject) => {
    execFile(node, [client, "version"], { timeout: 30_000, windowsHide: true, env: { ...process.env, YESIMBOT_CLIENT_HOPPED: "1" } }, (error, stdout) => {
      if (error || stdout.trim() !== runtime.version) reject(new Error("update_failed_to_start"));
      else resolve();
    });
  });
}

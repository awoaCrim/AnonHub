import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { configureNetwork, defineModuleConfig } from "@yesimbot/foundation";
import { contextPolicy } from "koishi-plugin-yesimbot-console/server";
import { defineExtension, type Extension } from "koishi-plugin-yesimbot/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { startServer, type RunningServer } from "../src/host.js";
import { installPackage, type Installer } from "../src/installs.js";

// User, 2026-11-26: 「允许用户自己给自己的实例安装拓展，目前莫名其妙的绑定了koishi的拓展市场」.

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hello-extension");
const NAME = "yesimbot-extension-hello";

const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function state(files: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-installs-"));
  roots.push(root);
  await mkdir(join(root, "config"), { mode: 0o700 });
  const all = { "app.json": { server: { host: "127.0.0.1", port: 0 } }, "yesimbot.json": { enabled: true, config: {} }, ...files };
  for (const [name, value] of Object.entries(all)) await writeFile(join(root, "config", name), JSON.stringify(value), { mode: 0o600 });
  return root;
}

/** As Yarn would leave it, without the network: the package's files under the install's node_modules. */
function copying(source = FIXTURE): Installer {
  return async (dir, name) => {
    await cp(source, join(dir, "node_modules", ...name.split("/")), { recursive: true });
  };
}

async function settled(server: RunningServer, name: string) {
  for (let i = 0; i < 200; i++) {
    const item = server.installs.extensions().find((entry) => entry.name === name);
    if (item && !item.installing && (item.error || item.state)) return item;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("install did not settle");
}

async function start(root: string, options: { installer?: Installer; extensions?: readonly Extension[] } = {}) {
  const server = await startServer({
    stateDir: root,
    installer: options.installer ?? copying(),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  });
  running.push(server);
  return server;
}

describe("extensions installed from npm", () => {
  it("installs a package, starts its module enabled with its defaults, and keeps it across a restart", async () => {
    const root = await state();
    const server = await start(root, { extensions: [] });
    expect(server.installs.install(NAME, "")).toEqual({ name: NAME });
    expect(server.installs.extensions()).toEqual([{ name: NAME, installing: true }]);
    const item = await settled(server, NAME);
    expect(item).toEqual({ name: NAME, version: "1.2.0", module: "hello-extension", state: { state: "running" } });
    expect(server.services.get("helloExtension")).toEqual({ greeting: "你好" });
    expect(JSON.parse(await readFile(join(root, "config", "hello-extension.json"), "utf8"))).toEqual({ enabled: true, config: {} });
    await server.stop();
    running.splice(0);

    await writeFile(join(root, "config", "hello-extension.json"), JSON.stringify({ enabled: true, config: { greeting: "早" } }), { mode: 0o600 });
    const again = await start(root, { extensions: [] });
    expect(again.state("hello-extension")).toEqual({ state: "running" });
    expect(again.services.get("helloExtension")).toEqual({ greeting: "早" });
  });

  it("uninstalls: the module stops and its settings and files go", async () => {
    const root = await state();
    const server = await start(root, { extensions: [] });
    server.installs.install(NAME, "1.2.0");
    await settled(server, NAME);
    await server.installs.uninstall(NAME);
    expect(server.installs.extensions()).toEqual([]);
    expect(server.services.get("helloExtension")).toBeUndefined();
    expect(server.state("hello-extension")).toBeUndefined();
    expect(server.installs.ids).not.toContain("hello-extension");
    await expect(readFile(join(root, "config", "hello-extension.json"))).rejects.toThrow();
    expect(await readdir(join(root, "data", "extensions"))).toEqual(["state.json"]);
  });

  it("refuses what is not an npm name or exact version, a second install, and a package installed already", async () => {
    const root = await state();
    const server = await start(root, { extensions: [] });
    const modules = server.installs;
    for (const name of ["", "Bad Name", "../x", "koishi plugin"]) expect(() => modules.install(name, "")).toThrow("extension_name_invalid");
    expect(() => modules.install(NAME, "^1.0.0")).toThrow("extension_version_invalid");
    modules.install(NAME, "");
    expect(() => modules.install("other-package", "")).toThrow("extension_install_busy");
    await settled(server, NAME);
    expect(() => modules.install(NAME, "")).toThrow("extension_installed");
  });

  it("lists a package that is no extension, or whose module ID is taken, as failed and leaves no files", async () => {
    const plain = await mkdtemp(join(tmpdir(), "host-installs-plain-"));
    roots.push(plain);
    await writeFile(join(plain, "package.json"), JSON.stringify({ name: "left-pad", version: "1.3.0", main: "index.js" }));
    const root = await state();
    const taken = defineExtension({ moduleConfig: defineModuleConfig("hello-extension", z.object({})), start() {} });
    const server = await start(root, {
      extensions: [taken as Extension],
      installer: async (dir, name) =>
        name === "left-pad" ? copying(plain)(dir, name, "", new AbortController().signal) : copying()(dir, name, "", new AbortController().signal),
    });
    server.installs.install("left-pad", "");
    expect(await settled(server, "left-pad")).toEqual({ name: "left-pad", error: "extension_not_extension" });
    server.installs.install(NAME, "");
    expect(await settled(server, NAME)).toEqual({ name: NAME, error: "extension_id_taken" });
    expect(await readdir(join(root, "data", "extensions")).catch(() => [])).toEqual([]);
    await server.installs.uninstall("left-pad");
    expect(server.installs.extensions().map((item) => item.name)).toEqual([NAME]);
  });

  it("installs with the host's own Yarn, without running install scripts", async () => {
    const root = await state();
    const server = await start(root, { extensions: [], installer: (dir, name, _range, signal) => installPackage(dir, name, `file:${FIXTURE}`, signal) });
    server.installs.install(NAME, "");
    expect(await settled(server, NAME)).toMatchObject({ name: NAME, version: "1.2.0", state: { state: "running" } });
    expect(server.services.get("helloExtension")).toEqual({ greeting: "你好" });
  }, 60_000);
});

describe("extensions a member installed", () => {
  it("run in the member's own runtime although the account manager's grant does not list them", async () => {
    const root = await state();
    await mkdir(join(root, "policy"), { mode: 0o700 });
    await writeFile(join(root, "policy", "plugins.json"), JSON.stringify({ version: 1, plugins: [] }));
    await writeFile(join(root, "policy", "context.json"), JSON.stringify(contextPolicy({})) + "\n");
    const tenant = "4b0b0c9e-5c43-4f6a-9d3e-0a1b2c3d4e5f";
    const server = await startServer({
      stateDir: root,
      env: { YESIMBOT_TENANT_ID: tenant },
      extensions: [],
      installer: copying(),
      policyFiles: { plugins: join(root, "policy", "plugins.json"), context: join(root, "policy", "context.json"), intervalMs: 50 },
    });
    running.push(server);
    server.installs.install(NAME, "");
    expect(await settled(server, NAME)).toMatchObject({ module: "hello-extension", state: { state: "running" } });
    // A later policy check leaves it running.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.state("hello-extension")).toEqual({ state: "running" });
  });
});

describe("the install's network", () => {
  afterEach(() => configureNetwork({}));

  it("goes through the egress policy's proxy, as every other outbound request does, unless the registry is direct", async () => {
    const root = await mkdtemp(join(tmpdir(), "host-installs-proxy-"));
    roots.push(root);
    configureNetwork({ proxy: "http://127.0.0.1:7890" });
    await installPackage(join(root, "a"), NAME, `file:${FIXTURE}`, new AbortController().signal);
    expect(await readFile(join(root, "a", ".yarnrc.yml"), "utf8")).toContain('httpsProxy: "http://127.0.0.1:7890"');
    configureNetwork({ proxy: "http://127.0.0.1:7890", directHosts: ".npmjs.org" });
    await installPackage(join(root, "b"), NAME, `file:${FIXTURE}`, new AbortController().signal);
    expect(await readFile(join(root, "b", ".yarnrc.yml"), "utf8")).not.toContain("Proxy");
  }, 60_000);
});

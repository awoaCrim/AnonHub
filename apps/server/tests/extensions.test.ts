import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { configureLogging, defineModuleConfig, systemClock, type LogRecord } from "@yesimbot/foundation";
import { defineExtension, type Extension } from "koishi-plugin-yesimbot/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { Accounts } from "../src/accounts.js";
import { EventBus } from "../src/events.js";
import { ExtensionRunner } from "../src/extensions.js";
import { startServer, type RunningServer } from "../src/host.js";
import { HttpServer } from "../src/http.js";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");

const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});

async function state(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-ext-"));
  roots.push(root);
  await mkdir(join(root, "config"), { mode: 0o700 });
  const all = { "app.json": { server: { host: "127.0.0.1", port: 0 } }, "yesimbot.json": { enabled: true, config: {} }, ...files };
  for (const [name, value] of Object.entries(all)) await writeFile(join(root, "config", name), JSON.stringify(value), { mode: 0o600 });
  return root;
}

function probe(id: string, options: { failStart?: boolean } = {}) {
  const calls: string[] = [];
  const extension = defineExtension({
    moduleConfig: defineModuleConfig(id, z.looseObject({ every: z.number().int().min(1).default(10) })),
    start(ctx) {
      calls.push(`start:${ctx.config.every}`);
      ctx.setInterval(() => calls.push("tick"), ctx.config.every);
      ctx.setTimeout(() => calls.push("once"), 1);
      ctx.on("yesimbot/model-usage", () => calls.push("usage"));
      ctx.provide(`${id}Service`, { id });
      if (options.failStart) throw new Error("start failed");
      return () => calls.push("undo");
    },
  });
  return { extension: extension as Extension, calls };
}

describe("extensions on the new host (leave-koishi 6.3)", () => {
  it("starts each enabled extension with its parsed config and removes its timers, listeners and services on stop", async () => {
    const a = probe("yesimbot-probe-a");
    const off = probe("yesimbot-probe-off");
    const root = await state({ "yesimbot-probe-a.json": { enabled: true, config: { every: 20 } }, "yesimbot-probe-off.json": { enabled: false, config: {} } });
    const server = await startServer({ stateDir: root, extensions: [a.extension, off.extension] });
    running.push(server);
    expect(a.calls).toEqual(["start:20"]);
    expect(off.calls).toEqual([]);
    expect(Object.fromEntries(server.modules)).toEqual({ "yesimbot-probe-a": { state: "running" }, "yesimbot-probe-off": { state: "disabled" } });
    expect(server.services.get("yesimbot-probe-aService")).toEqual({ id: "yesimbot-probe-a" });
    await new Promise((resolve) => setTimeout(resolve, 70));
    server.events.emit("yesimbot/model-usage", {});
    expect(a.calls.filter((call) => call === "once")).toHaveLength(1);
    expect(a.calls.filter((call) => call === "tick").length).toBeGreaterThanOrEqual(2);
    expect(a.calls).toContain("usage");
    await server.stop();
    const after = a.calls.length;
    expect(a.calls.at(-1)).toBe("undo");
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.events.emit("yesimbot/model-usage", {});
    expect(a.calls).toHaveLength(after);
    expect(server.services.get("yesimbot-probe-aService")).toBeUndefined();
  });

  it("leaves out an extension whose config does not fit or whose start throws, and runs the others", async () => {
    const records: LogRecord[] = [];
    configureLogging({ sink: (record) => records.push(record) });
    const bad = probe("yesimbot-probe-bad");
    const broken = probe("yesimbot-probe-broken", { failStart: true });
    const good = probe("yesimbot-probe-good");
    const root = await state({
      "yesimbot-probe-bad.json": { enabled: true, config: { every: 0 } },
      "yesimbot-probe-broken.json": { enabled: true, config: {} },
      "yesimbot-probe-good.json": { enabled: true, config: {} },
      "yesimbot-other.json": { enabled: true, config: {} },
    });
    const server = await startServer({ stateDir: root, extensions: [bad.extension, broken.extension, good.extension] });
    running.push(server);
    expect(server.modules.get("yesimbot-probe-bad")).toMatchObject({ state: "failed", stage: "config", error: { code: "config_invalid" } });
    expect(server.modules.get("yesimbot-probe-broken")).toMatchObject({ state: "failed", stage: "start" });
    expect(server.modules.get("yesimbot-probe-good")).toEqual({ state: "running" });
    expect(bad.calls).toEqual([]);
    // What the failed start registered is gone again.
    expect(server.services.get("yesimbot-probe-brokenService")).toBeUndefined();
    expect(records.find((record) => record.event === "host.modules_not_run")?.modules).toEqual(["yesimbot-other"]);
  });

  it("undoes a start that ends after a console edit halted it, and removes what that start registers late", async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    let starts = 0;
    const slow = defineExtension({
      moduleConfig: defineModuleConfig("yesimbot-probe-slow", z.looseObject({})),
      async start(ctx) {
        const start = ++starts;
        calls.push(`start:${start}`);
        if (start === 1) {
          await new Promise<void>((resolve) => (release = resolve));
          ctx.setInterval(() => calls.push("late-tick"), 1);
          ctx.on("yesimbot/model-usage", () => calls.push("late-usage"));
        }
        return () => calls.push(`undo:${start}`);
      },
    });
    const events = new EventBus();
    const runner = new ExtensionRunner({ baseDir: tmpdir(), events, accounts: new Accounts(), http: new HttpServer(), clock: systemClock() }, [
      slow as Extension,
    ]);
    const entry = { enabled: true, config: {} };
    const first = runner.start({} as never, new Map([["yesimbot-probe-slow", entry]]));
    await vi.waitFor(() => expect(calls).toEqual(["start:1"]));
    // A console edit runs the module again while its first start still waits on the network.
    await runner.apply("yesimbot-probe-slow", entry);
    expect(calls).toEqual(["start:1", "start:2"]);
    release();
    await first;
    expect(calls).toEqual(["start:1", "start:2", "undo:1"]);
    expect(runner.states.get("yesimbot-probe-slow")).toEqual({ state: "running" });
    events.emit("yesimbot/model-usage", {} as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["start:1", "start:2", "undo:1"]);
    await runner.stop();
    expect(calls).toEqual(["start:1", "start:2", "undo:1", "undo:2"]);
  });

  it("loads the whole host, every registered extension included, without Koishi", () => {
    const script = `
      const host = require("@yesimbot/server");
      const koishi = Object.keys(require.cache).filter((path) => /node_modules[\\\\/](koishi|@koishijs|@satorijs|cordis|@cordisjs)[\\\\/]/.test(path));
      process.stdout.write(JSON.stringify({ extensions: host.EXTENSIONS.map((extension) => extension.moduleConfig.id), koishi }));
    `;
    const result = spawnSync(process.execPath, ["-e", script], { cwd: PACKAGE, encoding: "utf8" });
    // stderr may carry Node's ExperimentalWarning for node:sqlite; a failed load exits non-zero.
    expect({ status: result.status, stderr: result.status === 0 ? "" : result.stderr }).toEqual({ status: 0, stderr: "" });
    const { extensions, koishi } = JSON.parse(result.stdout) as { extensions: string[]; koishi: string[] };
    expect(extensions.length).toBeGreaterThan(0);
    expect(koishi).toEqual([]);
  });
});

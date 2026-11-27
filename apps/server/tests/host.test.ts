import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { configureLogging, type LogRecord } from "@yesimbot/foundation";
import { afterEach, describe, expect, it } from "vitest";

import { startServer, type RunningServer } from "../src/host.js";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "../dist/main.js");

const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function state(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "host-"));
  roots.push(root);
  await mkdir(join(root, "config"), { mode: 0o700 });
  for (const [name, value] of Object.entries(files)) await writeFile(join(root, "config", name), JSON.stringify(value), { mode: 0o600 });
  return root;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const core = { enabled: true, config: { chatModel: "main:m" } };
const app = { server: { host: "127.0.0.1", port: 0 } };

describe("the host after Koishi (leave-koishi 6.2)", () => {
  it("composes Core from config/, listens, and stops cleanly once", async () => {
    const records: LogRecord[] = [];
    configureLogging({ sink: (record) => records.push(record) });
    const root = await state({ "app.json": app, "yesimbot.json": core, "yesimbot-memorizer.json": { enabled: true, config: {} } });
    const server = await startServer({ stateDir: root, extensions: [] });
    running.push(server);
    expect(server.core.config.chatModel).toBe("main:m");
    server.http.get("/ping", (http) => {
      http.body = "pong";
    });
    const base = `http://127.0.0.1:${server.http.port}`;
    expect(await (await fetch(`${base}/ping`)).text()).toBe("pong");
    // Core keeps its data under the instance directory, as under Koishi.
    expect((await stat(join(root, "data/yesimbot/runtime-identity.json"))).isFile()).toBe(true);
    expect(records.find((record) => record.event === "host.modules_not_run")?.modules).toEqual(["yesimbot-memorizer"]);
    await server.stop();
    await server.stop();
    await expect(fetch(`${base}/ping`)).rejects.toThrow();
    expect(records.filter((record) => record.event === "host.stopped")).toHaveLength(1);
  });

  it("does not start without an enabled Core, or with a Core config that does not fit", async () => {
    await expect(startServer({ stateDir: await state({ "app.json": app }) })).rejects.toMatchObject({ code: "host_core_missing" });
    await expect(startServer({ stateDir: await state({ "app.json": app, "yesimbot.json": { ...core, enabled: false } }) })).rejects.toMatchObject({
      code: "host_core_missing",
    });
    await expect(
      startServer({ stateDir: await state({ "app.json": app, "yesimbot.json": { enabled: true, config: { logLevel: 9 } } }) }),
    ).rejects.toMatchObject({ code: "config_invalid" });
  });

  it("stops what it started when listening fails", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      const root = await state({ "app.json": { server: { host: "127.0.0.1", port } }, "yesimbot.json": core });
      await expect(startServer({ stateDir: root })).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it.skipIf(!existsSync(MAIN))(
    "runs as a process until SIGTERM, then exits 0",
    async () => {
      const port = await freePort();
      const root = await state({ "app.json": { server: { host: "127.0.0.1", port } }, "yesimbot.json": core });
      const child = spawn(process.execPath, [MAIN, "--state", root], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      for (let i = 0; i < 100 && !output.includes('"event":"host.started"'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(output).toContain('"event":"host.started"');
      expect((await fetch(`http://127.0.0.1:${port}/missing`)).status).toBe(404);
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(output).toContain('"event":"host.stopped"');
    },
    20_000,
  );
});

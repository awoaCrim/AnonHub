#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { deviceUrl, deviceCredentialSchema } from "@yesimbot/contracts";
import { systemClock } from "@yesimbot/foundation";

import { clientConfigSchema, readPrivateJson } from "./config.js";
import { ClientController, initialClientConfig } from "./controller.js";
import { startDashboard } from "./dashboard.js";
import { ClientUpdater, newerRuntime, ownBundle, rewriteLaunchers, runtimePaths, type InstalledRuntime } from "./updater.js";
import { CLIENT_VERSION } from "./version.js";

// A device credential must never inherit a host-wide TLS verification bypass.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";

async function existingDashboard(state: string): Promise<string | undefined> {
  try {
    const info = (await readPrivateJson(join(state, "control", "ui.json"))) as { version: number; origin: string; token: string };
    const url = new URL(info.origin);
    if (info.version !== 1 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.origin !== info.origin || !/^[a-f0-9]{64}$/.test(info.token))
      return;
    const response = await fetch(new URL("/api/snapshot", url), {
      headers: { authorization: `Bearer ${info.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });
    await response.body?.cancel();
    if (response.ok) return info.origin + "/#" + info.token;
  } catch {
    /* A stale descriptor is replaced only after acquiring the exclusive controller lease. */
  }
}

async function chatUrl(configPath: string, fallback: string): Promise<string> {
  try {
    return clientConfigSchema.parse(await readPrivateJson(configPath)).consoleUrl ?? fallback;
  } catch {
    return fallback;
  }
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Starts the given client detached and waits until it has started. */
function launch(node: string, args: string[]): Promise<void> {
  const { YESIMBOT_CLIENT_HOPPED: _hopped, ...env } = process.env;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(node, args, { detached: true, stdio: "ignore", windowsHide: true, env });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  if (process.argv[2] === "version") {
    process.stdout.write(CLIENT_VERSION + "\n");
    return;
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      state: { type: "string" },
      config: { type: "string" },
      code: { type: "string" },
      name: { type: "string" },
      gateway: { type: "string" },
      open: { type: "boolean" },
      "open-chat": { type: "boolean" },
      "auto-start": { type: "boolean" },
    },
  });
  const state = resolve(values.state ?? join(homedir(), ".yesimbot-device"));
  const configPath = resolve(values.config ?? join(state, "config.json"));
  const command = positionals[0];
  if (positionals.length !== 1 || !["init", "pair", "unpair", "run", "status", "ui", "quit", "diagnose"].includes(command!))
    throw new Error("invalid_client_command");
  // An old shortcut or service manager may start the previous version: hand over to the newest installed one.
  const newer = process.env.YESIMBOT_CLIENT_HOPPED ? undefined : await newerRuntime(state);
  if (newer) {
    process.env.YESIMBOT_CLIENT_HOPPED = "1";
    createRequire(import.meta.url)(newer);
    return;
  }
  if (command === "init") {
    if (!values.gateway) throw new Error("init_requires_gateway");
    deviceUrl(values.gateway, "/v1/enroll", values.gateway.startsWith("http://127.0.0.1:"));
    await mkdir(state, { recursive: true, mode: 0o700 });
    await writeFile(configPath, JSON.stringify({ ...initialClientConfig(), gateway: values.gateway }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write("配置已创建。运行 ui --open 可在本机页面设置能力和配对。\n");
    return;
  }
  if (command === "status") {
    const credential = deviceCredentialSchema.parse(await readPrivateJson(join(state, "credential.json")));
    process.stdout.write(JSON.stringify({ deviceId: credential.deviceId, tenantId: credential.tenantId, configured: true }) + "\n");
    return;
  }
  if (command === "ui") {
    const existing = await existingDashboard(state);
    if (existing) {
      if (values.open || values["open-chat"]) await openBrowser(values["open-chat"] ? await chatUrl(configPath, existing) : existing);
      process.stdout.write("本机客户端已经运行。\n");
      return;
    }
  }
  if (command === "quit") {
    const existing = await existingDashboard(state);
    if (existing) {
      const url = new URL(existing),
        token = url.hash.slice(1);
      const response = await fetch(new URL("/api/shutdown", url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("client_shutdown_failed");
      const clock = systemClock(),
        deadline = clock.now() + 30_000;
      while (await existingDashboard(state)) {
        if (clock.now() > deadline) throw new Error("client_shutdown_pending");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  const controller = await ClientController.open({ state, configPath });
  let close: () => Promise<void> = () => controller.close();
  const stop = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (command === "quit") {
      await controller.checkStopped();
      await close();
      process.stdout.write("客户端已停止，配对与账本已保留。\n");
      return;
    }
    if (command === "pair") {
      if (!values.code) throw new Error("pair_requires_code");
      await controller.pair(values.code, values.name ?? hostname());
      process.stdout.write("设备已配对。\n");
      await close();
      return;
    }
    if (command === "unpair") {
      await controller.unpair();
      process.stdout.write("设备授权已撤销，旧记录已保留。\n");
      await close();
      return;
    }
    if (command === "diagnose") {
      process.stdout.write(JSON.stringify(await controller.diagnose()) + "\n");
      await close();
      return;
    }
    /** Both long-running modes keep themselves current; `run` restarts as `run`, `ui` as `ui`. */
    const openUpdater = (mode: "ui" | "run") =>
      ClientUpdater.open({
        state,
        gateway: async () => {
          const { config } = await controller.configuration();
          const value = config as { gateway?: unknown; allowLoopback?: unknown };
          return typeof value.gateway === "string" && value.gateway ? { url: value.gateway, allowLoopback: value.allowLoopback === true } : undefined;
        },
        idle: () => controller.idle(),
        restart: async (runtime: InstalledRuntime) => {
          const resume = (await controller.snapshot()).state !== "stopped";
          await rewriteLaunchers(state, runtime).catch(() => {});
          await close();
          // Under systemd the service manager restarts it, and the old entry point hands over.
          if (process.env.INVOCATION_ID) process.exit(75);
          const args = (client: string) => [
            client,
            mode,
            ...(mode === "ui" && resume ? ["--auto-start"] : []),
            "--state",
            state,
            ...(values.config ? ["--config", configPath] : []),
          ];
          const next = runtimePaths(state, runtime);
          await launch(next.node, args(next.client)).catch(() => launch(process.execPath, args(ownBundle())));
          process.exit(0);
        },
      });
    if (command === "ui") {
      const updater = await openUpdater("ui");
      const dashboard = await startDashboard(controller, 0, updater);
      close = () => dashboard.close();
      updater.start();
      if (values["auto-start"]) {
        try {
          if ((await controller.snapshot()).paired) await controller.start();
        } catch {
          process.stderr.write("client_auto_start_failed; open the local settings page\n");
        }
      }
      if (values.open || values["open-chat"]) {
        try {
          const local = dashboard.origin + "/#" + dashboard.token;
          await openBrowser(values["open-chat"] ? await chatUrl(configPath, local) : local);
        } catch {
          process.stderr.write("browser_open_failed; use the client shortcut again\n");
        }
      }
      process.stdout.write("本机客户端已启动。设置页仅在本机开放；关闭页面不会断开连接。\n");
      return;
    }
    await controller.start();
    const updater = await openUpdater("run");
    close = async () => {
      updater.stop();
      await controller.close();
    };
    updater.start();
    process.stdout.write("客户端已启动，离线时自动重连。\n");
  } catch (error) {
    await close();
    throw error;
  }
}
main().catch((error) => {
  const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : "client_start_failed";
  process.stderr.write(code + "\n");
  process.exitCode = 1;
});

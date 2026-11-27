import { createHash } from "node:crypto";
// oxlint-disable-next-line no-restricted-imports -- 撤销时把凭证文件移进 retired/，是移动不是写入（规范 03 的例外）
import { rename, mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";

import { denyToolPolicy, deviceCredentialSchema, deviceUrl, type DeviceCredential } from "@yesimbot/contracts";
import { DeviceProcessLease } from "@yesimbot/device-store";

import { configuredCapabilities, loadClientConfig, pairDevice, readPrivateJson, validateClientConfig, writePrivateJson } from "./config.js";
import { bundledAgentDesktop } from "./drivers/agent-desktop.js";
import { LocalBrowserDriver } from "./drivers/browser.js";
import { deviceStateDirectory, startDeviceRuntime, type RuntimeHandle } from "./runtime.js";

export interface ControllerOptions {
  state: string;
  configPath?: string;
  startRuntime?: typeof startDeviceRuntime;
}

export class ClientController {
  private runtime?: RuntimeHandle;
  private state: "stopped" | "connecting" | "online" | "revoked" = "stopped";
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  readonly configPath: string;
  readonly credentialPath: string;
  private constructor(
    readonly options: ControllerOptions,
    private readonly lease: DeviceProcessLease,
  ) {
    this.configPath = options.configPath ?? join(options.state, "config.json");
    this.credentialPath = join(options.state, "credential.json");
  }
  static async open(options: ControllerOptions): Promise<ClientController> {
    return new ClientController(options, await DeviceProcessLease.acquire(join(options.state, "control")));
  }
  private async credential(): Promise<DeviceCredential | undefined> {
    try {
      return deviceCredentialSchema.parse(await readPrivateJson(this.credentialPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async configuration() {
    let value: unknown;
    try {
      value = await readPrivateJson(this.configPath, 256 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      value = null;
    }
    return {
      config: value ?? initialClientConfig(),
      revision: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      configured: value !== null,
      nativeDesktopAvailable: !!bundledAgentDesktop(),
    };
  }
  /** Nothing is running for the bot on this computer (also when not connected). */
  idle(): boolean {
    return !this.runtime?.client.busy;
  }
  async snapshot() {
    const credential = await this.credential();
    return { state: this.state, paired: !!credential, ...(credential ? { deviceId: credential.deviceId, tenantId: credential.tenantId } : {}) };
  }
  private mutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("controller_closed"));
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => {});
    return pending;
  }
  private async assertEditable(): Promise<void> {
    if (this.runtime) throw new Error("stop_before_editing");
    const credential = await this.credential();
    if (credential) {
      const lease = await DeviceProcessLease.acquire(deviceStateDirectory(this.options.state, credential));
      lease.close();
    }
  }
  checkStopped(): Promise<void> {
    return this.mutation(() => this.assertEditable());
  }
  save(config: unknown, revision: string): Promise<void> {
    return this.mutation(async () => {
      await this.assertEditable();
      const previous = await this.configuration();
      if (previous.revision !== revision) throw new Error("config_changed");
      const next = validateClientConfig(config);
      if (await this.credential()) {
        const old = validateClientConfig(previous.config);
        if (next.gateway !== old.gateway || configuredCapabilities(next).some((cap) => !configuredCapabilities(old).includes(cap)))
          throw new Error("unpair_before_expanding_capabilities");
      }
      await writePrivateJson(this.configPath, next);
    });
  }
  pair(code: string, name: string): Promise<void> {
    return this.mutation(async () => {
      await this.assertEditable();
      if (await this.credential()) throw new Error("device_already_paired");
      if (!/^[a-f0-9]{48}$/.test(code) || !name.trim() || name.length > 128) throw new Error("invalid_pairing_input");
      const config = await loadClientConfig(this.configPath);
      if (!configuredCapabilities(config).length) throw new Error("select_capabilities_first");
      await pairDevice(config, code, name, this.credentialPath);
    });
  }
  unpair(): Promise<void> {
    return this.mutation(async () => {
      await this.stopInternal();
      await this.assertEditable();
      const credential = await this.credential();
      if (!credential) return;
      const config = await loadClientConfig(this.configPath);
      try {
        const response = await fetch(deviceUrl(config.gateway, "/v1/device/revoke", config.allowLoopback), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Device ${credential.deviceId}:${credential.secret}` },
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("revocation_not_confirmed");
      } catch {
        throw new Error("revocation_not_confirmed");
      }
      const archive = join(this.options.state, "retired", credential.deviceId);
      await mkdir(archive, { recursive: true, mode: 0o700 });
      // Preserve credential and all ledgers. Never remove state to permit replay.
      const destination = join(archive, "credential.json");
      try {
        await readPrivateJson(destination);
        throw new Error("retired_identity_exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(this.credentialPath, destination);
      this.state = "stopped";
    });
  }
  start(): Promise<void> {
    return this.mutation(async () => {
      if (this.runtime) return;
      const config = await loadClientConfig(this.configPath),
        credential = await this.credential();
      if (!credential) throw new Error("pair_before_starting");
      this.state = "connecting";
      try {
        const runtime = await (this.options.startRuntime ?? startDeviceRuntime)(this.options.state, config, credential);
        this.runtime = runtime;
        runtime.client.on("online", () => {
          if (this.runtime === runtime) this.state = "online";
        });
        runtime.client.on("offline", (reason) => {
          if (this.runtime === runtime) this.state = reason === "revoked" ? "revoked" : "connecting";
        });
        this.state = runtime.client.revoked ? "revoked" : runtime.client.online ? "online" : "connecting";
      } catch (error) {
        this.state = "stopped";
        throw error;
      }
    });
  }
  stop(): Promise<void> {
    return this.mutation(() => this.stopInternal());
  }
  private async stopInternal() {
    const runtime = this.runtime;
    this.runtime = undefined;
    try {
      await runtime?.close();
    } finally {
      this.state = "stopped";
    }
  }
  async close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      await this.tail;
      try {
        await this.stopInternal();
      } finally {
        this.lease.close();
      }
    })());
  }
  /** Connectivity probes only: no screenshots, input, login, chat opening or message sending. */
  async diagnose() {
    const config = await loadClientConfig(this.configPath);
    const results: { id: string; ok: boolean; message: string }[] = [];
    try {
      const response = await fetch(deviceUrl(config.gateway, "/v1/devices", config.allowLoopback), { redirect: "error", signal: AbortSignal.timeout(4000) });
      await response.body?.cancel();
      results.push({
        id: "gateway",
        ok: response.status === 401,
        message: response.status === 401 ? "网关认证入口可达；连接身份以运行状态为准" : "地址可达，但不是预期的网关认证响应",
      });
    } catch {
      results.push({ id: "gateway", ok: false, message: "无法访问网关，请检查地址与网络" });
    }
    if (config.capabilities.desktop) {
      const ok = await tcpAvailable(config.capabilities.desktop.endpoint);
      results.push({ id: "desktop", ok, message: ok ? "桌面服务端口可达；尚未执行桌面操作" : "本机桌面服务未就绪，请先启动兼容的 MCP 服务" });
    }
    if (config.capabilities.browser) {
      const browser = new LocalBrowserDriver(config.capabilities.browser.endpoint);
      try {
        await browser.probe(AbortSignal.timeout(4000));
        results.push({ id: "browser", ok: true, message: "本机浏览器连接可用；尚未读取或操作网页内容" });
      } catch {
        results.push({ id: "browser", ok: false, message: "本机浏览器尚未就绪，请先用远程调试参数启动 Chrome 或 Edge，并检查连接地址" });
      } finally {
        await browser.close();
      }
    }
    return results;
  }
}

export function initialClientConfig() {
  return { version: 1, gateway: "", workspaceRoot: "./workspaces", policy: denyToolPolicy(), capabilities: { files: false, shell: false } };
}

async function tcpAvailable(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

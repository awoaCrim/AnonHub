import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { loadLocalRuntimeConfig, startLocalDeviceRuntime, RoutedDeviceTransport } from "@yesimbot/device-client";
import { GatewayClient } from "@yesimbot/device-gateway";
import { AppError, defineErrors, readPrivateFile } from "@yesimbot/foundation";
import type { DeviceTransport } from "koishi-plugin-yesimbot/kernel";

import type { Config } from "./config.js";

export const DEVICE_CONNECTION_ERRORS = defineErrors({
  device_connection_config_required: { model: "没有配置设备连接。", user: "没有配置设备网关或本机运行配置。", status: 500 },
  device_connection_config_incomplete: { model: "远程设备连接的配置不完整。", user: "远程设备网关地址和凭证文件要一起配置。", status: 500 },
  device_connection_credential_invalid: { model: "设备网关凭证文件不安全或已损坏。", user: "设备网关凭证文件不安全或已损坏。", status: 500 },
  device_connection_identity_mismatch: { model: "设备网关凭证属于另一个运行实例。", user: "设备网关凭证属于另一个运行实例。", status: 500 },
});

/** The device transport for this runtime and how to release it. */
export interface DeviceConnection {
  readonly transport: DeviceTransport;
  close(): Promise<void>;
}

/**
 * Opens the configured device connection: the local runtime (routing to the remote gateway for other devices) when a
 * local config is given, otherwise the remote gateway alone. Paths are relative to `baseDir`.
 */
export async function openDeviceConnection(config: Config, baseDir: string, tenantId: string): Promise<DeviceConnection> {
  let remote: GatewayClient | undefined;
  if (config.gateway || config.credentialFile) {
    if (!config.gateway || !config.credentialFile) throw new AppError(DEVICE_CONNECTION_ERRORS.device_connection_config_incomplete, { effect: "none" });
    const token = await readCredential(resolve(baseDir, config.credentialFile), tenantId);
    remote = new GatewayClient({
      gateway: config.gateway,
      token,
      tenantId,
      allowLoopback: config.allowLoopback,
      ...(config.localGateway ? { localGateway: config.localGateway } : {}),
    });
  }
  if (config.localConfigFile) {
    const localConfig = await loadLocalRuntimeConfig(resolve(baseDir, config.localConfigFile), tenantId);
    const local = await startLocalDeviceRuntime(localConfig);
    try {
      return { transport: new RoutedDeviceTransport(localConfig.deviceId, local, remote), close: () => local.close() };
    } catch (error) {
      await local.close();
      throw error;
    }
  }
  if (remote) return { transport: remote, close: async () => undefined };
  throw new AppError(DEVICE_CONNECTION_ERRORS.device_connection_config_required, { effect: "none" });
}

/** A single-link regular file no one else can read, holding this tenant's gateway token. */
async function readCredential(path: string, tenantId: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0))
    throw new AppError(DEVICE_CONNECTION_ERRORS.device_connection_credential_invalid, { effect: "none" });
  let value: { version?: unknown; tenantId?: unknown; token?: unknown };
  try {
    value = JSON.parse((await readPrivateFile(path, { maxBytes: 4096 })).toString("utf8"));
  } catch (cause) {
    throw new AppError(DEVICE_CONNECTION_ERRORS.device_connection_credential_invalid, { effect: "none", cause });
  }
  if (value.version !== 1 || value.tenantId !== tenantId || typeof value.token !== "string")
    throw new AppError(DEVICE_CONNECTION_ERRORS.device_connection_identity_mismatch, { effect: "none" });
  return value.token;
}

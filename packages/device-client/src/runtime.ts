import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { DeviceCredential } from "@yesimbot/contracts";
import { bindDeviceDirectory } from "@yesimbot/device-store";

import { DeviceClient } from "./client.js";
import type { ClientConfig } from "./config.js";
import type { DeviceDriver } from "./driver.js";
import { AgentDesktopDriver } from "./drivers/agent-desktop.js";
import { LocalBrowserDriver } from "./drivers/browser.js";
import { LocalDesktopDriver } from "./drivers/desktop.js";
import { LocalFilesDriver } from "./drivers/files.js";
import { LocalShellDriver } from "./drivers/shell.js";

export interface RuntimeHandle {
  readonly client: DeviceClient;
  close(): Promise<void>;
}

export function deviceStateDirectory(state: string, credential: DeviceCredential): string {
  return join(state, "devices", credential.deviceId);
}

export async function startDeviceRuntime(state: string, config: ClientConfig, credential: DeviceCredential): Promise<RuntimeHandle> {
  const directory = deviceStateDirectory(state, credential);
  await bindDeviceDirectory(directory, credential);
  await mkdir(config.workspaceRoot, { recursive: true, mode: 0o700 });
  const drivers: DeviceDriver[] = [];
  const projectRoots = config.capabilities.files ? (config.capabilities.projectRoots ?? []) : [];
  if (config.capabilities.files) drivers.push(new LocalFilesDriver(config.workspaceRoot, projectRoots));
  if (config.capabilities.shell) drivers.push(new LocalShellDriver(config.workspaceRoot, config.capabilities.shellConversationDirectory));
  if (config.capabilities.desktop) drivers.push(new LocalDesktopDriver(config.capabilities.desktop.endpoint));
  if (config.capabilities.agentDesktop) drivers.push(new AgentDesktopDriver(config.capabilities.agentDesktop));
  if (config.capabilities.browser)
    drivers.push(new LocalBrowserDriver(config.capabilities.browser.endpoint, { workspaceRoot: config.workspaceRoot, projectRoots }));
  let client: DeviceClient | undefined;
  try {
    client = await DeviceClient.open({
      gateway: config.gateway,
      ...(config.localGateway ? { localGateway: config.localGateway } : {}),
      directory,
      credential,
      drivers,
      policy: config.policy,
      desktopPort: config.capabilities.remoteDesktop?.port,
      projectRoots,
      allowLoopback: config.allowLoopback,
    });
    client.start();
    await Promise.allSettled(
      drivers.filter((driver): driver is LocalBrowserDriver => driver instanceof LocalBrowserDriver).map((driver) => driver.probe(AbortSignal.timeout(5000))),
    );
    return {
      client,
      close: () => client!.close(),
    };
  } catch (error) {
    if (client) await client.close();
    else await Promise.allSettled(drivers.map((driver) => driver.close?.()));
    throw error;
  }
}

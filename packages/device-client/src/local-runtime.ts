import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { deviceRecordSchema, toolPolicySchema, uuid } from "@yesimbot/contracts";
import { z } from "zod/v4";

import { clientConfigSchema, localDesktopEndpoint, readPrivateJson } from "./config.js";
import type { DeviceDriver } from "./driver.js";
import { AgentDesktopDriver } from "./drivers/agent-desktop.js";
import { LocalBrowserDriver } from "./drivers/browser.js";
import { LocalDesktopDriver } from "./drivers/desktop.js";
import { LocalFilesDriver } from "./drivers/files.js";
import { LocalShellDriver } from "./drivers/shell.js";
import { WindowsDesktopDriver } from "./drivers/windows.js";
import { LocalDeviceTransport } from "./local.js";

export const localRuntimeConfigSchema = z
  .object({
    version: z.literal(1),
    tenantId: uuid,
    deviceId: uuid,
    name: z.string().min(1).max(128),
    createdAt: z.number().int().nonnegative(),
    stateDirectory: z.string().min(1),
    workspaceRoot: z.string().min(1),
    policy: toolPolicySchema,
    capabilities: z
      .object({
        files: z.boolean().default(false),
        projectRoots: clientConfigSchema.shape.capabilities.shape.projectRoots,
        shell: z.boolean().default(false),
        desktop: clientConfigSchema.shape.capabilities.shape.desktop,
        agentDesktop: clientConfigSchema.shape.capabilities.shape.agentDesktop,
        windows: z
          .object({ workerScript: z.string().min(1) })
          .strict()
          .optional(),
        browser: z.object({ endpoint: z.string().url() }).strict().optional(),
      })
      .strict(),
  })
  .strict();

export type LocalRuntimeConfig = z.infer<typeof localRuntimeConfigSchema>;

export async function loadLocalRuntimeConfig(file: string, tenantId: string): Promise<LocalRuntimeConfig> {
  const config = localRuntimeConfigSchema.parse(await readPrivateJson(file, 256 * 1024));
  if (config.tenantId !== tenantId) throw new Error("local_runtime_identity_mismatch");
  config.stateDirectory = resolve(dirname(file), config.stateDirectory);
  config.workspaceRoot = resolve(dirname(file), config.workspaceRoot);
  if (config.capabilities.windows) config.capabilities.windows.workerScript = resolve(dirname(file), config.capabilities.windows.workerScript);
  if (config.capabilities.browser) localDesktopEndpoint(config.capabilities.browser.endpoint);
  if (config.capabilities.desktop) localDesktopEndpoint(config.capabilities.desktop.endpoint);
  if ([config.capabilities.desktop, config.capabilities.windows, config.capabilities.agentDesktop].filter(Boolean).length > 1)
    throw new Error("duplicate_local_desktop_driver");
  return config;
}

export async function startLocalDeviceRuntime(config: LocalRuntimeConfig): Promise<LocalDeviceTransport> {
  const drivers: DeviceDriver[] = [];
  await mkdir(config.workspaceRoot, { recursive: true, mode: 0o700 });
  const projectRoots = config.capabilities.files ? (config.capabilities.projectRoots ?? []) : [];
  if (config.capabilities.files) drivers.push(new LocalFilesDriver(config.workspaceRoot, projectRoots));
  if (config.capabilities.shell) drivers.push(new LocalShellDriver(config.workspaceRoot, true));
  if (config.capabilities.desktop) drivers.push(new LocalDesktopDriver(config.capabilities.desktop.endpoint));
  if (config.capabilities.agentDesktop) drivers.push(new AgentDesktopDriver(config.capabilities.agentDesktop));
  if (config.capabilities.windows) drivers.push(new WindowsDesktopDriver(config.capabilities.windows.workerScript));
  if (config.capabilities.browser)
    drivers.push(new LocalBrowserDriver(config.capabilities.browser.endpoint, { workspaceRoot: config.workspaceRoot, projectRoots }));
  let transport: LocalDeviceTransport | undefined;
  try {
    transport = await LocalDeviceTransport.open({
      directory: config.stateDirectory,
      policy: config.policy,
      drivers,
      ...(projectRoots.length ? { projectRoots } : {}),
      record: deviceRecordSchema.parse({
        tenantId: config.tenantId,
        deviceId: config.deviceId,
        name: config.name,
        createdAt: config.createdAt,
        platform: process.platform,
        capabilities: drivers.map((driver) => driver.capability),
      }),
    });
    // Probe connectivity only. No screenshots, typing, navigation or message sending.
    await Promise.allSettled(
      drivers
        .filter((driver): driver is WindowsDesktopDriver | LocalBrowserDriver => driver instanceof WindowsDesktopDriver || driver instanceof LocalBrowserDriver)
        .map((driver) => driver.probe(AbortSignal.timeout(5000))),
    );
    return transport;
  } catch (error) {
    if (transport) await transport.close();
    else await Promise.allSettled(drivers.map((driver) => driver.close?.()));
    throw error;
  }
}

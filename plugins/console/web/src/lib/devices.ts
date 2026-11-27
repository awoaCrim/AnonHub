import type { DeviceCapability, DeviceView } from "@yesimbot/contracts";

import { api } from "./api";

export interface DeviceList {
  /** False when this runtime has no device gateway. */
  available: boolean;
  devices: DeviceView[];
  /** The computer the bot switched to itself; the owner's next choice replaces it. */
  botSwitch?: { deviceId: string; switchedAt: number };
}

/** Account-scoped shared read cache; refresh actions and polling still request authoritative data. */
export function loadDevices(fresh = false): Promise<DeviceList> {
  return api<DeviceList>("/yesimbot/api/v1/devices", undefined, { fresh });
}

export function devicePlatformName(value: string): string {
  return ({ win32: "Windows", darwin: "macOS", linux: "Linux" } as Record<string, string>)[value] ?? value;
}

export const CAPABILITY_NAMES: Record<DeviceCapability, string> = {
  "workspace.files": "工作区文件",
  "computer.shell": "命令行",
  "computer.desktop": "桌面操作",
  "computer.browser": "浏览器操作",
};

/** A device only for file storage is not a computer the model can operate. */
export function isComputerDevice(device: DeviceView): boolean {
  return device.capabilities.some((capability) => capability.startsWith("computer."));
}

export function isWorkspaceDevice(device: DeviceView): boolean {
  return isComputerDevice(device) || device.capabilities.includes("workspace.files");
}

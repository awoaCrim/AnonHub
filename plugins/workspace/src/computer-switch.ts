import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentTool } from "@yesimbot/agent-runtime";
import { uuid, type DeviceView } from "@yesimbot/contracts";
import { readJson, systemClock, writeFileAtomic, type Clock } from "@yesimbot/foundation";
import type { Devices, WorkspaceComputerSwitch, WorkspaceSwitchControl } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import type { WorkspaceComputerConfig } from "./types.js";

const SWITCH_COMPUTER_SCHEMA = z.strictObject({ deviceId: z.string().describe("要切换到的电脑 ID，取自不填参数时列出的结果").optional() });

const RECORD_FILE = z.object({ version: z.literal(1), deviceId: uuid, switchedAt: z.number().finite(), basis: z.string() });

interface SwitchRecord extends WorkspaceComputerSwitch {
  version: 1;
  /** The owner's computer setting when the bot switched; any later owner choice replaces the switch. */
  basis: string;
}

/**
 * The computer the bot switched to itself. It applies to the whole bot (every conversation that uses a
 * computer) and is read at call time, so a switch takes effect without replacing any runtime. It survives
 * restarts and is dropped once the owner's setting changes or the owner chooses in the console.
 */
export class ComputerSwitchStore implements WorkspaceSwitchControl {
  private record?: SwitchRecord;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly basis: string,
    private readonly clock: Clock = systemClock(),
  ) {}

  async load(): Promise<void> {
    let value: z.infer<typeof RECORD_FILE> | null | undefined;
    try {
      value = await readJson(this.file, RECORD_FILE);
    } catch {
      // Unreadable or in another format: the owner's choice wins, as for a stale record.
      value = null;
    }
    if (value === undefined) return;
    if (value && value.basis === this.basis) this.record = { version: 1, deviceId: value.deviceId, switchedAt: value.switchedAt, basis: this.basis };
    else await rm(this.file, { force: true }).catch(() => {});
  }

  current(): WorkspaceComputerSwitch | undefined {
    return this.record && { deviceId: this.record.deviceId, switchedAt: this.record.switchedAt };
  }

  switchTo(deviceId: string): Promise<void> {
    const record: SwitchRecord = { version: 1, deviceId: uuid.parse(deviceId), switchedAt: this.clock.now(), basis: this.basis };
    return this.queue(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, JSON.stringify(record) + "\n");
      this.record = record;
    });
  }

  clear(): Promise<void> {
    return this.queue(async () => {
      await rm(this.file, { force: true });
      this.record = undefined;
    });
  }

  private queue(write: () => Promise<void>): Promise<void> {
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => {});
    return next;
  }
}

/** The owner's computer setting, in a stable form. */
export function computerSelectionBasis(config: WorkspaceComputerConfig | undefined): string {
  return JSON.stringify([config?.deviceId ?? ""]);
}

/**
 * Lists the paired computers and switches the one the whole bot uses. `current` is the computer this
 * conversation uses now; `configured` is the owner's choice for it. Switching back to the owner's choice
 * drops the switch instead of recording it.
 */
export function createComputerSwitchTool(
  devices: Devices,
  store: ComputerSwitchStore,
  current: () => string | undefined,
  configured: () => string | undefined,
): AgentTool {
  return {
    name: "computer_switch",
    description:
      "查看已接入的电脑，或把整个 bot 当前使用的电脑换成另一台。不填 deviceId 只列出电脑、是否在线和当前用的是哪台。只在确有需要时切换：对方点名要用某台电脑，或当前电脑离线、缺少要用的能力。切换对所有对话立即生效；工作区文件也跟着换到那台电脑，原电脑上的文件不会自动过去。主人在电脑页重新选择会覆盖这次切换。切换后告诉对方换到了哪台。",
    inputSchema: SWITCH_COMPUTER_SCHEMA,
    execute: async (input) => {
      const computers = (await devices.list()).filter(isComputer);
      const using = current();
      const describe = (device: DeviceView) => ({ deviceId: device.deviceId, name: device.name, platform: device.platform, online: device.online });
      if (!input.deviceId)
        return {
          status: "succeeded",
          current: using,
          switchedByBot: !!store.current() && store.current()!.deviceId === using,
          computers: computers.map((device) => ({
            ...describe(device),
            capabilities: device.capabilities,
            current: device.deviceId === using,
            ownerDefault: device.deviceId === configured(),
          })),
        };
      const target = computers.find((device) => device.deviceId === input.deviceId);
      if (!target) return { status: "rejected", code: "unknown_computer", message: "没有这台已接入的电脑。先不填参数列出可用的电脑。" };
      if (!target.online) return { status: "rejected", code: "computer_offline", message: `${target.name} 当前离线，没有切换。` };
      const previous = computers.find((device) => device.deviceId === using);
      if (target.deviceId === using) return { status: "succeeded", changed: false, current: describe(target), message: `已经在用 ${target.name}。` };
      if (target.deviceId === configured()) await store.clear();
      else await store.switchTo(target.deviceId);
      return {
        status: "succeeded",
        changed: true,
        from: previous ? describe(previous) : using,
        current: describe(target),
        message: `整个 bot 现在改用 ${target.name}。工作区文件也在这台电脑上，原电脑上的文件不会自动过去。`,
      };
    },
  };
}

/** A paired computer the bot can work on (a platform-only bridge is not one). */
function isComputer(device: DeviceView): boolean {
  return !device.revokedAt && device.capabilities.some((capability) => capability.startsWith("computer.") || capability === "workspace.files");
}

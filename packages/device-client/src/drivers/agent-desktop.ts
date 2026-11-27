import { execFile } from "node:child_process";
// oxlint-disable-next-line no-restricted-imports -- 定位随客户端发布的可执行文件，不检查外来路径（规范 03 的例外）
import { accessSync, chmodSync, constants, existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { AGENT_DESKTOP_COMMANDS, AgentDesktopClient, desktopSequenceProblem } from "@yesimbot/computer-driver";
import { z } from "zod/v4";

import type { DeviceDriver } from "../driver.js";
import { ownBundle } from "../updater.js";

const inputSchema = z.object({ tool: z.enum(AGENT_DESKTOP_COMMANDS), args: z.record(z.string(), z.unknown()).default({}) }).strict();

/**
 * Desktop control through agent-desktop: the bot reads windows as element trees and acts on elements;
 * screen coordinates only where there are no elements. One operation at a time per computer.
 */
export class AgentDesktopDriver implements DeviceDriver {
  readonly capability = "computer.desktop" as const;
  private busy = false;
  private stopped = false;
  private ready = true;
  private readonly client: AgentDesktopClient | undefined;
  private readonly command: string;
  /** Without an agent-desktop to run, the rest of the client keeps working and desktop control reports unhealthy. */
  constructor(options: { command?: string; physicalInput?: boolean } = {}) {
    const bundled = options.command ? undefined : bundledAgentDesktop();
    const command = options.command ?? bundled?.command;
    this.command = command && isAbsolute(command) ? command : "";
    this.client = this.command
      ? new AgentDesktopClient(this.command, { physicalInput: options.physicalInput ?? process.platform === "linux", env: bundled?.env })
      : undefined;
    if (this.client) this.check();
    else this.ready = false;
  }
  /** Accessibility access is granted outside the client (macOS asks once); until then desktop control is not ready. */
  private check() {
    execFile(this.command, ["status"], { timeout: 15_000 }, (error, stdout) => {
      if (error && !stdout) return void (this.ready = false);
      try {
        const status = JSON.parse(stdout) as { data?: { permissions?: { accessibility?: { state?: string } } } };
        this.ready = status.data?.permissions?.accessibility?.state !== "denied" && status.data?.permissions?.accessibility?.state !== "not_granted";
      } catch {
        this.ready = false;
      }
    });
  }
  healthy() {
    return this.ready;
  }
  readonly methods: DeviceDriver["methods"] = {
    ui: {
      contexts: ["direct", "group"],
      execute: async (invocation, signal) => {
        const input = inputSchema.safeParse(invocation.input);
        // A malformed sequence runs nothing: refuse it so the bot can correct it, instead of an uncertain result.
        if (!input.success || (input.data.tool === "sequence" && desktopSequenceProblem(input.data.args)))
          return { status: "rejected", code: "invalid_desktop_input" };
        if (!this.client) return { status: "rejected", code: "agent_desktop_not_found" };
        if (this.busy || this.stopped || signal.aborted) return { status: "rejected", code: "desktop_unavailable" };
        this.busy = true;
        try {
          const output = await this.client.call(input.data.tool, input.data.args, signal);
          // A permission problem shows up here first; the next health report says so.
          if (output.isError && /PERMISSION|accessibility/i.test(output.text)) this.check();
          return { status: "succeeded", output };
        } finally {
          this.busy = false;
        }
      },
    },
  };
  async close() {
    this.stopped = true;
    await this.client?.close();
  }
}

/**
 * The agent-desktop executable that ships beside the client (client.cjs), for this machine. The macOS helper
 * ships beside it too and is passed by path; Linux finds its clipboard helper under its plain name.
 */
export function bundledAgentDesktop(directory?: string): { command: string; env: Record<string, string> } | undefined {
  if (directory === undefined) {
    for (const candidate of clientDirectories()) {
      const found = bundledAgentDesktop(candidate);
      if (found) return found;
    }
    return undefined;
  }
  const key = `${process.platform}-${process.arch}`;
  const name = { "darwin-arm64": 1, "darwin-x64": 1, "linux-x64": 1, "linux-arm64": 1, "win32-x64": 1, "win32-arm64": 1 }[key]
    ? `agent-desktop-${key}${process.platform === "win32" ? ".exe" : ""}`
    : undefined;
  if (!name || !existsSync(join(directory, name))) return undefined;
  const command = join(directory, name);
  executable(command);
  const env: Record<string, string> = {};
  if (process.platform === "darwin") {
    const helper = join(directory, `agent-desktop-macos-helper-${key}`);
    if (!existsSync(helper)) return undefined;
    executable(helper);
    env.AGENT_DESKTOP_MACOS_HELPER_PATH = helper;
  }
  if (process.platform === "linux") {
    const helper = join(directory, "agent-desktop-linux-clipboard-owner");
    if (existsSync(helper)) executable(helper);
  }
  return { command, env };
}

/**
 * This bundle's own folder first: an older client hands over to a newer installed one inside the same process,
 * so the started script (argv[1]) can be the old copy, without agent-desktop beside it.
 */
function clientDirectories(): string[] {
  const directories: string[] = [];
  for (const file of [ownBundle, () => process.argv[1] ?? ""]) {
    try {
      directories.push(dirname(realpathSync(file())));
    } catch {
      // not a file on disk
    }
  }
  return [...new Set(directories)];
}

/** Release ZIPs carry no file modes: make a shipped executable runnable once. */
function executable(file: string) {
  if (process.platform === "win32") return;
  try {
    accessSync(file, constants.X_OK);
  } catch {
    chmodSync(file, 0o755);
  }
}

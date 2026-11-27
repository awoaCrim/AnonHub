import type { AgentTool } from "@yesimbot/agent-runtime";
import type { OperationResult } from "@yesimbot/contracts";
import type { Clock } from "@yesimbot/foundation";
import { toolActors, type ChannelContext, type Devices } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { connectedBrowser, fixedBrowserRefusal } from "./computer-browser.js";
import { deviceFeature, toolOperationId } from "./computer-call.js";

const SHELL_JOBS_UNSUPPORTED = {
  status: "rejected",
  code: "client_update_required",
  message: "这台电脑的客户端还不支持后台命令，需要先更新电脑客户端。在那之前命令只能在前台运行，最长 5 分钟。",
} as const;

/** Programs that click or capture the screen from a shell, with no feedback on what they hit. */
const GUI_SHELL_PROGRAMS = new Set(["xdotool", "maim", "scrot", "xwd", "import"]);

const SHELL_WRAPPERS = new Set(["sudo", "env", "nohup", "exec", "command", "time", "nice"]);

/** Browser programs and app names, normalized by `browserProgram`. */
const BROWSER_PROGRAMS = new Set([
  "firefox",
  "firefox-esr",
  "firefox-bin",
  "librewolf",
  "waterfox",
  "tor-browser",
  "torbrowser-launcher",
  "chromium",
  "chromium-browser",
  "chrome",
  "google-chrome",
  "google-chrome-stable",
  "microsoft-edge",
  "microsoft-edge-stable",
  "msedge",
  "brave",
  "brave-browser",
  "opera",
  "vivaldi",
  "epiphany",
  "epiphany-browser",
  "falkon",
  "konqueror",
  "midori",
  "safari",
  "sensible-browser",
  "x-www-browser",
  "www-browser",
]);

/** Programs that hand a URL to the desktop's default browser (`xdg-open https://…`), normalized like browsers. */
const URL_OPENERS = new Set([
  "xdg-open",
  "gio",
  "gvfs-open",
  "kde-open",
  "kde-open5",
  "kioclient",
  "kioclient5",
  "gnome-open",
  "exo-open",
  "open",
  "start",
  "explorer",
]);

/** The program a shell command runs to click or capture the screen, if any (quotes respected). */
export function guiShellProgram(command: string): string | undefined {
  return shellPrograms(command).find((program) => GUI_SHELL_PROGRAMS.has(program));
}

/** The browser a shell command starts, if any (normalized name). */
export function shellBrowserProgram(command: string): string | undefined {
  for (const program of shellPrograms(command)) {
    const browser = browserProgram(program);
    if (browser) return browser;
  }
  return undefined;
}

/** The opener a shell command hands a web address to (`xdg-open https://…`, `gio open http://…`), if any. */
export function shellUrlOpener(command: string): string | undefined {
  return shellSegments(command)
    .map((segment) => [shellPrograms(segment)[0], segment] as const)
    .find(([program, segment]) => program && URL_OPENERS.has(program.toLowerCase().replace(/\.exe$/, "")) && /(^|[\s"'=])https?:\/\//i.test(segment))?.[0];
}

/** A browser's normalized name (`/usr/bin/firefox-esr`, `msedge.exe`, `Google Chrome` → firefox-esr, msedge, google-chrome). */
export function browserProgram(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const program = name
    .trim()
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|app|desktop)$/, "")
    .replace(/\s+/g, "-");
  return BROWSER_PROGRAMS.has(program) ? program : undefined;
}

/** `computer_exec` and `computer_job`: shell commands on the bound computer. `desktopTool` names the screen tool that commands must not stand in for. */
export function createShellTools(devices: Devices, scope: ChannelContext, device: () => string, desktopTool: string | undefined, clock: Clock): AgentTool[] {
  return [
    {
      name: "computer_exec",
      description:
        "在当前工作区明确绑定的用户电脑上执行命令。文件工作区也在这台电脑上；执行后检查返回的 cwd、退出码和输出。" +
        "timeoutMs 是前台最多等待的时间（默认 60000，最多 300000）。电脑客户端支持后台命令时，到时还没结束的命令转到后台继续运行并返回 jobId，之后用 computer_job 查看输出、等它结束或停止它；" +
        "预计要跑很久的命令（安装依赖、构建、完整测试、部署、下载大文件）直接设 background: true 在后台启动。" +
        "较旧的客户端不支持后台命令（background 和 computer_job 返回 client_update_required），到时命令会被终止：这时下载、安装这类长命令要自己限时（curl --max-time、pip --timeout）或拆成几段。" +
        "timedOut 表示命令到时被终止，可能已经部分执行：先检查状态再决定是否重跑。结果 unknown 时只查询状态，不能重新执行。" +
        "连接远程主机的命令（ssh、scp、sftp、rsync、curl、wget）要设连接超时（ssh、scp、sftp 加 -o ConnectTimeout=15，curl 加 --connect-timeout 15），也不要让命令停在等待输入的提示上：这样的命令只会一直等到超时，结果还可能变成未知。",
      inputSchema: z.strictObject({
        command: z.string().min(1).max(65536),
        cwd: z.string().optional().describe("用户电脑上的绝对路径；留空使用客户端配置的工作目录"),
        timeoutMs: z.number().int().min(1000).max(300_000).optional(),
        background: z.boolean().optional().describe("true：在后台启动，立即返回 jobId 和最初的输出"),
      }),
      execute: async (input, execution) => {
        const program = desktopTool ? guiShellProgram(input.command) : undefined;
        if (program)
          return {
            status: "rejected",
            code: "use_desktop_tool",
            message: `${program} 在命令行里点击或截图，看不到点中了什么，已拒绝。改用 ${desktopTool}：${desktopTool === "computer_ui" ? "先 snapshot 找到元素再按 ref_id 点击，" : ""}它直接返回截图，点击结果会说明点中了什么。`,
          };
        const browser = shellBrowserProgram(input.command) ?? shellUrlOpener(input.command);
        const deviceId = device();
        if (browser && (await connectedBrowser(devices, deviceId))) return fixedBrowserRefusal(browser);
        const jobs = await shellJobs(devices, deviceId);
        const background = input.background === true;
        if (background && !jobs) return SHELL_JOBS_UNSUPPORTED;
        const timeoutMs = Math.min(300_000, input.timeoutMs ?? 60_000);
        const command = { command: input.command, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) };
        const result = await devices.invoke(
          deviceId,
          {
            scope,
            actors: toolActors(execution.messages, scope.platform),
            operationId: toolOperationId(execution, background ? "shell-start" : "shell"),
            capability: "computer.shell",
            method: background ? "start" : "exec",
            // Older clients refuse unknown fields: `continueAfterTimeout` goes only to clients announcing `shell-jobs`.
            input: background
              ? command
              : { ...command, ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}), ...(jobs ? { continueAfterTimeout: true } : {}) },
            // The client stops waiting at its own timeout; the margin keeps the invocation deadline from racing it.
            expiresAt: clock.now() + (background ? 30_000 : timeoutMs + 15_000),
          },
          execution.abortSignal,
        );
        return explainShellResult(result, background, jobs);
      },
    },
    {
      name: "computer_job",
      description:
        "管理 computer_exec 放到后台的命令（background: true 启动的，或前台等待超时后转入后台的）。" +
        "read：查看状态和新输出，默认只返回上次读取之后的新输出，太长时保留最新的部分；waitMs 最多等 120000 毫秒，命令结束会提前返回，适合等构建、安装、测试跑完，不要用 sleep 轮询；offset 从指定字节位置重读较早的输出。" +
        "stop：停止命令和它的子进程。list：列出本会话在当前电脑上的后台命令。电脑客户端重启时后台命令会一起结束。",
      inputSchema: z.strictObject({
        action: z.enum(["read", "stop", "list"]),
        jobId: z.string().min(36).max(36).optional().describe("read/stop 必填"),
        waitMs: z.number().int().min(0).max(120_000).optional().describe("read：最多等待的毫秒数"),
        offset: z.number().int().min(0).optional().describe("read：从这个字节位置开始读"),
      }),
      execute: async (input, execution) => {
        const deviceId = device();
        if (!(await shellJobs(devices, deviceId))) return SHELL_JOBS_UNSUPPORTED;
        if (input.action !== "list" && typeof input.jobId !== "string")
          return { status: "rejected", code: "invalid_job_input", message: "read 和 stop 需要 jobId；不知道时先用 list 查看。" };
        const waitMs = input.action === "read" && typeof input.waitMs === "number" ? input.waitMs : 0;
        const result = await devices.invoke(
          deviceId,
          {
            scope,
            actors: toolActors(execution.messages, scope.platform),
            operationId: toolOperationId(execution, "shell-job"),
            capability: "computer.shell",
            method: "job",
            input:
              input.action === "list"
                ? { action: "list" }
                : input.action === "stop"
                  ? { action: "stop", id: input.jobId }
                  : { action: "read", id: input.jobId, ...(waitMs ? { waitMs } : {}), ...(input.offset !== undefined ? { offset: input.offset } : {}) },
            expiresAt: clock.now() + Math.min(120_000, waitMs) + 30_000,
          },
          execution.abortSignal,
        );
        if (result.status === "rejected" && result.code === "shell_job_not_found")
          return {
            ...result,
            message: "找不到这个后台命令：jobId 可能写错了，或者已经换到另一台电脑，或者电脑客户端重启过（后台命令随之结束）。用 list 查看当前还有哪些。",
          };
        return result;
      },
    },
  ];
}

/** The program each simple command of a shell line runs, after env prefixes and wrappers like sudo/timeout. */
function shellPrograms(command: string): string[] {
  const programs: string[] = [];
  for (const segment of shellSegments(command)) {
    let wrapped = false,
      skipValue = false;
    for (const token of segment.trim().split(/\s+/)) {
      if (!token || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      if (SHELL_WRAPPERS.has(token) || token === "timeout") {
        wrapped = true;
        continue;
      }
      // Options of a wrapper (with the value of `sudo -u x`, `nice -n 5`, `timeout -s KILL`), and the duration after `timeout`.
      if (skipValue) {
        skipValue = false;
        continue;
      }
      if (wrapped && /^-[ugnsk]$/.test(token)) {
        skipValue = true;
        continue;
      }
      if (wrapped && (token.startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(token))) continue;
      programs.push(token.slice(token.lastIndexOf("/") + 1));
      break;
    }
  }
  return programs;
}

/** Simple commands of a shell line: split on ; & | newlines, subshells and substitutions outside quotes. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "",
    quote: string | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === "\\") {
      current += char + (command[++index] ?? "");
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (";&|\n(){}`".includes(char)) {
      segments.push(current);
      current = "";
    } else current += char;
  }
  segments.push(current);
  return segments;
}

/** Whether the computer's client keeps commands running past their wait as background jobs (`shell-jobs`). */
async function shellJobs(devices: Devices, deviceId: string): Promise<boolean> {
  return deviceFeature(devices, deviceId, "shell-jobs");
}

/**
 * What the model needs next after a shell result. Without `jobs` the client ends commands at their timeout and has no
 * background: it is told so, not to retry the same long command (pipeline audit, 2026-11-20: two tasks lost about 18
 * minutes to installs and downloads cut off at 180–290 s on such a client, planned as if they kept running).
 */
function explainShellResult(result: OperationResult, background: boolean, jobs: boolean): unknown {
  const noJobs =
    "这台电脑的客户端不支持后台命令，到时就会终止命令：下载、安装这类长命令要自己限时（curl --max-time、pip --timeout）或拆成几段，不要原样再跑一次同样长的命令。";
  if (result.status === "unknown" && result.code === "shell_interrupted")
    return {
      ...result,
      message: `命令运行超时或被中断，已被终止，可能已经部分执行。先检查当前状态再决定是否重跑；不要原样重跑有副作用的命令。${jobs ? "" : noJobs}`,
    };
  if (result.status !== "succeeded" || !result.output || typeof result.output !== "object") return result;
  const output = result.output as Record<string, unknown>;
  const message = background
    ? `已在后台启动（jobId ${String(output.jobId)}）。用 computer_job read 查看新输出，可带 waitMs 等它结束；用 stop 停止。`
    : output.running === true
      ? `命令还在运行，已转到后台（jobId ${String(output.jobId)}）。用 computer_job read 查看新输出，可带 waitMs 等它结束；用 stop 停止。不要再次执行同一条命令。`
      : output.timedOut === true
        ? `命令到时被终止（exitCode 为空），可能已经部分执行。先检查当前状态再决定是否重跑；${jobs ? "预计较长的命令用 background: true 在后台运行。" : noJobs}`
        : undefined;
  return message ? { status: result.status, message, output } : result;
}

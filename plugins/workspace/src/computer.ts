import { EphemeralImageProjectionStore, type AgentTool, type NativeImageInputPolicy } from "@yesimbot/agent-runtime";
import { createComputerUseTool } from "@yesimbot/computer-agent";
import { AppError, systemClock, type Clock } from "@yesimbot/foundation";
import type { LanguageModel } from "ai";
import type { ChannelContext, CoreService, Devices } from "koishi-plugin-yesimbot/kernel";

import { createBrowserTool } from "./computer-browser.js";
import { activityOrigin } from "./computer-call.js";
import { createUiTool, remoteDesktop } from "./computer-desktop.js";
import { createShellTools } from "./computer-shell.js";
import { ScreenFrames, usesNormalizedCoordinates } from "./coordinates.js";
import type { WorkspaceComputerConfig } from "./types.js";

/** Visual desktop task deadline and the screen size the vision model plans against. */
const DESKTOP_TIMEOUT_MS = 180_000;

const DESKTOP_DISPLAY_WIDTH = 1280;

const DESKTOP_DISPLAY_HEIGHT = 800;

/** The selected computer is also the file workspace. */
export function selectedComputer(config: WorkspaceComputerConfig | undefined): string | undefined {
  return config?.deviceId || undefined;
}

/**
 * Computer tools for one conversation. `granted` checks platform/context eligibility, not the
 * device's installed driver. The current device protocol does not advertise methods, so keep eligible
 * interfaces independent; the device checks the actual method and its local consent at execution.
 * `model` is the conversation's current chat model, read at call time: it decides how screen
 * coordinates are read (`usesNormalizedCoordinates`).
 */
export function createWorkspaceComputerTools(
  devices: Devices,
  scope: ChannelContext,
  config: WorkspaceComputerConfig,
  imageProjection: EphemeralImageProjectionStore,
  granted: (tool: string) => boolean,
  model?: () => LanguageModel | undefined,
  nativeImageInput: NativeImageInputPolicy = { mode: "unavailable" },
  current?: () => string | undefined,
  clock: Clock = systemClock(),
  models?: Pick<CoreService["model"], "resolveChatModel">,
): AgentTool[] {
  const configured = selectedComputer(config);
  if (!configured) return [];
  const tools: AgentTool[] = [];
  const ui = granted("computer_ui");
  const normalized = () => usesNormalizedCoordinates(model?.());
  const frames = new ScreenFrames();
  // The bot can switch computers mid-conversation: every call reads the one in use now, and screen
  // sizes remembered from the previous computer no longer apply.
  let last = configured;
  const device = () => {
    const deviceId = current?.() ?? configured;
    if (deviceId !== last) frames.clear();
    last = deviceId;
    return deviceId;
  };
  // Clicking or capturing from the shell tells the model nothing about what it hit.
  const desktopTool =
    [...(ui ? ["computer_ui"] : []), ...(config.desktopModel && models && granted("computer_use") ? ["computer_use"] : [])].join(" 或 ") || undefined;
  if (granted("computer_exec")) tools.push(...createShellTools(devices, scope, device, desktopTool, clock));
  if (ui) tools.push(createUiTool(devices, scope, device, imageProjection, frames, normalized, nativeImageInput, clock));
  if (granted("computer_browser")) tools.push(createBrowserTool(devices, scope, device, imageProjection, frames, normalized, nativeImageInput, clock));
  if (config.desktopModel && models && granted("computer_use")) {
    // The sub-loop needs every screenshot to reach the model: the connection decides how a tool-result image is carried.
    const desktop = models.resolveChatModel(config.desktopModel, scope);
    if (desktop.capabilities.imageToolResult !== "native" || typeof desktop.model === "string")
      throw new AppError("workspace_desktop_model_unusable", { effect: "none" });
    tools.push(
      createComputerUseTool({
        imageProjection,
        imageInput: nativeImageInput,
        model: desktop.model,
        timeoutMs: DESKTOP_TIMEOUT_MS,
        displayWidth: DESKTOP_DISPLAY_WIDTH,
        displayHeight: DESKTOP_DISPLAY_HEIGHT,
        driverFactory: (execution) => remoteDesktop(devices, scope, device(), execution, clock),
      }),
    );
  }
  return tools.map((tool) => ({
    ...tool,
    execute: (input, execution) =>
      devices.activity.record(
        tool.name as "computer_exec" | "computer_job" | "computer_use" | "computer_ui" | "computer_browser",
        input,
        device(),
        () => tool.execute(input, execution),
        activityOrigin(scope, execution),
      ),
  }));
}

/**
 * Prefer the connected browser's structured interface for its own pages; other windows use accessibility
 * elements, with screenshots for inaccessible controls. Do not assume every browser exposes a page tree.
 */
export function computerGuidance(tools: readonly string[]): string {
  const desktops = ["computer_ui", "computer_use"].filter((name) => tools.includes(name));
  const desktop = desktops[0];
  const browser = tools.includes("computer_browser")
    ? "computer_browser 只能操作它连接的那个浏览器。电脑连接了浏览器时只用这一个：网页任务都用它完成，验证码、画布等元素列表里没有的部分用它的 screenshot 看、click_at 按截图像素点；不要用桌面工具操作网页，不要启动或改用其他浏览器，它不可用时如实报告。先 tabs 选择页面，再 inspect；动作后直接使用返回的 page 快照继续，不必重复 inspect。同页连续填表并提交用 sequence，跳转或弹窗后先看新页面。"
    : "";
  if (desktops.length > 1)
    return `${browser}其他窗口可用 ${desktops.join("、")}，它们对应不同桌面接口；工具可见不代表设备支持每一种接口，以实际回执确认可用性。computer_ui 先 snapshot 按 ref_id 操作，computer_use 使用已配置的视觉模型。操作结果 unknown 时只能核实，不能换接口重做同一操作。不要用命令行截图再 read。`;
  if (desktop === "computer_ui")
    return `${browser}其他窗口用 computer_ui：先 snapshot 按 ref_id 操作桌面元素；浏览器不提供元素、验证码或画布时用截图坐标。已确定的连续小动作合并成 sequence，一组结束后看返回截图确认结果；需要新页面信息再决定的动作分开。不要用命令行截图再 read。`;
  if (desktop) return `${browser}界面操作（看屏幕、点击、输入）用 ${desktop}。不要用命令行截图再 read。`;
  return browser;
}

import { EphemeralImageProjectionStore, type AgentTool, type AgentToolExecuteContext, type NativeImageInputPolicy } from "@yesimbot/agent-runtime";
import type { DeviceCapability } from "@yesimbot/contracts";
import { AppError, contentHash, imageDimensions, type Clock } from "@yesimbot/foundation";
import { toolActors, type ChannelContext, type Devices } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { BrowserPages, isPage } from "./browser-page.js";
import { screenshotNote, type ImageSize, type Prepared } from "./coordinates.js";

/** A stale ref changed nothing; the page as it is now comes with the refusal. */
const STALE_WITH_PAGE = "页面已变化，ref 失效，没有执行动作。下面的 page 是刚读取的最新页面：用它的 ref 重做这一步。";

/** What the bot should do next after the browser device refuses a call; the device itself answers only a code. */
const BROWSER_REJECTIONS: Record<string, string> = {
  browser_page_unresponsive:
    "页面没有响应（可能卡死，或被弹窗挡住）。没有执行动作。先 tabs 看有没有新开的标签页（OAuth/登录常在弹窗里完成），有就改用新标签页的 targetId；原页面可再试一次 screenshot，仍失败就 navigate 重新打开这个网址，或换一个标签页继续。不要反复重试同一个动作。",
  browser_inspection_failed: "读取页面失败，没有执行动作。页面可能正在跳转：稍等再 inspect；仍失败就 tabs 重新确认标签页，或改用 screenshot 看画面。",
  browser_screenshot_failed:
    "截图失败，没有执行动作。页面可能正在跳转或已关闭：先 tabs 确认这个 targetId 还在，再重试 screenshot；还在但仍失败就 navigate 重新打开。",
  browser_tab_not_found: "没有这个 targetId，标签页可能已关闭或被替换（跳转、弹窗关闭后常见）。先 tabs 重新选择现在的标签页。",
  browser_unavailable: "浏览器当前连不上或正在忙于上一个操作。稍等几秒后先 tabs 再试；一直不行再如实告诉用户浏览器不可用。",
  stale_browser_snapshot: "页面已变化，ref 失效，没有执行动作。先 inspect 取最新 page，再用新的 ref。",
  invalid_browser_input:
    "参数不对，电脑端没有执行。对照工具说明检查 action 和各个字段：ref 用 inspect 返回的 e0、e1，navigate 只能打开 http、https 或 file 网址。改正后重试，不要原样重复。",
};

/** Screen coordinate handling of one tool: Gemini grid conversion before, screenshot sizes after. */
export interface ScreenHooks {
  normalized(): boolean;
  prepare(input: Record<string, unknown>): Prepared;
  observe(input: Record<string, unknown>, size: ImageSize | undefined, text: unknown): void;
}

export function toolOperationId(execution: AgentToolExecuteContext, segment: string): string {
  const value = contentHash(JSON.stringify([execution.runtime.id, execution.turnId, execution.toolCallId, segment]));
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export function browserRejectionMessage(code: unknown): string | undefined {
  return typeof code === "string" ? BROWSER_REJECTIONS[code] : undefined;
}

export function directTool(
  devices: Devices,
  scope: ChannelContext,
  device: () => string,
  name: string,
  description: string,
  capability: DeviceCapability,
  schema: z.ZodType,
  dispatch: (input: Record<string, unknown>) => { method: string; input: unknown },
  images: EphemeralImageProjectionStore | undefined,
  screen: ScreenHooks | undefined,
  nativeImageInput: NativeImageInputPolicy,
  clock: Clock,
): AgentTool {
  const imageOwners = new WeakMap<object, object>();
  const pages = capability === "computer.browser" ? new BrowserPages() : undefined;
  return {
    name,
    description,
    inputSchema: schema as z.ZodType<Record<string, unknown>>,
    execute: async (original, execution) => {
      const deviceId = device();
      images?.clear(execution.toolCallId);
      const { input, note } = screen?.prepare(original) ?? { input: original };
      const coordinates = note ? { coordinates: note } : {};
      const request = dispatch(input),
        started = performance.now();
      const result = await devices.invoke(
        deviceId,
        {
          scope,
          actors: toolActors(execution.messages, scope.platform),
          operationId: toolOperationId(execution, name),
          capability,
          method: request.method,
          input: request.input,
          expiresAt: clock.now() + 60_000,
        },
        execution.abortSignal,
      );
      if (result.status !== "succeeded") {
        const message =
          capability === "computer.browser" && result.status === "rejected" && !("message" in result) ? browserRejectionMessage(result.code) : undefined;
        // A stale ref changed nothing; the page as it is now lets the next call use fresh refs at once (pipeline
        // audit, 2026-11-20: 4 of 5 stale refusals came right after click_at, and each cost another inspect).
        const fresh =
          pages && result.status === "rejected" && result.code === "stale_browser_snapshot" && typeof input.targetId === "string"
            ? await currentPage(input.targetId)
            : undefined;
        return { ...result, ...(message ? { message } : {}), ...(fresh ? { message: STALE_WITH_PAGE, page: fresh } : {}), ...coordinates };
      }
      let output = result.output as { data?: string; mediaType?: string; width?: number; height?: number; text?: string; isError?: boolean };
      const recoveryText = name === "computer_ui" && output?.isError ? desktopTargetRecovery(output.text) : undefined;
      const recovery = recoveryText ? { recovery: recoveryText } : {};
      if (recoveryText && !output.data) {
        // Observe a refused target without replaying it. Accessibility trees can contain duplicate
        // nodes even for a single visible button; another ref from that tree does not disambiguate it.
        try {
          const observed = await devices.invoke(
            deviceId,
            {
              scope,
              actors: toolActors(execution.messages, scope.platform),
              operationId: toolOperationId(execution, `${name}/target-observation`),
              capability,
              method: "ui",
              input: { tool: "screenshot", args: {} },
              expiresAt: clock.now() + 60_000,
            },
            execution.abortSignal,
          );
          const shot = (observed.status === "succeeded" ? observed.output : undefined) as typeof output | undefined;
          if (observed.status === "succeeded" && !shot?.isError && shot?.data && ["image/png", "image/jpeg"].includes(shot.mediaType ?? ""))
            output = { ...output, data: shot.data, mediaType: shot.mediaType, text: `${output.text ?? ""}\n${shot.text ?? ""}` };
        } catch (cause) {
          if (execution.abortSignal?.aborted) throw cause;
          // The original action failure remains authoritative if observation is unavailable.
        }
      }
      if (output && typeof output.data === "string" && output.mediaType?.startsWith("image/")) {
        const receipt = {
          status: "succeeded",
          text: output.text,
          isError: output.isError,
          ...recovery,
          ...coordinates,
          durationMs: Math.round(performance.now() - started),
        };
        if (
          !images ||
          nativeImageInput.mode !== "native" ||
          !["image/png", "image/jpeg"].includes(output.mediaType) ||
          (nativeImageInput.nativeMediaTypes && !nativeImageInput.nativeMediaTypes.includes(output.mediaType))
        )
          return unavailableScreenshot(receipt, "image_input_unavailable");
        if (output.data.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output.data))
          throw new AppError("workspace_desktop_screenshot_invalid", { effect: "unknown" });
        const bytes = Buffer.from(output.data, "base64");
        // The driver's own size wins; agent-desktop reports none here, so read it from the image.
        const size: ImageSize | undefined =
          output.width && output.height && output.width > 0 && output.height > 0 ? { width: output.width, height: output.height } : imageDimensions(bytes);
        const owner = {};
        if (
          !images.stage({
            toolCallId: execution.toolCallId,
            turnId: execution.turnId,
            bytes,
            mediaType: output.mediaType,
            owner,
            signal: execution.abortSignal,
          })
        )
          return unavailableScreenshot(receipt, "image_projection_unavailable");
        screen?.observe(input, size, output.text);
        const projected = {
          ...receipt,
          width: size?.width,
          height: size?.height,
          ...(screen ? { screenshot: screenshotNote(size, screen.normalized()) } : {}),
          imageMode: "native",
        };
        imageOwners.set(projected, owner);
        return projected;
      }
      return {
        ...result,
        ...(pages ? { output: pages.project(original, result.output, execution.turnId) } : {}),
        ...recovery,
        ...coordinates,
        durationMs: Math.round(performance.now() - started),
      };

      async function currentPage(targetId: string) {
        try {
          const look = await devices.invoke(
            deviceId,
            {
              scope,
              actors: toolActors(execution.messages, scope.platform),
              operationId: toolOperationId(execution, `${name}/stale-inspect`),
              capability,
              method: "execute",
              input: { action: "inspect", targetId },
              expiresAt: clock.now() + 60_000,
            },
            execution.abortSignal,
          );
          return look.status === "succeeded" && isPage(look.output)
            ? pages!.project({ action: "inspect", targetId }, look.output, execution.turnId)
            : undefined;
        } catch (cause) {
          if (execution.abortSignal?.aborted) throw cause;
          return undefined;
        }
      }
    },
    ...(images
      ? {
          toModelOutput: ({ toolCallId, output }: { toolCallId: string; output: unknown }) => {
            const receipt = output && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
            const owner = receipt && imageOwners.get(receipt);
            const image = owner && images.get(toolCallId);
            const native = receipt?.imageMode === "native";
            const projected = native && (!image || image.owner !== owner) ? unavailableScreenshot(receipt, "image_projection_unavailable") : output;
            return {
              type: "content" as const,
              value: [
                { type: "text" as const, text: JSON.stringify(projected) },
                ...(native && image && image.owner === owner
                  ? [{ type: "image-data" as const, data: Buffer.from(image.bytes).toString("base64"), mediaType: image.mediaType }]
                  : []),
              ],
            };
          },
        }
      : {}),
  };
}

/** Which conversation, turn, call and agent an operation belongs to, so a chat can show it and find its full record. */
export function activityOrigin(scope: ChannelContext, execution: AgentToolExecuteContext | undefined) {
  return {
    platform: scope.platform,
    channelId: scope.channelId,
    ...(execution?.turnId ? { turnId: execution.turnId } : {}),
    ...(execution?.toolCallId ? { toolCallId: execution.toolCallId } : {}),
    ...(execution?.runtime?.id ? { runtime: execution.runtime.id } : {}),
  };
}

/** Whether the computer's client announced `feature`. Unknown support counts as none: send only what every client accepts. */
export async function deviceFeature(devices: Devices, deviceId: string, feature: string): Promise<boolean> {
  try {
    const device = (await devices.list()).find((item) => item.deviceId === deviceId && !item.revokedAt);
    return device?.features?.includes(feature as never) ?? false;
  } catch {
    return false;
  }
}

function unavailableScreenshot(receipt: Record<string, unknown>, error: "image_input_unavailable" | "image_projection_unavailable") {
  return {
    ...receipt,
    imageMode: "unavailable",
    error,
    screenshot: "当前执行模型没有看到截图内容。操作状态仍以原始回执为准；不要因为截图不可用而重做动作。需要画面时重新执行只读截图。",
  };
}

/** Only deterministic target refusals are observed here; uncertain delivery must never be replayed. */
function desktopTargetRecovery(text: string | undefined): string | undefined {
  if (!text) return;
  try {
    const envelope = JSON.parse(text.split("\n")[0]!) as { error?: { code?: string }; results?: Array<{ text?: string; isError?: boolean }> };
    if (envelope.error?.code === "AMBIGUOUS_TARGET")
      return "目标引用不唯一，可能是无障碍树重复项。动作未重试；不要猜选同名 ref 或重放失败的 sequence。按附图确认唯一可见目标后用 mouse_click，截图缺失先 screenshot；不要继续重复失败路径。";
    if (envelope.error?.code === "STALE_REF") return "引用已过期，动作未重试。先 snapshot 获取新引用，按当前界面继续；不要重放失败的 sequence。";
    const failed = envelope.results?.find((step) => step.isError);
    if (failed) return desktopTargetRecovery(failed.text);
  } catch {
    // Other tool text is not a structured target failure.
  }
}

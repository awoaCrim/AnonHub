import type { DeviceView } from "@yesimbot/contracts";

import type { ScreenViewSource } from "../../../src/shared/device-screen";

/** Without the stream (an older server, or a proxy holding it back): one picture this often. */
export const POLL_INTERVAL = 1_000;

/** The stream's first record comes within the server's 10 s capture limit; nothing by then means it is held back. */
export const STREAM_FIRST_RECORD_MS = 12_000;

/** Includes the server heartbeat interval and a slow capture. */
export const STREAM_IDLE_MS = 30_000;

/** After a stream ends normally (its lifetime), the next one opens this soon. */
export const STREAM_RECONNECT_MS = 300;
const BACKOFF_BASE = 3_000;
const MAX_BACKOFF = 30_000;

export const hasDesktop = (device: DeviceView) => device.capabilities.includes("computer.desktop");

/** The bot's own browser can be watched (its client is new enough to show it without keeping the pictures). */
export const hasBrowserView = (device: DeviceView) => device.capabilities.includes("computer.browser") && !!device.features?.includes("browser-view");
/** The bot browser's tab can be taken over: clicks, keys and text go to the tab, the desktop is left alone. */
export const hasBrowserControl = (device: DeviceView) => hasBrowserView(device) && !!device.features?.includes("browser-control");

/** What to show first: the bot's browser, where the bot works; the desktop only on a computer without it. */
export const defaultScreenSource = (device?: DeviceView): ScreenViewSource => (device && hasBrowserView(device) ? "browser" : "desktop");

/** The computer to show first: an online one with something to show, then any with something to show, then any. */
export function pickScreenDevice(devices: readonly DeviceView[], current?: string): string | undefined {
  if (current && devices.some((device) => device.deviceId === current)) return current;
  const viewable = (device: DeviceView) => hasDesktop(device) || hasBrowserView(device);
  return (devices.find((device) => device.online && viewable(device)) ?? devices.find(viewable) ?? devices[0])?.deviceId;
}

/** Waiting time after `failures` consecutive failed captures. */
export const backoff = (failures: number) => Math.min(MAX_BACKOFF, BACKOFF_BASE * 2 ** Math.max(0, failures));

export interface ScreenProblem {
  text: string;
  /** Retrying cannot help (no permission, unknown computer, server without the feature). */
  stop: boolean;
  /** The computer's client is too old to show its screen; updating it is the fix. */
  update?: boolean;
}

/** Plain words for a failed capture, from the response status and its `{message, reason}` body. */
export function screenProblem(status: number, body?: { message?: unknown; reason?: unknown }, source: ScreenViewSource = "desktop"): ScreenProblem {
  const message = typeof body?.message === "string" ? body.message : "";
  if (status === 409 && message === "screen_unavailable") {
    if (body?.reason === "offline") return { text: "电脑不在线，连上之后这里会显示它的屏幕。", stop: false };
    if (source === "browser") {
      if (body?.reason === "no_browser") return { text: "这台电脑没有给 bot 配浏览器，可以切到「桌面」看屏幕。", stop: false };
      if (body?.reason === "update_required")
        return { text: "这台电脑的客户端版本太旧，看不了 bot 的浏览器。在电脑上更新客户端后，这里会自动显示。", stop: false, update: true };
      return { text: "bot 的浏览器还没就绪，稍后会自动重试。", stop: false };
    }
    if (body?.reason === "no_desktop") return { text: "这台电脑没有开放桌面操作。在电脑上的客户端里打开后就能看到屏幕。", stop: false };
    if (body?.reason === "update_required")
      return { text: "这台电脑的客户端版本太旧，看不了屏幕。在电脑上更新客户端后，这里会自动显示。", stop: false, update: true };
    return { text: "桌面服务还没就绪，稍后会自动重试。", stop: false };
  }
  if (status === 504) return { text: "截屏超时了，稍后会自动重试。", stop: false };
  if (status === 503) return { text: "设备连接服务暂时不可用，稍后会自动重试。", stop: false };
  if (status === 404)
    return message === "not_found" ? { text: "找不到这台电脑，它可能已经被撤销。", stop: true } : { text: "这台服务器的版本还不支持看屏幕。", stop: true };
  if (status === 401) return { text: "登录已过期，请重新登录。", stop: true };
  if (status === 403) return { text: "没有权限查看这台电脑的屏幕。", stop: true };
  return { text: "暂时看不到屏幕，稍后会自动重试。", stop: false };
}

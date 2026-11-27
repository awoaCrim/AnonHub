import { uuid } from "@yesimbot/contracts";

import type { AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import { SCREEN_STREAM_TYPE, type DeviceActivityResponse, type ScreenViewSource } from "../shared/device-screen.js";
import type { DesktopRelay } from "../tenant-runtime-proxy.js";
import { installDeviceControl } from "./device-control.js";
import { DeviceScreens, ScreenError, screenTimeout, streamScreen } from "./device-screen.js";
import { authorizeOwner } from "./plugins.js";

export function installDeviceViewer(ctx: Host, auth: AdminAuth, desktopRelay?: DesktopRelay): void {
  installDeviceControl(ctx, auth, desktopRelay);
  const screens = new DeviceScreens(ctx.yesimbot.devices, ctx.clock);
  ctx.on("dispose", () => screens.dispose());
  // The live screen: one response that carries a new picture whenever the screen changes.
  ctx.server.get("/yesimbot/api/v1/devices/screen/stream", async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const device = uuid.safeParse(http.query.deviceId);
    if (!device.success) {
      http.status = 400;
      http.body = { message: "invalid_device" };
      return;
    }
    const source = screenSource(http.query.source);
    if (!source) {
      http.status = 400;
      http.body = { message: "invalid_source" };
      return;
    }
    const cookie = http.get("cookie");
    const owner = () => {
      const session = auth.sessionFromCookie(cookie);
      return !!session && session.role !== "member";
    };
    const controller = new AbortController();
    const close = () => controller.abort();
    http.res.once("close", close);
    http.req.once("aborted", close);
    if (http.req.aborted || http.res.destroyed) close();
    http.set("Content-Type", SCREEN_STREAM_TYPE);
    http.set("X-Accel-Buffering", "no");
    http.body = streamScreen(screens, device.data, { clock: ctx.clock, signal: controller.signal, authorized: owner, source });
  });
  ctx.server.get("/yesimbot/api/v1/devices/screen", async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const device = uuid.safeParse(http.query.deviceId);
    if (!device.success) {
      http.status = 400;
      http.body = { message: "invalid_device" };
      return;
    }
    const source = screenSource(http.query.source);
    if (!source) {
      http.status = 400;
      http.body = { message: "invalid_source" };
      return;
    }
    const controller = new AbortController();
    const close = () => controller.abort(new ScreenError(409, { message: "screen_unavailable", reason: "not_ready" }));
    // IncomingMessage 'close' also fires on a normally completed GET. The response closes on disconnect.
    http.res.once("close", close);
    http.req.once("aborted", close);
    if (http.req.aborted || http.res.destroyed) close();
    const timer = setTimeout(() => controller.abort(screenTimeout()), 10_000);
    timer.unref?.();
    try {
      const screen = await screens.get(device.data, controller.signal, source);
      if (!authorizeOwner(http, auth) || controller.signal.aborted) return;
      http.set("Cache-Control", "no-store");
      http.set("Content-Type", screen.mediaType);
      http.set("X-Captured-At", String(screen.capturedAt));
      if (screen.scaleFactor) http.set("X-Screen-Scale", String(screen.scaleFactor));
      if (screen.width) http.set("X-Screen-Width", String(screen.width));
      if (screen.height) http.set("X-Screen-Height", String(screen.height));
      http.body = screen.bytes;
    } catch (error) {
      if (!authorizeOwner(http, auth)) return;
      const failure = error instanceof ScreenError ? error : new ScreenError(409, { message: "screen_unavailable", reason: "not_ready" });
      http.status = failure.status;
      http.body = failure.body;
    } finally {
      clearTimeout(timer);
      http.res.off("close", close);
      http.req.off("aborted", close);
    }
  });
  ctx.server.get("/yesimbot/api/v1/devices/activity", async (http) => {
    if (!authorizeOwner(http, auth)) return;
    const { deviceId, limit } = http.query;
    if (deviceId !== undefined && !uuid.safeParse(deviceId).success) {
      http.status = 400;
      http.body = { message: "invalid_device" };
      return;
    }
    if (limit !== undefined && (typeof limit !== "string" || !/^(?:[1-9]\d?|100)$/.test(limit))) {
      http.status = 400;
      http.body = { message: "invalid_limit" };
      return;
    }
    const response: DeviceActivityResponse = {
      items: ctx.yesimbot.devices.activity.list(deviceId as string | undefined, limit === undefined ? 50 : Number(limit)),
    };
    http.body = response;
  });
}

function screenSource(value: unknown): ScreenViewSource | undefined {
  if (value === undefined || value === "desktop") return "desktop";
  if (value === "browser") return "browser";
}

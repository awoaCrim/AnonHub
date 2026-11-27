import { uuid } from "@yesimbot/contracts";

import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import type { DesktopRelay } from "../tenant-runtime-proxy.js";
import { installDeviceViewer } from "./device-viewer.js";
import { authorizeOwner } from "./plugins.js";

/** Members reach their own runtime via the existing authenticated tenant relay. */
export function installDevices(ctx: Host, auth: AdminAuth, desktopRelay?: DesktopRelay): void {
  installDeviceViewer(ctx, auth, desktopRelay);
  ctx.server.get("/yesimbot/api/v1/devices", async (http) => {
    if (!authorizeOwner(http, auth)) return;
    try {
      const available = ctx.yesimbot.devices.available;
      const devices = available ? await ctx.yesimbot.devices.list() : [];
      // The computer the bot switched to itself, shown until the owner chooses again.
      const botSwitch = ctx.yesimbot.devices.workspaceSwitch();
      if (authorizeOwner(http, auth)) http.body = { available, devices, ...(botSwitch ? { botSwitch } : {}) };
    } catch {
      http.status = 503;
      http.body = { message: "device_gateway_unavailable" };
    }
  });
  ctx.server.post("/yesimbot/api/v1/devices/pair", async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    try {
      const pairing = await ctx.yesimbot.devices.pair();
      if (authorizeOwner(http, auth, true)) http.body = pairing;
    } catch {
      http.status = 503;
      http.body = { message: "device_gateway_unavailable" };
    }
  });
  /** The owner's choice replaces the bot's own computer switch. */
  ctx.server.post("/yesimbot/api/v1/devices/switch/clear", async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    try {
      await ctx.yesimbot.devices.clearWorkspaceSwitch();
      if (authorizeOwner(http, auth, true)) http.body = { cleared: true };
    } catch {
      http.status = 503;
      http.body = { message: "computer_switch_unavailable" };
    }
  });
  ctx.server.post("/yesimbot/api/v1/devices/revoke", async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    let deviceId: string;
    try {
      const body = (await readAdminLoginBody(http, 4096)) as { deviceId?: unknown };
      deviceId = uuid.parse(body.deviceId);
    } catch {
      http.status = 400;
      http.body = { message: "invalid_device" };
      return;
    }
    try {
      await ctx.yesimbot.devices.revoke(deviceId);
      if (authorizeOwner(http, auth, true)) http.body = { revoked: true };
    } catch {
      http.status = 503;
      http.body = { message: "device_gateway_unavailable" };
    }
  });
}

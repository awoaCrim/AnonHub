import { controlActionSchema, DESKTOP_CHUNK_BYTES, uuid, type DesktopTunnel } from "@yesimbot/contracts";
import WebSocket from "ws";
import { z } from "zod/v4";

import { readAdminLoginBody, type AdminAuth } from "../admin-auth.js";
import type { Host } from "../host.js";
import { controlLoginFingerprint } from "../relay-control-identity.js";
import type { DesktopRelay } from "../tenant-runtime-proxy.js";
import { authorizeOwner } from "./plugins.js";

/** `source` (acquire only): take over the desktop (default) or the bot browser's tab. */
const bodySchema = z
  .object({
    deviceId: uuid,
    op: z.enum(["acquire", "renew", "release", "input"]),
    token: uuid.optional(),
    action: controlActionSchema.optional(),
    source: z.enum(["desktop", "browser"]).optional(),
  })
  .strict();

export function installDeviceControl(ctx: Host, auth: AdminAuth, desktopRelay?: DesktopRelay) {
  const devices = ctx.yesimbot.devices;
  // Tokens are tied to this login, never to a supplied account/tenant ID.
  const owners = new Map<string, { cookie: string; deviceId: string; until: number; source: "desktop" | "browser" }>();
  const bridges = new Map<() => void, () => void>();
  const unsubscribe = auth.onRevocation(() => {
    for (const check of bridges.keys()) check();
  });
  ctx.on("dispose", () => {
    unsubscribe();
    for (const close of bridges.values()) close();
    for (const [token, lease] of owners) devices.releaseControl(lease.deviceId, token);
    owners.clear();
  });
  // Credentials travel in the first text frame, never in URLs, access logs or WebSocket protocols.
  ctx.server.ws("/yesimbot/api/v1/devices/desktop", async (socket, request) => {
    if (await desktopRelay?.(socket, request)) return;
    const cookie = request.headers.cookie ?? "";
    const session = auth.sessionFromCookie(cookie);
    const http = {
      get: (key: string) => String(request.headers[key] ?? ""),
      origin: `${(request.socket as { encrypted?: boolean }).encrypted ? "https" : "http"}://${request.headers.host}`,
    };
    if (
      !session ||
      session.role === "member" ||
      !request.headers.origin ||
      !auth.sameOrigin(http as never) ||
      request.url !== "/yesimbot/api/v1/devices/desktop"
    ) {
      socket.close(1008);
      return;
    }
    const controller = new AbortController();
    let token = "",
      deviceId = "",
      tunnel: DesktopTunnel | undefined;
    const fingerprint = controlLoginFingerprint(http);
    const valid = () => {
      const owner = owners.get(token);
      return (
        auth.sessionFromCookie(cookie) === session &&
        socket.readyState === WebSocket.OPEN &&
        (!token || (!!owner && owner.cookie === fingerprint && owner.deviceId === deviceId && owner.until > ctx.clock.now()))
      );
    };
    const close = () => {
      controller.abort();
      tunnel?.close();
      if (token && deviceId) {
        devices.releaseControl(deviceId, token);
        owners.delete(token);
      }
      socket.close(1008);
    };
    const check = () => {
      if (!valid()) close();
    };
    bridges.set(check, close);
    const deadline = setTimeout(close, 5000);
    const heartbeat = setInterval(check, 1000);
    deadline.unref();
    heartbeat.unref();
    socket.on("error", close);
    socket.on("close", () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      bridges.delete(check);
      controller.abort();
      tunnel?.close();
      if (token && deviceId) {
        devices.releaseControl(deviceId, token);
        owners.delete(token);
      }
    });
    let opening = false;
    const queued: Uint8Array[] = [];
    let queuedBytes = 0;
    socket.on("message", (data, binary) => {
      if (!valid()) return close();
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!opening) {
        if (binary || bytes.length > 512) return close();
        const parsed = z
          .object({ deviceId: uuid, token: uuid })
          .strict()
          .safeParse(
            (() => {
              try {
                return JSON.parse(bytes.toString());
              } catch {
                return;
              }
            })(),
          );
        if (!parsed.success) return close();
        ({ token, deviceId } = parsed.data);
        if (!valid()) {
          token = "";
          return close();
        }
        opening = true;
        void devices
          .openControlDesktop(
            deviceId,
            token,
            {
              data: (value) => {
                if (!valid() || socket.bufferedAmount > 4 * 1024 * 1024) return close();
                socket.send(value, { binary: true });
              },
              close,
            },
            controller.signal,
          )
          .then((opened) => {
            tunnel = opened;
            clearTimeout(deadline);
            if (!valid() || controller.signal.aborted) return close();
            for (const value of queued) tunnel.send(value);
            queued.length = 0;
          })
          .catch(close);
        return;
      }
      if (!binary || bytes.length > DESKTOP_CHUNK_BYTES) return close();
      if (tunnel) tunnel.send(bytes);
      else if ((queuedBytes += bytes.length) <= 128 * 1024) queued.push(bytes);
      else close();
    });
  });
  ctx.server.post("/yesimbot/api/v1/devices/control", async (http) => {
    if (!authorizeOwner(http, auth, true)) return;
    for (const [token, lease] of owners)
      if (lease.until <= ctx.clock.now()) {
        devices.releaseControl(lease.deviceId, token);
        owners.delete(token);
      }
    const cookie = controlLoginFingerprint(http);
    try {
      const parsed = bodySchema.safeParse(await readAdminLoginBody(http, 24000));
      if (!parsed.success) {
        http.status = 400;
        http.body = { message: "invalid_control_input" };
        return;
      }
      const { deviceId, op, token, action, source = "desktop" } = parsed.data;
      if (op === "acquire") {
        const granted = await devices.acquireControl(deviceId, source);
        if (!authorizeOwner(http, auth, true) || http.res.destroyed) {
          devices.releaseControl(deviceId, granted);
          return;
        }
        owners.set(granted, { cookie, deviceId, until: ctx.clock.now() + 30_000, source });
        http.body = { token: granted };
        return;
      }
      const owner = token && owners.get(token);
      if (!token || !owner || owner.cookie !== cookie || owner.deviceId !== deviceId) {
        http.status = 409;
        http.body = { message: "computer_control_expired" };
        return;
      }
      if (op === "release") {
        devices.releaseControl(deviceId, token);
        owners.delete(token);
        http.body = { ok: true };
        return;
      }
      if (!devices.renewControl(deviceId, token)) {
        owners.delete(token);
        throw Error("computer_control_expired");
      }
      owner.until = ctx.clock.now() + 30_000;
      if (op === "renew") {
        http.body = { ok: true };
        return;
      }
      if (!action) {
        http.status = 400;
        http.body = { message: "invalid_control_input" };
        return;
      }
      // The bot browser takes the action as it is, in pixels of its view; the desktop gets desktop tools.
      if (owner.source === "browser") {
        const result = await devices.controlBrowser(deviceId, token, action, AbortSignal.timeout(20_000));
        if (result.status !== "succeeded") {
          http.status = 409;
          http.body = { message: "computer_input_unconfirmed" };
          return;
        }
        http.body = { ok: true };
        return;
      }
      const input =
        action.type === "click"
          ? { tool: "mouse_click", args: { xy: `${action.x},${action.y}`, button: action.button, ...(action.count ? { count: action.count } : {}) } }
          : action.type === "move"
            ? { tool: "mouse_move", args: { xy: `${action.x},${action.y}` } }
            : action.type === "drag"
              ? { tool: "drag", args: { from_xy: `${action.x},${action.y}`, to_xy: `${action.toX},${action.toY}` } }
              : action.type === "scroll"
                ? { tool: "mouse_wheel", args: { x: action.x, y: action.y, dy: action.dy } }
                : action.type === "key"
                  ? { tool: "press", args: { combo: action.key } }
                  : {
                      tool: "sequence",
                      args: {
                        actions: [
                          { tool: "clipboard_set", args: { text: action.text } },
                          {
                            tool: "press",
                            args: { combo: (await devices.list()).find((d) => d.deviceId === deviceId)?.platform === "darwin" ? "cmd+v" : "ctrl+v" },
                          },
                        ],
                      },
                    };
      const result = await devices.controlInput(deviceId, token, input, AbortSignal.timeout(20_000));
      // No screenshots, typed text or private desktop output are reflected to API callers.
      if (result.status !== "succeeded" || (result.output as { isError?: boolean } | undefined)?.isError) {
        http.status = 409;
        http.body = { message: "computer_input_unconfirmed" };
        return;
      }
      http.body = { ok: true };
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      http.status = 409;
      http.body = {
        message: ["computer_control_busy", "computer_control_unavailable", "computer_control_expired"].includes(code) ? code : "computer_input_unconfirmed",
      };
    }
  });
}

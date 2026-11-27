import WebSocket from "ws";

import type { Host } from "./host.js";
import type { TenantManagerClient } from "./tenant-manager-client.js";

/** Existing same-container NapCat stays logged in while its bot runs on an external managed instance. */
export function installLocalOneBotRelay(ctx: Host, manager: TenantManagerClient, runtimeId: string, path = "/onebot") {
  if (!/^\/onebot(?:\/[a-zA-Z0-9_-]{1,128})?$/.test(path)) throw new Error("invalid_onebot_relay_path");
  const sockets = new Set<WebSocket>();
  ctx.server.ws(path, async (socket, request) => {
    const peer = request.socket.remoteAddress;
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
      ["origin", "forwarded", "x-forwarded-for", "x-real-ip"].some((header) => request.headers[header] !== undefined)
    ) {
      socket.close(1008);
      return;
    }
    const selfId = request.headers["x-self-id"],
      role = request.headers["x-client-role"];
    if (typeof selfId !== "string" || !/^[1-9][0-9]{4,14}$/.test(selfId) || typeof role !== "string" || !["Universal", "Event", "API"].includes(role)) {
      socket.close(1008);
      return;
    }
    socket.pause();
    sockets.add(socket);
    let upstream: WebSocket | undefined;
    const close = () => {
      socket.close();
      upstream?.close();
      sockets.delete(socket);
      if (upstream) sockets.delete(upstream);
    };
    socket.on("close", close);
    socket.on("error", close);
    try {
      if ((await manager.runtime(runtimeId)).state !== "running") return close();
      const url = new URL(manager.path(runtimeId, "/onebot"), manager.endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      upstream = new WebSocket(url, {
        headers: { ...(await manager.headers()), "x-self-id": selfId, "x-client-role": role },
        maxPayload: 20 * 1024 * 1024,
        handshakeTimeout: 10000,
      });
      sockets.add(upstream);
      upstream.on("open", () => socket.resume());
      upstream.on("error", close);
      upstream.on("close", close);
      const send = (to: WebSocket, data: WebSocket.RawData, binary: boolean) => {
        if (to.readyState !== WebSocket.OPEN || to.bufferedAmount > 20 * 1024 * 1024) return close();
        to.send(data, { binary });
      };
      socket.on("message", (data, binary) => send(upstream!, data, binary));
      upstream.on("message", (data, binary) => send(socket, data, binary));
    } catch {
      close();
    }
  });
  ctx.on("dispose", () => {
    for (const socket of sockets) socket.close(1012);
    sockets.clear();
  });
}

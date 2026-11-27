import { EventEmitter } from "node:events";

import { systemClock } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";

import { installManagedOneBotIngress } from "../src/managed-ingress.js";

describe("managed OneBot ingress", () => {
  it("rejects externally reachable reverse WebSockets while preserving loopback and console routes", () => {
    const server = new EventEmitter();
    const dispose = vi.fn();
    installManagedOneBotIngress({ clock: systemClock(), server: { http: server }, on: dispose } as never);
    for (const path of ["/onebot", "/onebot?test=1", "/onebot/"]) {
      const socket = { destroy: vi.fn() };
      server.emit("upgrade", { url: path, socket: { remoteAddress: "172.17.0.1" } }, socket);
      expect(socket.destroy).toHaveBeenCalledOnce();
    }
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const socket = { destroy: vi.fn() };
      server.emit("upgrade", { url: "/onebot", socket: { remoteAddress: address } }, socket);
      expect(socket.destroy).not.toHaveBeenCalled();
    }
    for (const header of ["origin", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]) {
      const socket = { destroy: vi.fn() };
      server.emit("upgrade", { url: "/onebot/private-path", socket: { remoteAddress: "127.0.0.1" }, headers: { [header]: "external" } }, socket);
      expect(socket.destroy).toHaveBeenCalledOnce();
    }
    const browser = { destroy: vi.fn() };
    server.emit("upgrade", { url: "/status", socket: { remoteAddress: "172.17.0.1" } }, browser);
    expect(browser.destroy).not.toHaveBeenCalled();
    dispose.mock.calls[0][1]();
    expect(server.listenerCount("upgrade")).toBe(0);
  });
});

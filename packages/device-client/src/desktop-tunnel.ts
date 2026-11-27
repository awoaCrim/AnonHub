import { connect, type Socket } from "node:net";

import { authorizeTool, DESKTOP_CHUNK_BYTES, isDesktopStream, type DeviceInvocation, type ToolPolicy } from "@yesimbot/contracts";
import type { Clock } from "@yesimbot/foundation";

/** One opt-in loopback desktop session. No RFB bytes enter operation/history journals. */
export class LocalDesktopTunnel {
  private socket?: Socket;
  private streamId?: string;
  constructor(
    private readonly port: number | undefined,
    private readonly tenantId: string,
    private readonly policy: ToolPolicy,
    private readonly clock: Clock,
    private readonly emit: (id: string, data?: string) => void,
  ) {}
  get active() {
    return !!this.socket;
  }
  open(id: string, invocation: DeviceInvocation, busy: boolean) {
    if (
      !this.port ||
      busy ||
      this.active ||
      !isDesktopStream(invocation) ||
      invocation.conversation.tenantId !== this.tenantId ||
      invocation.expiresAt <= this.clock.now() ||
      invocation.expiresAt > this.clock.now() + 30_000 ||
      !authorizeTool(
        { conversation: invocation.conversation, actors: [] },
        { name: "computer.desktop.remote", pluginId: "computer.desktop", contexts: ["direct"] },
        this.policy,
      ).allowed
    ) {
      this.emit(id);
      return;
    }
    this.streamId = id;
    const socket = (this.socket = connect({ host: "127.0.0.1", port: this.port }));
    socket.setNoDelay(true);
    const deadline = setTimeout(() => this.close(id), 10 * 60_000);
    deadline.unref();
    const connecting = setTimeout(() => this.close(id), 5000);
    connecting.unref();
    socket.on("connect", () => clearTimeout(connecting));
    socket.on("data", (bytes) => {
      for (let offset = 0; offset < bytes.length; offset += DESKTOP_CHUNK_BYTES)
        this.emit(id, bytes.subarray(offset, offset + DESKTOP_CHUNK_BYTES).toString("base64"));
    });
    socket.on("error", () => this.close(id));
    socket.on("close", () => {
      clearTimeout(deadline);
      clearTimeout(connecting);
      if (this.socket === socket) {
        this.socket = undefined;
        this.streamId = undefined;
      }
      this.emit(id);
    });
  }
  write(id: string, data: string) {
    if (id !== this.streamId || !this.socket) return;
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > DESKTOP_CHUNK_BYTES || bytes.toString("base64") !== data || this.socket.writableLength > 1024 * 1024) {
      this.close(id);
      return;
    }
    this.socket.write(bytes);
  }
  close(id = this.streamId) {
    if (id !== this.streamId) return;
    // Retain exclusion until the local RFB connection actually closes.
    this.socket?.destroy();
  }
}

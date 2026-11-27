import { EventEmitter } from "node:events";

import {
  deviceCredentialSchema,
  DEVICE_FEATURES,
  DEVICE_FEATURES_HEADER,
  DEVICE_VERSION_HEADER,
  DEVICE_ROOTS_HEADER,
  encodeDeviceRoots,
  deviceUrl,
  isScreenViewRead,
  localGatewayUrl,
  MAX_DEVICE_FRAME_BYTES,
  parseDeviceFrame,
  serverFrameSchema,
  type DeviceClientFrame,
  type DeviceCredential,
  type DeviceServerFrame,
  type ToolPolicy,
} from "@yesimbot/contracts";
import { bindDeviceDirectory, OperationStore, DeviceProcessLease } from "@yesimbot/device-store";
import { type Clock, systemClock } from "@yesimbot/foundation";
import { WebSocket } from "ws";

import { LocalDesktopTunnel } from "./desktop-tunnel.js";
import type { DeviceDriver } from "./driver.js";
import { DeviceExecutor } from "./executor.js";
import { CLIENT_VERSION, isReleaseVersion } from "./version.js";

/** After the local address cannot be reached, the public one is used; the local one is checked again this often. */
const LOCAL_RETRY_MS = 5 * 60_000;

/** While an operation runs, switching back to the local address waits this long between checks. */
const LOCAL_SWITCH_WAIT_MS = 10_000;

export interface DeviceClientOptions {
  gateway: string;
  credential: DeviceCredential;
  directory: string;
  drivers: readonly DeviceDriver[];
  policy: ToolPolicy;
  /** Explicit local test/development flag. Never accepts non-loopback cleartext. */
  allowLoopback?: boolean;
  /** The same gateway on this machine's host bridge (`http://192.168.241.1:17401`); tried first, the public address is the fallback. */
  localGateway?: string;
  reconnectMs?: number;
  desktopPort?: number;
  /** Project directories opened to file tools; announced so the bot knows where it may work. */
  projectRoots?: readonly string[];
  /** How long the public address is used after the local one could not be reached; tests shorten it. */
  localRetryMs?: number;
  clock?: Clock;
}

/** Outgoing-only connection. Drivers are injected, so no plugin owns another plugin's transport. */
export class DeviceClient extends EventEmitter {
  private socket?: WebSocket;
  private readonly desktop: LocalDesktopTunnel;
  private connectionId?: string;
  private stopped = true;
  private closed = false;
  private authorizationRevoked = false;
  private retry?: ReturnType<typeof setTimeout>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private readonly url: URL;
  private readonly localUrl?: URL;
  private localDownUntil = 0;
  private localCheck?: ReturnType<typeof setTimeout>;
  private socketRoute: "local" | "public" = "public";
  private readonly clock: Clock;

  private constructor(
    private readonly options: DeviceClientOptions,
    private readonly executor: DeviceExecutor,
    private readonly lease: DeviceProcessLease,
  ) {
    super();
    this.clock = options.clock ?? systemClock();
    this.desktop = new LocalDesktopTunnel(options.desktopPort, options.credential.tenantId, options.policy, this.clock, (streamId, data) => {
      if (data !== undefined && (this.socket?.bufferedAmount ?? 0) > 1024 * 1024) {
        this.desktop.close(streamId);
        return;
      }
      if (this.connectionId)
        this.send(
          data === undefined
            ? { type: "desktop-close", connectionId: this.connectionId, streamId }
            : { type: "desktop-data", connectionId: this.connectionId, streamId, data },
        );
    });
    this.url = deviceUrl(options.gateway, "/v1/connect", options.allowLoopback);
    this.url.protocol = this.url.protocol === "https:" ? "wss:" : "ws:";
    if (options.localGateway !== undefined) {
      this.localUrl = localGatewayUrl(options.localGateway, "/v1/connect");
      this.localUrl.protocol = "ws:";
    }
  }
  /** Which address the current connection uses; for the local page and tests. */
  get route(): "local" | "public" | undefined {
    return this.socket ? this.socketRoute : undefined;
  }

  static async open(options: DeviceClientOptions): Promise<DeviceClient> {
    deviceCredentialSchema.parse(options.credential);
    deviceUrl(options.gateway, "/v1/connect", options.allowLoopback);
    if (options.localGateway !== undefined) localGatewayUrl(options.localGateway, "/v1/connect");
    await bindDeviceDirectory(options.directory, options.credential);
    const lease = await DeviceProcessLease.acquire(options.directory);
    let store: OperationStore | undefined;
    try {
      const clock = options.clock ?? systemClock();
      store = await OperationStore.open(options.directory, clock);
      return new DeviceClient({ ...options, clock }, new DeviceExecutor(options.credential, options.drivers, store, options.policy, clock), lease);
    } catch (error) {
      store?.close();
      lease.close();
      throw error;
    }
  }

  start(): void {
    if (this.closed) throw new Error("client_closed");
    if (this.stopped) {
      this.stopped = false;
      this.connect();
    }
  }
  get online(): boolean {
    return this.connectionId !== undefined && this.socket?.readyState === WebSocket.OPEN;
  }
  get revoked(): boolean {
    return this.authorizationRevoked;
  }

  /** An operation is running; updates wait for it. */
  get busy(): boolean {
    return this.executor.busy;
  }

  disconnect(): void {
    this.socket?.terminate();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    clearTimeout(this.localCheck);
    clearInterval(this.healthTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.connectionId = undefined;
    socket?.terminate();
    try {
      await this.executor.close();
    } finally {
      this.lease.close();
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const local = this.localUrl !== undefined && this.clock.now() >= this.localDownUntil;
    /** The gateway answered at all: the route works, even if it refused this attempt. */
    let answered = false;
    const socket = new WebSocket(local ? this.localUrl! : this.url, {
      headers: {
        Authorization: `Device ${this.options.credential.deviceId}:${this.options.credential.secret}`,
        // A header, not a hello field: older gateways ignore it, while they reject unknown frame fields.
        [DEVICE_FEATURES_HEADER]: DEVICE_FEATURES.filter((feature) => feature !== "desktop-stream" || !!this.options.desktopPort).join(","),
        ...(isReleaseVersion(CLIENT_VERSION) ? { [DEVICE_VERSION_HEADER]: CLIENT_VERSION } : {}),
        ...(this.options.projectRoots?.length ? { [DEVICE_ROOTS_HEADER]: encodeDeviceRoots(this.options.projectRoots) } : {}),
      },
      maxPayload: MAX_DEVICE_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
      followRedirects: false,
    });
    this.socket = socket;
    this.socketRoute = local ? "local" : "public";
    const welcomeTimer = setTimeout(() => {
      if (!this.connectionId) socket.terminate();
    }, 10_000);
    welcomeTimer.unref();
    let heartbeat: ReturnType<typeof setTimeout>;
    const refreshHeartbeat = () => {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(() => socket.terminate(), 45_000);
      heartbeat.unref();
    };
    socket.on("ping", refreshHeartbeat);
    socket.on("upgrade", () => (answered = true));
    // E.g. 401 while the gateway still holds this device's previous connection. With this listener
    // ws leaves the handshake open, so end it here; close then retries the same address.
    socket.on("unexpected-response", (_request, response) => {
      answered = true;
      response.resume();
      socket.terminate();
    });
    socket.on("open", () => {
      refreshHeartbeat();
      this.send({
        type: "hello",
        version: 1,
        deviceId: this.options.credential.deviceId,
        capabilities: this.options.drivers.map((driver) => driver.capability),
      });
    });
    socket.on("error", () => {
      /* close handles recovery; never expose credential-bearing request objects */
    });
    socket.on("close", (code) => {
      clearTimeout(welcomeTimer);
      clearTimeout(heartbeat);
      clearInterval(this.healthTimer);
      clearTimeout(this.localCheck);
      if (this.socket !== socket) return;
      // Nothing answered on the local address (refused, unreachable, timed out): use the public one for a while.
      if (local && !answered) this.localDownUntil = this.clock.now() + this.localRetryMs;
      this.socket = undefined;
      this.connectionId = undefined;
      this.executor.cancelAll();
      this.desktop.close();
      if (code === 4003) this.authorizationRevoked = true;
      this.emit("offline", code === 4003 ? "revoked" : "disconnected");
      if (code === 4003) this.stopped = true;
      if (!this.stopped) {
        this.retry = setTimeout(() => this.connect(), Math.max(100, this.options.reconnectMs ?? 3000));
      }
    });
    socket.on("message", (data, binary) => {
      try {
        if (binary || this.socket !== socket) throw new Error("invalid_frame");
        const frame = parseDeviceFrame(data.toString(), serverFrameSchema);
        if (!this.connectionId) {
          if (
            frame.type !== "welcome" ||
            frame.device.deviceId !== this.options.credential.deviceId ||
            frame.device.tenantId !== this.options.credential.tenantId ||
            frame.device.revokedAt !== undefined ||
            this.options.drivers.some((driver) => !frame.device.capabilities.includes(driver.capability))
          )
            throw new Error("invalid_welcome");
          this.connectionId = frame.connectionId;
          clearTimeout(welcomeTimer);
          this.sendHealth();
          this.healthTimer = setInterval(() => this.sendHealth(), 5000);
          this.healthTimer.unref();
          this.emit("online");
          if (!local && this.localUrl) this.checkLocalLater(socket, this.localDownUntil - this.clock.now());
          return;
        }
        if (frame.type === "welcome" || frame.connectionId !== this.connectionId) throw new Error("stale_frame");
        void this.handle(frame).catch(() => socket.close(1011, "client_state_unavailable"));
      } catch {
        socket.close(1008, "invalid_gateway_frame");
      }
    });
  }

  private get localRetryMs(): number {
    return Math.max(100, this.options.localRetryMs ?? LOCAL_RETRY_MS);
  }
  /** On the public address: once the local one answers again and nothing is running, reconnect over it. */
  private checkLocalLater(socket: WebSocket, delay: number): void {
    clearTimeout(this.localCheck);
    this.localCheck = setTimeout(() => void this.checkLocal(socket), Math.max(0, delay));
    this.localCheck.unref();
  }
  private async checkLocal(socket: WebSocket): Promise<void> {
    const current = () => this.socket === socket && this.connectionId !== undefined && !this.stopped;
    if (!current()) return;
    const reachable = await answers(this.localUrl!);
    if (!current()) return;
    if (!reachable) {
      this.localDownUntil = this.clock.now() + this.localRetryMs;
      return this.checkLocalLater(socket, this.localRetryMs);
    }
    this.localDownUntil = 0;
    // Closing cancels running operations: wait until idle.
    if (this.desktop.active || this.executor.busy) return this.checkLocalLater(socket, LOCAL_SWITCH_WAIT_MS);
    socket.close(1000, "local_route_available");
  }

  private async handle(frame: Exclude<DeviceServerFrame, { type: "welcome" }>): Promise<void> {
    if (frame.type === "desktop-open") {
      this.desktop.open(frame.streamId, frame.invocation, this.executor.busy);
      return;
    }
    if (frame.type === "desktop-data") {
      this.desktop.write(frame.streamId, frame.data);
      return;
    }
    if (frame.type === "desktop-close") {
      this.desktop.close(frame.streamId);
      return;
    }
    if (frame.type === "cancel") {
      this.executor.cancel(frame.operationId);
      return;
    }
    const operationId = frame.type === "invoke" ? frame.invocation.operationId : frame.operationId;
    const result =
      frame.type === "invoke"
        ? this.desktop.active && !isScreenViewRead(frame.invocation)
          ? { status: "rejected" as const, code: "computer_user_controlled" }
          : await this.executor.execute(frame.invocation)
        : this.executor.status(operationId);
    if (frame.connectionId === this.connectionId)
      this.send({ type: "result", connectionId: frame.connectionId, requestId: frame.requestId, operationId, result });
  }

  private send(frame: DeviceClientFrame): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const bytes = JSON.stringify(frame);
    if (Buffer.byteLength(bytes) > MAX_DEVICE_FRAME_BYTES || socket.bufferedAmount > MAX_DEVICE_FRAME_BYTES) {
      socket.terminate();
      return false;
    }
    socket.send(bytes, (error) => {
      if (error) socket.terminate();
    });
    return true;
  }
  private sendHealth(): void {
    if (!this.connectionId) return;
    this.send({
      type: "health",
      connectionId: this.connectionId,
      health: Object.fromEntries(this.options.drivers.map((driver) => [driver.capability, driver.healthy?.() ?? true])),
    });
  }
}

/** Any HTTP answer from the local gateway's origin within 3 seconds; its status does not matter. */
async function answers(connectUrl: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL("/", `http://${connectUrl.host}`), { signal: AbortSignal.timeout(3000), redirect: "manual" });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

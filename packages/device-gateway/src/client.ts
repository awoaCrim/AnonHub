import {
  DESKTOP_CHUNK_BYTES,
  isDesktopStream,
  type DesktopReceiver,
  type DesktopTunnel,
  deviceHealthSchema,
  deviceRecordSchema,
  deviceUrl,
  localGatewayUrl,
  MAX_DEVICE_FRAME_BYTES,
  operationResultSchema,
  parseDeviceFeatures,
  parseDeviceVersion,
  uuid,
  type DeviceInvocation,
  type DeviceView,
  type OperationResult,
} from "@yesimbot/contracts";
import { type Clock, httpFetch, systemClock, type BoundedResponse } from "@yesimbot/foundation";
import { WebSocket } from "ws";

/** Connection-level failures: the request never reached the gateway, so sending it again elsewhere cannot repeat it. */
const UNSENT = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"]);

const LOCAL_RETRY_MS = 60_000;

export interface GatewayClientOptions {
  gateway: string;
  tenantId: string;
  token: string;
  allowLoopback?: boolean;
  /** The same gateway on this host's bridge (`http://172.18.0.1:17401`); preferred, the public address is the fallback. */
  localGateway?: string;
}

/** Runtime SDK: an invocation is sent once. HTTP interruption yields unknown; callers may query status. */
export class GatewayClient {
  /** The local address failed; until then requests go to the public one. */
  private localDownUntil = 0;
  constructor(
    private readonly options: GatewayClientOptions,
    private readonly clock: Clock = systemClock(),
  ) {
    uuid.parse(options.tenantId);
    if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error("invalid_runtime_credential");
    deviceUrl(options.gateway, "/v1/devices", options.allowLoopback);
    if (options.localGateway !== undefined) localGatewayUrl(options.localGateway, "/v1/devices");
  }
  async openDesktop(deviceId: string, invocation: DeviceInvocation, receiver: DesktopReceiver, signal: AbortSignal): Promise<DesktopTunnel> {
    uuid.parse(deviceId);
    if (invocation.conversation.tenantId !== this.options.tenantId || !isDesktopStream(invocation)) throw Error("tenant_denied");
    const path = `/v1/desktop/${deviceId}`;
    const url =
      this.options.localGateway && this.clock.now() >= this.localDownUntil
        ? localGatewayUrl(this.options.localGateway, path)
        : deviceUrl(this.options.gateway, path, this.options.allowLoopback);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    signal.throwIfAborted();
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "x-yesimbot-desktop-invocation": Buffer.from(JSON.stringify(invocation)).toString("base64url"),
      },
      maxPayload: DESKTOP_CHUNK_BYTES,
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
      followRedirects: false,
      rejectUnauthorized: true,
    });
    const close = () => (socket.readyState === WebSocket.CONNECTING ? socket.terminate() : socket.close());
    signal.addEventListener("abort", close, { once: true });
    socket.on("close", () => {
      signal.removeEventListener("abort", close);
      receiver.close();
    });
    socket.on("message", (data, binary) => {
      if (!binary || signal.aborted) return close();
      receiver.data(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(Error("desktop_connection_failed")));
      socket.once("close", () => reject(Error("desktop_connection_closed")));
    });
    return {
      close,
      send(bytes) {
        if (signal.aborted || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024 * 1024) {
          close();
          return;
        }
        for (let offset = 0; offset < bytes.length; offset += DESKTOP_CHUNK_BYTES)
          socket.send(bytes.subarray(offset, offset + DESKTOP_CHUNK_BYTES), { binary: true });
      },
    };
  }
  async list(): Promise<DeviceView[]> {
    // An older gateway ignores the query and omits features; such devices simply show none.
    const result = await this.request("GET", "/v1/devices?features=1");
    if (!Array.isArray(result) || result.length > 10_000) throw new Error("invalid_device_list");
    return result.map((value) => {
      const { online, health, features, version, ...record } = value,
        device = deviceRecordSchema.parse(record);
      if (typeof online !== "boolean" || device.tenantId !== this.options.tenantId) throw new Error("foreign_device_response");
      if (features !== undefined && (!Array.isArray(features) || features.length > 32)) throw new Error("invalid_device_list");
      return {
        ...device,
        online,
        ...(health === undefined ? {} : { health: deviceHealthSchema.parse(health) }),
        ...(features === undefined ? {} : { features: parseDeviceFeatures(features) }),
        ...(parseDeviceVersion(version) ? { version: parseDeviceVersion(version) } : {}),
      };
    });
  }
  async pair(): Promise<{ code: string; expiresAt: number }> {
    const value = (await this.request("POST", "/v1/pairings")) as { code?: unknown; expiresAt?: unknown };
    if (typeof value?.code !== "string" || !/^[a-f0-9]{48}$/.test(value.code) || !Number.isSafeInteger(value.expiresAt))
      throw new Error("invalid_pairing_response");
    return { code: value.code, expiresAt: value.expiresAt as number };
  }
  async revoke(deviceId: string): Promise<void> {
    uuid.parse(deviceId);
    await this.request("DELETE", `/v1/devices/${deviceId}`);
  }
  async invoke(deviceId: string, invocation: DeviceInvocation, signal?: AbortSignal): Promise<OperationResult> {
    uuid.parse(deviceId);
    if (invocation.conversation.tenantId !== this.options.tenantId) return { status: "rejected", code: "tenant_denied" };
    try {
      return operationResultSchema.parse(
        await this.request(
          "POST",
          "/v1/invoke",
          { deviceId, invocation },
          signal,
          Math.min(610_000, Math.max(1000, invocation.expiresAt - this.clock.now() + 5000)),
        ),
      );
    } catch {
      return { status: "unknown", code: "gateway_result_unavailable" };
    }
  }
  async status(deviceId: string, operationId: string, signal?: AbortSignal): Promise<OperationResult> {
    uuid.parse(deviceId);
    uuid.parse(operationId);
    return operationResultSchema.parse(await this.request("GET", `/v1/devices/${deviceId}/operations/${operationId}`, undefined, signal, 20_000));
  }
  /**
   * Local address first while it works. A read that fails at the local address is repeated at the public
   * one; a write only when the connection itself failed (it never reached the gateway), so an invocation
   * is still sent at most once.
   */
  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 15_000): Promise<unknown> {
    // The bridge address is this host's private network; the public one is a known service, never redirected.
    const send = (url: URL, purpose: "internal" | "public") =>
      httpFetch(url, {
        purpose,
        method,
        headers: { authorization: `Bearer ${this.options.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        timeoutMs,
        maxBytes: MAX_DEVICE_FRAME_BYTES,
        maxRedirects: 0,
      });
    const publicUrl = deviceUrl(this.options.gateway, path, this.options.allowLoopback);
    let response: BoundedResponse;
    if (this.options.localGateway !== undefined && this.clock.now() >= this.localDownUntil) {
      try {
        response = await send(localGatewayUrl(this.options.localGateway, path), "internal");
      } catch (error) {
        if (signal?.aborted) throw error;
        if (method !== "GET" && !unsent(error)) throw error;
        this.localDownUntil = this.clock.now() + LOCAL_RETRY_MS;
        response = await send(publicUrl, "public");
      }
    } else response = await send(publicUrl, "public");
    if (!response.ok) {
      await response.cancel();
      throw new Error("gateway_request_failed");
    }
    return JSON.parse(await response.text());
  }
}

/** The connection itself failed (the code sits somewhere in the cause chain), so the request never reached the gateway. */
function unsent(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 5; cause = (cause as { cause?: unknown }).cause, depth++) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && UNSENT.has(code)) return true;
  }
  return false;
}

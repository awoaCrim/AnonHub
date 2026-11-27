import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  clientFrameSchema,
  DESKTOP_CHUNK_BYTES,
  DEVICE_FEATURES_HEADER,
  DEVICE_VERSION_HEADER,
  DEVICE_ROOTS_HEADER,
  deviceInvocationSchema,
  enrollmentSchema,
  MAX_DEVICE_FRAME_BYTES,
  MAX_DEVICE_INPUT_BYTES,
  MAX_DEVICE_FILE_INPUT_BYTES,
  deviceInputLimit,
  isScreenViewRead,
  isDesktopStream,
  operationResultSchema,
  parseDeviceFeatures,
  parseDeviceVersion,
  parseDeviceRoots,
  parseDeviceFrame,
  uuid,
  type DeviceCapability,
  type DeviceFeature,
  type DeviceInvocation,
  type DeviceRecord,
  type DeviceServerFrame,
  type DeviceView,
  type OperationResult,
} from "@yesimbot/contracts";
import { OperationStore, ResourceBindings } from "@yesimbot/device-store";
import { type Clock, newId, systemClock } from "@yesimbot/foundation";
import { WebSocket, WebSocketServer } from "ws";

import { DeviceRegistry } from "./registry.js";

export interface GatewayOptions {
  directory: string;
  /** Trusted runtime/console authentication. Must not read a tenant ID from request input. */
  authenticate: (request: IncomingMessage) => Promise<string | undefined>;
  /** Required cloud policy gate, applied again on every invocation. */
  authorize: (invocation: DeviceInvocation, device: DeviceRecord) => boolean | Promise<boolean>;
  clock?: Clock;
}

interface Pending {
  operationId: string;
  resolve: (value: OperationResult) => void;
  cleanup: () => void;
}

interface Connection {
  socket: WebSocket;
  id: string;
  device: DeviceRecord;
  capabilities: Set<DeviceCapability>;
  /** Announced by the client's upgrade request; old clients announce none. */
  features: DeviceFeature[];
  version?: string;
  /** Project directories the client's owner opened to file tools. */
  projectRoots?: string[];
  ready: boolean;
  alive: boolean;
  health: DeviceView["health"];
  pending: Map<string, Pending>;
}

/** Device transport only. No desktop or workspace implementation dependencies. */
export class DeviceGateway {
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_DEVICE_FRAME_BYTES, perMessageDeflate: false });
  private readonly connections = new Map<string, Connection>();
  private readonly clock: Clock;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly desktops = new Map<string, { connection: Connection; socket: WebSocket; close: () => void }>();
  private readonly servers: Server[] = [];

  private constructor(
    readonly registry: DeviceRegistry,
    private readonly operations: OperationStore,
    private readonly bindings: ResourceBindings,
    private readonly options: GatewayOptions,
  ) {
    this.clock = options.clock ?? systemClock();
    this.heartbeat = setInterval(() => {
      for (const connection of this.connections.values()) {
        if (!connection.alive) {
          connection.socket.terminate();
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
      }
    }, 15_000);
    this.heartbeat.unref();
  }

  static async open(options: GatewayOptions): Promise<DeviceGateway> {
    const clock = options.clock ?? systemClock();
    const registry = await DeviceRegistry.open(options.directory, clock);
    let operations: OperationStore | undefined;
    let bindings: ResourceBindings | undefined;
    try {
      operations = await OperationStore.open(options.directory, clock);
      bindings = await ResourceBindings.open(options.directory);
      return new DeviceGateway(registry, operations, bindings, { ...options, clock });
    } catch (error) {
      operations?.close();
      bindings?.close();
      await registry.close();
      throw error;
    }
  }

  /** Every listener (the proxied one and, optionally, the host-local one) serves the same devices. */
  attach(server: Server): void {
    if (this.servers.includes(server) || this.stopped) throw new Error("gateway_already_attached");
    this.servers.push(server);
    server.on("upgrade", this.upgrade);
  }

  /** Mount at /v1 on a dedicated API server. No cookies or browser-origin credentials are accepted. */
  async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    const reply = (status: number, value: unknown) => {
      response.statusCode = status;
      response.end(JSON.stringify(value));
    };
    if (this.stopped) {
      reply(503, { error: "gateway_unavailable" });
      return;
    }
    // This endpoint uses explicit bearer authentication, never ambient browser sessions.
    if (request.headers.origin) {
      reply(403, { error: "browser_origin_denied" });
      return;
    }
    try {
      const path = new URL(request.url ?? "/", "http://gateway").pathname;
      if (path === "/v1/enroll" && request.method === "POST") {
        reply(201, await this.registry.enroll(enrollmentSchema.parse(await readJson(request))));
        return;
      }
      if (path === "/v1/device/revoke" && request.method === "POST") {
        // A credential can only revoke itself; allowing an already revoked record makes recovery idempotent.
        const match = /^Device ([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(request.headers.authorization ?? "");
        const device = match && this.registry.authenticate(match[1]!, match[2]!, true);
        if (!device) {
          reply(401, { error: "unauthorized" });
          return;
        }
        await this.revoke(device.tenantId, device.deviceId);
        reply(200, { revoked: true });
        return;
      }
      const tenantId = await this.options.authenticate(request);
      if (!tenantId || !uuid.safeParse(tenantId).success) {
        reply(401, { error: "unauthorized" });
        return;
      }
      if (path === "/v1/pairings" && request.method === "POST") {
        reply(201, this.registry.createPairing(tenantId));
        return;
      }
      if (path === "/v1/devices" && request.method === "GET") {
        // Older runtime SDKs parse device records strictly, so features are returned only when asked for.
        reply(200, this.list(tenantId, new URL(request.url ?? "/", "http://gateway").searchParams.get("features") === "1"));
        return;
      }
      const match = /^\/v1\/devices\/([a-f0-9-]+)$/.exec(path);
      if (match && request.method === "DELETE") {
        reply((await this.revoke(tenantId, match[1]!)) ? 200 : 404, { revoked: true });
        return;
      }
      if (path === "/v1/invoke" && request.method === "POST") {
        const body = (await readJson(request, MAX_DEVICE_FILE_INPUT_BYTES)) as { deviceId?: unknown; invocation?: unknown };
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.on("close", abort);
        try {
          reply(200, await this.invoke(tenantId, uuid.parse(body.deviceId), deviceInvocationSchema.parse(body.invocation), controller.signal));
        } finally {
          response.off("close", abort);
        }
        return;
      }
      const status = /^\/v1\/devices\/([a-f0-9-]+)\/operations\/([a-f0-9-]+)$/.exec(path);
      if (status && request.method === "GET") {
        reply(200, await this.status(tenantId, uuid.parse(status[1]), uuid.parse(status[2])));
        return;
      }
      reply(404, { error: "not_found" });
    } catch {
      reply(400, { error: "invalid_device_request" });
    }
  }

  list(tenantId: string, features = false): DeviceView[] {
    return this.registry.list(tenantId).map((device) => {
      const connection = this.connections.get(device.deviceId);
      return {
        ...device,
        online: connection?.ready === true,
        ...(connection?.health ? { health: connection.health } : {}),
        ...(features && connection?.ready ? { features: [...connection.features] } : {}),
        // Asked for together with the features: older runtime SDKs reject unknown record fields.
        ...(features && connection?.ready && connection.version ? { version: connection.version } : {}),
        ...(features && connection?.ready && connection.projectRoots ? { projectRoots: [...connection.projectRoots] } : {}),
      };
    });
  }

  async revoke(tenantId: string, deviceId: string): Promise<boolean> {
    const revoked = await this.registry.revoke(tenantId, deviceId);
    if (revoked) this.connections.get(deviceId)?.socket.close(4003, "revoked");
    return revoked;
  }

  async invoke(tenantId: string, deviceId: string, input: DeviceInvocation, signal?: AbortSignal): Promise<OperationResult> {
    const invocation = deviceInvocationSchema.parse(input);
    const maxInput = deviceInputLimit(invocation);
    if (Buffer.byteLength(JSON.stringify(invocation)) > maxInput) return rejected("input_too_large");
    const device = this.registry.get(tenantId, deviceId);
    if (!device || device.revokedAt !== undefined || invocation.conversation.tenantId !== tenantId) return rejected("device_denied");
    if (!(await this.options.authorize(invocation, device))) return rejected("policy_denied");
    if (this.stopped || signal?.aborted) return rejected("cancelled");
    // Re-check after the async policy hook: revocation and reconnect may have happened meanwhile.
    if (this.registry.get(tenantId, deviceId)?.revokedAt !== undefined) return rejected("device_denied");
    if (isScreenViewRead(invocation)) return this.view(tenantId, deviceId, invocation, signal);
    if ([...this.desktops.values()].some((desktop) => desktop.connection.device.deviceId === deviceId)) return rejected("computer_user_controlled");
    let claim;
    try {
      this.bindings.bind(operationKey(tenantId, deviceId, invocation.operationId), deviceId);
      claim = this.operations.claim(operationKey(tenantId, deviceId, invocation.operationId), { deviceId, ...operationIdentity(invocation) });
    } catch {
      return rejected("operation_id_conflict");
    }
    if (!claim.created)
      return claim.operation.result === undefined
        ? this.status(tenantId, deviceId, invocation.operationId)
        : operationResultSchema.parse(claim.operation.result);
    if (invocation.expiresAt <= this.clock.now() || invocation.expiresAt > this.clock.now() + 10 * 60_000)
      return this.finish(tenantId, deviceId, invocation.operationId, rejected("invalid_deadline"));
    const connection = this.connections.get(deviceId);
    if (!connection?.ready || !connection.capabilities.has(invocation.capability))
      return this.finish(tenantId, deviceId, invocation.operationId, rejected("device_unavailable"));
    const result = await this.request(connection, { type: "invoke", invocation }, invocation.operationId, invocation.expiresAt, signal);
    return this.finish(tenantId, deviceId, invocation.operationId, result);
  }

  /** Screen-view reads skip the durable journal and bindings: no side effect to deduplicate, and a
   * stored screenshot per capture would grow without bound. Old clients would still journal them, so
   * they never receive one. */
  private async view(tenantId: string, deviceId: string, invocation: DeviceInvocation, signal?: AbortSignal): Promise<OperationResult> {
    if (invocation.expiresAt <= this.clock.now() || invocation.expiresAt > this.clock.now() + 10 * 60_000) return rejected("invalid_deadline");
    const connection = this.connections.get(deviceId);
    if (!connection?.ready || !connection.capabilities.has(invocation.capability)) return rejected("device_unavailable");
    if (!connection.features.includes(invocation.capability === "computer.browser" ? "browser-view" : "screen-view")) return rejected("client_update_required");
    // Never share an ID with a journaled operation: the device cancels by operation ID.
    if (this.operations.get(operationKey(tenantId, deviceId, invocation.operationId))) return rejected("operation_id_conflict");
    return this.request(connection, { type: "invoke", invocation }, invocation.operationId, invocation.expiresAt, signal);
  }

  async status(tenantId: string, deviceId: string, operationId: string): Promise<OperationResult> {
    const device = this.registry.get(tenantId, deviceId);
    if (!device || device.revokedAt !== undefined || this.stopped) return rejected("device_denied");
    if (!this.bindings.allows(operationKey(tenantId, deviceId, operationId), deviceId)) return unknown("operation_not_seen_on_device");
    const stored = this.operations.get(operationKey(tenantId, deviceId, operationId));
    if (!stored) return unknown("operation_not_seen");
    if (stored.result !== undefined) return operationResultSchema.parse(stored.result);
    const connection = this.connections.get(deviceId);
    if (!connection?.ready) return unknown("device_offline");
    return this.finish(
      tenantId,
      deviceId,
      operationId,
      await this.request(connection, { type: "status", operationId }, operationId, this.clock.now() + 15_000),
    );
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeat);
    for (const server of this.servers) server.off("upgrade", this.upgrade);
    for (const connection of this.connections.values()) {
      this.disconnect(connection);
      connection.socket.terminate();
    }
    this.sockets.close();
    // Pending invoke continuations must finish before their journal closes.
    await Promise.resolve();
    await Promise.resolve();
    this.operations.close();
    this.bindings.close();
    await this.registry.close();
  }

  private finish(tenant: string, device: string, id: string, result: OperationResult): OperationResult {
    if (!this.stopped && result.status !== "unknown") this.operations.finish(operationKey(tenant, device, id), result);
    return result;
  }

  private request(
    connection: Connection,
    payload: { type: "invoke"; invocation: DeviceInvocation } | { type: "status"; operationId: string },
    operationId: string,
    expiresAt: number,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    if (connection.pending.size >= 128) return Promise.resolve(unknown("device_busy"));
    return new Promise((resolve) => {
      const requestId = newId();
      const settle = (result: OperationResult) => {
        const pending = connection.pending.get(requestId);
        if (!pending) return;
        connection.pending.delete(requestId);
        pending.cleanup();
        resolve(result);
      };
      const cancel = () => {
        send(connection.socket, { type: "cancel", connectionId: connection.id, operationId });
        settle(unknown(signal?.aborted ? "cancelled" : "deadline_exceeded"));
      };
      const timer = setTimeout(cancel, Math.max(1, expiresAt - this.clock.now()));
      timer.unref();
      connection.pending.set(requestId, {
        operationId,
        resolve: settle,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      if (!send(connection.socket, { ...payload, requestId, connectionId: connection.id })) settle(unknown("connection_lost"));
    });
  }

  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const deny = () => {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    };
    if (request.url?.startsWith("/v1/desktop/")) {
      void this.desktopUpgrade(request, socket, head).catch(deny);
      return;
    }
    try {
      if (this.stopped || request.url !== "/v1/connect" || request.headers.origin) return deny();
      const match = /^Device ([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(request.headers.authorization ?? "");
      const device = match && this.registry.authenticate(match[1]!, match[2]!);
      if (!device || this.connections.has(device.deviceId)) return deny();
      const features = parseDeviceFeatures(request.headers[DEVICE_FEATURES_HEADER]);
      const version = parseDeviceVersion(request.headers[DEVICE_VERSION_HEADER]);
      const projectRoots = parseDeviceRoots(request.headers[DEVICE_ROOTS_HEADER]);
      this.sockets.handleUpgrade(request, socket, head, (ws) => this.connected(ws, device, features, version, projectRoots));
    } catch {
      deny();
    }
  };

  private async desktopUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const deviceId = /^\/v1\/desktop\/([a-f0-9-]{36})$/.exec(request.url ?? "")?.[1];
    const encoded = request.headers["x-yesimbot-desktop-invocation"];
    if (this.stopped || request.headers.origin || !deviceId || typeof encoded !== "string" || encoded.length > 8192) throw Error("desktop_denied");
    const tenant = await this.options.authenticate(request);
    const device = tenant && this.registry.get(tenant, deviceId);
    const connection = this.connections.get(deviceId);
    const invocation = deviceInvocationSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString()));
    if (
      !device ||
      device.revokedAt !== undefined ||
      !connection?.ready ||
      !connection.features.includes("desktop-stream") ||
      !connection.capabilities.has("computer.desktop") ||
      connection.health?.["computer.desktop"] === false ||
      connection.pending.size ||
      !isDesktopStream(invocation) ||
      invocation.conversation.tenantId !== tenant ||
      invocation.expiresAt <= this.clock.now() ||
      invocation.expiresAt > this.clock.now() + 30_000 ||
      [...this.desktops.values()].some((d) => d.connection === connection) ||
      !(await this.options.authorize(invocation, device))
    )
      throw Error("desktop_denied");
    if (
      this.stopped ||
      this.connections.get(deviceId) !== connection ||
      this.registry.get(tenant!, deviceId)?.revokedAt !== undefined ||
      connection.pending.size ||
      invocation.expiresAt <= this.clock.now() ||
      socket.destroyed ||
      [...this.desktops.values()].some((d) => d.connection === connection)
    )
      throw Error("desktop_denied");
    this.sockets.handleUpgrade(request, socket, head, (ws) => {
      const streamId = newId();
      const close = () => {
        if (!this.desktops.delete(streamId)) return;
        clearTimeout(lifetime);
        clearInterval(authorization);
        ws.close(1000);
        send(connection.socket, { type: "desktop-close", connectionId: connection.id, streamId });
      };
      const lifetime = setTimeout(close, 10 * 60_000);
      lifetime.unref();
      let checking = false;
      const authorization = setInterval(() => {
        if (checking) return;
        checking = true;
        void this.options
          .authenticate(request)
          .then(async (current) => {
            if (
              current !== tenant ||
              this.stopped ||
              this.connections.get(deviceId) !== connection ||
              this.registry.get(tenant!, deviceId)?.revokedAt !== undefined ||
              !(await this.options.authorize(invocation, device))
            )
              close();
          })
          .catch(close)
          .finally(() => {
            checking = false;
          });
      }, 1000);
      authorization.unref();
      this.desktops.set(streamId, { connection, socket: ws, close });
      ws.on("error", close);
      ws.on("close", close);
      ws.on("message", (data, binary) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (!binary || bytes.length > DESKTOP_CHUNK_BYTES || connection.socket.bufferedAmount > 1024 * 1024) return close();
        if (!send(connection.socket, { type: "desktop-data", connectionId: connection.id, streamId, data: bytes.toString("base64") })) close();
      });
      if (!send(connection.socket, { type: "desktop-open", connectionId: connection.id, streamId, invocation })) close();
    });
  }

  private connected(socket: WebSocket, device: DeviceRecord, features: DeviceFeature[], version?: string, projectRoots?: string[]): void {
    const connection: Connection = {
      socket,
      id: newId(),
      device,
      capabilities: new Set(),
      features,
      ...(version ? { version } : {}),
      ...(projectRoots ? { projectRoots } : {}),
      ready: false,
      alive: true,
      health: {},
      pending: new Map(),
    };
    this.connections.set(device.deviceId, connection);
    const timer = setTimeout(() => {
      if (!connection.ready) socket.terminate();
    }, 5000);
    timer.unref();
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(timer);
      this.disconnect(connection);
    });
    socket.on("message", (data, binary) => {
      try {
        if (binary || this.connections.get(device.deviceId) !== connection) throw new Error("invalid_frame");
        const frame = parseDeviceFrame(data.toString(), clientFrameSchema);
        if (!connection.ready) {
          if (
            frame.type !== "hello" ||
            frame.deviceId !== device.deviceId ||
            frame.capabilities.some((capability) => !device.capabilities.includes(capability))
          )
            throw new Error("invalid_hello");
          connection.ready = true;
          connection.capabilities = new Set(frame.capabilities);
          clearTimeout(timer);
          send(socket, { type: "welcome", version: 1, connectionId: connection.id, device });
          return;
        }
        if (frame.type === "hello" || frame.connectionId !== connection.id) throw new Error("stale_connection");
        if (frame.type === "desktop-data" || frame.type === "desktop-close") {
          const desktop = this.desktops.get(frame.streamId);
          if (!desktop || desktop.connection !== connection) return;
          if (frame.type === "desktop-close") return desktop.close();
          const bytes = Buffer.from(frame.data, "base64");
          if (bytes.length > DESKTOP_CHUNK_BYTES || bytes.toString("base64") !== frame.data || desktop.socket.bufferedAmount > 4 * 1024 * 1024)
            return desktop.close();
          desktop.socket.send(bytes, { binary: true });
        } else if (frame.type === "health") {
          if (Object.keys(frame.health).some((capability) => !connection.capabilities.has(capability as DeviceCapability))) throw new Error("invalid_health");
          connection.health = frame.health;
        } else {
          const pending = connection.pending.get(frame.requestId);
          if (pending?.operationId === frame.operationId) pending.resolve(frame.result);
        }
      } catch {
        socket.close(1008, "invalid_device_frame");
      }
    });
  }

  private disconnect(connection: Connection): void {
    for (const desktop of this.desktops.values()) if (desktop.connection === connection) desktop.close();
    if (this.connections.get(connection.device.deviceId) === connection) this.connections.delete(connection.device.deviceId);
    connection.ready = false;
    for (const pending of [...connection.pending.values()]) pending.resolve(unknown("connection_lost"));
  }
}

function operationKey(tenant: string, _device: string, operation: string): string {
  return JSON.stringify([tenant, operation]);
}

function rejected(code: string): OperationResult {
  return { status: "rejected", code };
}

function unknown(code: string): OperationResult {
  return { status: "unknown", code };
}

function send(socket: WebSocket, frame: DeviceServerFrame): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
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

async function readJson(request: IncomingMessage, maxBytes = MAX_DEVICE_INPUT_BYTES): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("json_required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function operationIdentity({ expiresAt: _deadline, ...operation }: DeviceInvocation) {
  return operation;
}

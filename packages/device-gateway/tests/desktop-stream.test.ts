import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DeviceInvocation, type ToolPolicy } from "@yesimbot/contracts";
import { OperationStore } from "@yesimbot/device-store";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { DeviceClient } from "../../device-client/src/client.js";
import { GatewayClient } from "../src/client.js";
import { DeviceGateway } from "../src/gateway.js";

const tenant = "11111111-1111-4111-8111-111111111111",
  token = "b".repeat(64);
const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of clean.splice(0).reverse()) await step();
});
function invocation(): DeviceInvocation {
  return {
    operationId: randomUUID(),
    capability: "computer.desktop",
    method: "remote",
    input: {},
    actors: [],
    conversation: { tenantId: tenant, botId: "webui", platform: "yesimbot-viewer", kind: "direct", conversationId: "control" },
    expiresAt: Date.now() + 10_000,
  };
}

async function fixture(allowed = true, optedIn = true) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-stream-"));
  clean.push(() => rm(directory, { force: true, recursive: true }));
  let native: Socket | undefined;
  let tcpBytes = Buffer.alloc(0);
  const tcp = createTcpServer((socket) => {
    native = socket;
    socket.write("RFB 003.008\n");
    socket.on("data", (data) => {
      tcpBytes = Buffer.concat([tcpBytes, data]);
    });
  });
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  clean.push(() => {
    native?.destroy();
    return new Promise<void>((resolve) => tcp.close(() => resolve()));
  });
  let authorized = true;
  const gateway = await DeviceGateway.open({
    directory: join(directory, "gateway"),
    authenticate: async (req) => (authorized && req.headers.authorization === `Bearer ${token}` ? tenant : undefined),
    authorize: () => true,
  });
  const server = createServer((req, res) => void gateway.handleHttp(req, res));
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  clean.push(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const gatewayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { credential } = await gateway.registry.enroll({
    code: gateway.registry.createPairing(tenant).code,
    name: "Computer",
    platform: "linux",
    capabilities: ["computer.desktop"],
  });
  const policy: ToolPolicy = { version: 1, direct: { enabled: allowed, tools: ["*"] }, group: { enabled: false, tools: [] }, actors: [] };
  const clientDirectory = join(directory, "client");
  const execute = vi.fn(async () => ({ status: "succeeded" as const, output: {} }));
  const client = await DeviceClient.open({
    directory: clientDirectory,
    gateway: gatewayUrl,
    allowLoopback: true,
    credential,
    policy,
    desktopPort: optedIn ? (tcp.address() as { port: number }).port : undefined,
    drivers: [{ capability: "computer.desktop", methods: { ui: { contexts: ["direct"], execute } } }],
    reconnectMs: 20,
  });
  clean.push(() => client.close());
  client.start();
  await vi.waitFor(() => expect(client.online).toBe(true));
  const sdk = new GatewayClient({ gateway: gatewayUrl, allowLoopback: true, tenantId: tenant, token });
  return {
    gateway,
    gatewayUrl,
    sdk,
    client,
    clientDirectory,
    credential,
    execute,
    revokeRuntime: () => {
      authorized = false;
    },
    native: () => native,
    tcpBytes: () => tcpBytes,
  };
}
it("carries an RFB handshake and binary keyboard/pointer bytes both ways without operation journals", async () => {
  const f = await fixture(),
    request = invocation();
  let bytes = Buffer.alloc(0);
  const closed = vi.fn(),
    controller = new AbortController();
  const tunnel = await f.sdk.openDesktop(
    f.credential.deviceId,
    request,
    {
      data: (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
      },
      close: closed,
    },
    controller.signal,
  );
  await vi.waitFor(() => expect(bytes.toString()).toBe("RFB 003.008\n"));
  tunnel.send(Buffer.from("RFB 003.008\n"));
  await vi.waitFor(() => expect(f.tcpBytes().toString()).toBe("RFB 003.008\n"));
  f.native()!.write(Buffer.from([1, 1]));
  await vi.waitFor(() => expect(bytes.subarray(12)).toEqual(Buffer.from([1, 1])));
  tunnel.send(Buffer.from([1]));
  await vi.waitFor(() => expect(f.tcpBytes().length).toBe(13));
  f.native()!.write(Buffer.alloc(4));
  await vi.waitFor(() => expect(bytes.length).toBe(18));
  tunnel.send(Buffer.from([1]));
  // ServerInit and then real RFB key and pointer frames, including Unicode and held drag.
  const serverInit = Buffer.alloc(24);
  serverInit.writeUInt16BE(1600, 0);
  serverInit.writeUInt16BE(1000, 2);
  serverInit[4] = 32;
  serverInit[5] = 24;
  serverInit[7] = 1;
  f.native()!.write(serverInit);
  const input = Buffer.from([4, 1, 0, 0, 1, 0, 0x4e, 0x2d, 6, 1, 0, 10, 0, 20, 6, 1, 0, 30, 0, 40, 6, 0, 0, 30, 0, 40]);
  tunnel.send(input);
  await vi.waitFor(() => expect(f.tcpBytes().subarray(14)).toEqual(input));
  expect(f.execute).not.toHaveBeenCalled();
  const bot = { ...request, operationId: randomUUID(), method: "ui", input: { tool: "press", args: { combo: "Return" } } };
  expect(await f.sdk.invoke(f.credential.deviceId, bot)).toMatchObject({ status: "rejected", code: "computer_user_controlled" });
  const second = new AbortController();
  await expect(f.sdk.openDesktop(f.credential.deviceId, invocation(), { data() {}, close() {} }, second.signal)).rejects.toThrow();
  tunnel.close();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  await f.client.close();
  const store = await OperationStore.open(f.clientDirectory);
  try {
    expect(store.get(request.operationId)).toBeUndefined();
  } finally {
    store.close();
  }
});
it("rejects foreign tenants, non-viewer scope, browser-origin access and clients without opt-in", async () => {
  const f = await fixture(true, false);
  expect((await f.sdk.list())[0].features).not.toContain("desktop-stream");
  await expect(f.sdk.openDesktop(f.credential.deviceId, invocation(), { data() {}, close() {} }, new AbortController().signal)).rejects.toThrow();
  const active = await fixture();
  const denied = async (request: DeviceInvocation, origin?: string) => {
    const socket = new WebSocket(active.gatewayUrl.replace("http:", "ws:") + `/v1/desktop/${active.credential.deviceId}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-yesimbot-desktop-invocation": Buffer.from(JSON.stringify(request)).toString("base64url"),
        ...(origin ? { origin } : {}),
      },
    });
    await new Promise<void>((resolve) => {
      socket.on("error", () => {});
      socket.once("close", () => resolve());
    });
  };
  await denied({ ...invocation(), conversation: { ...invocation().conversation, tenantId: randomUUID() } });
  await denied(invocation(), "https://foreign.example");
  expect(f.native()).toBeUndefined();
  expect(active.native()).toBeUndefined();
});
it("enforces local policy and closes an active stream on device disconnect without replay", async () => {
  const denied = await fixture(false);
  const deniedClose = vi.fn();
  await denied.sdk.openDesktop(denied.credential.deviceId, invocation(), { data() {}, close: deniedClose }, new AbortController().signal);
  await vi.waitFor(() => expect(deniedClose).toHaveBeenCalled());
  expect(denied.native()).toBeUndefined();
  const f = await fixture();
  const closed = vi.fn();
  await f.sdk.openDesktop(f.credential.deviceId, invocation(), { data() {}, close: closed }, new AbortController().signal);
  await vi.waitFor(() => expect(f.native()).toBeDefined());
  f.client.disconnect();
  await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(f.native()?.destroyed).toBe(true));
  expect(f.tcpBytes().length).toBe(0);
});

it("closes active desktop sessions when the runtime credential is revoked", async () => {
  const f = await fixture(),
    close = vi.fn();
  await f.sdk.openDesktop(f.credential.deviceId, invocation(), { data() {}, close }, new AbortController().signal);
  await vi.waitFor(() => expect(f.native()).toBeDefined());
  f.revokeRuntime();
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1), { timeout: 2500 });
  await vi.waitFor(() => expect(f.native()?.destroyed).toBe(true));
});

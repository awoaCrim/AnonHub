import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_FEATURES_HEADER,
  denyToolPolicy,
  SCREEN_VIEW_PLATFORM,
  type DeviceCapability,
  type DeviceInvocation,
  type OperationResult,
  type ToolPolicy,
} from "@yesimbot/contracts";
import { OperationStore } from "@yesimbot/device-store";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { Devices, RuntimeIdentity } from "../../../core/src/devices.js";
import { DeviceClient } from "../../device-client/src/client.js";
import type { DeviceDriver } from "../../device-client/src/driver.js";
import { GatewayClient } from "../src/client.js";
import { DeviceGateway } from "../src/gateway.js";

const tenant = "11111111-1111-4111-8111-111111111111",
  token = "b".repeat(64);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const policy: ToolPolicy = { ...denyToolPolicy(), direct: { enabled: true, tools: ["computer.desktop.execute"] } };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "screen-view-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const gateway = await DeviceGateway.open({
    directory: join(directory, "gateway"),
    authenticate: async (req) => (req.headers.authorization === `Bearer ${token}` ? tenant : undefined),
    authorize: () => true,
  });
  const server: Server = createServer((req, res) => void gateway.handleHttp(req, res));
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const enroll = async (capabilities: DeviceCapability[] = ["computer.desktop"]) => {
    const { credential } = await gateway.registry.enroll({
      code: gateway.registry.createPairing(tenant).code,
      name: "Computer",
      platform: "linux",
      capabilities,
    });
    return credential;
  };
  const devices = new Devices(new RuntimeIdentity(join(directory, "runtime"), tenant));
  const remote = new GatewayClient({ gateway: url, token, tenantId: tenant, allowLoopback: true });
  devices.use(remote);
  return { directory, gateway, url, enroll, devices, remote };
}

it("keeps screen-view captures out of both the gateway and the client journals, and still journals bot operations", async () => {
  const f = await fixture();
  const credential = await f.enroll();
  const seen: DeviceInvocation[] = [];
  const execute = vi.fn(async (invocation: DeviceInvocation): Promise<OperationResult> => {
    seen.push(invocation);
    return { status: "succeeded", output: { data: png, mediaType: "image/png" } };
  });
  const driver: DeviceDriver = { capability: "computer.desktop", methods: { execute: { contexts: ["direct"], execute } } };
  const clientDirectory = join(f.directory, "client");
  const client = await DeviceClient.open({
    gateway: f.url,
    credential,
    directory: clientDirectory,
    drivers: [driver],
    policy,
    allowLoopback: true,
    reconnectMs: 100,
  });
  let open = true;
  cleanup.push(async () => {
    if (open) await client.close();
  });
  client.start();
  await vi.waitFor(() => expect(client.online).toBe(true));

  expect(await f.devices.list()).toEqual([
    expect.objectContaining({
      deviceId: credential.deviceId,
      online: true,
      features: ["screen-view", "auto-update", "file-upload-8m", "browser-view", "browser-control", "shell-jobs", "project-files", "browser-input"],
    }),
  ]);
  for (let i = 0; i < 3; i++) expect(await f.devices.captureScreen(credential.deviceId, new AbortController().signal)).toMatchObject({ status: "succeeded" });
  expect(execute).toHaveBeenCalledTimes(3);
  const views = seen.map(({ operationId }) => operationId);
  for (const operationId of views)
    expect(await f.gateway.status(tenant, credential.deviceId, operationId)).toEqual({ status: "unknown", code: "operation_not_seen_on_device" });

  // A desktop call that is not the exact viewer read keeps its exactly-once journal entry.
  const bot: DeviceInvocation = {
    operationId: randomUUID(),
    capability: "computer.desktop",
    method: "execute",
    input: { actions: [{ type: "screenshot" }] },
    conversation: { tenantId: tenant, botId: "bot", platform: "onebot", kind: "direct", conversationId: "private:owner" },
    actors: [],
    expiresAt: Date.now() + 10_000,
  };
  expect(await f.remote.invoke(credential.deviceId, bot)).toMatchObject({ status: "succeeded" });
  expect(await f.gateway.status(tenant, credential.deviceId, bot.operationId)).toMatchObject({ status: "succeeded" });

  open = false;
  await client.close();
  const store = await OperationStore.open(clientDirectory);
  try {
    for (const operationId of views) expect(store.get(operationId)).toBeUndefined();
    expect(store.get(bot.operationId)?.result).toMatchObject({ status: "succeeded" });
  } finally {
    store.close();
  }
});

it("never sends a screen-view read to an older client, and returns features only to runtimes that ask", async () => {
  const f = await fixture();
  const credential = await f.enroll();
  // An older client: same hello, no feature header.
  const socket = new WebSocket(f.url.replace("http:", "ws:") + "/v1/connect", {
    headers: { Authorization: `Device ${credential.deviceId}:${credential.secret}` },
  });
  const frames: Array<{ type: string }> = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  cleanup.push(async () => socket.terminate());
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "hello", version: 1, deviceId: credential.deviceId, capabilities: ["computer.desktop"] }));
  await vi.waitFor(() => expect(frames.map((frame) => frame.type)).toEqual(["welcome"]));

  expect(await f.devices.list()).toEqual([expect.objectContaining({ online: true, features: [] })]);
  expect(await f.devices.captureScreen(credential.deviceId, new AbortController().signal)).toEqual({
    status: "rejected",
    code: "client_update_required",
  });
  expect(frames.map((frame) => frame.type)).toEqual(["welcome"]);

  // Older runtime SDKs parse records strictly: without the query there is no extra field.
  const plain = await fetch(f.url + "/v1/devices", { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
  expect(plain).toEqual([expect.not.objectContaining({ features: expect.anything() })]);
});

it("keeps the bot browser's view out of both journals, and never asks a client without browser-view", async () => {
  const f = await fixture();
  const credential = await f.enroll(["computer.desktop", "computer.browser"]);
  const seen: DeviceInvocation[] = [];
  const execute = vi.fn(async (invocation: DeviceInvocation): Promise<OperationResult> => {
    seen.push(invocation);
    return { status: "succeeded", output: { data: "/9j/AAAA", mediaType: "image/jpeg" } };
  });
  const driver: DeviceDriver = { capability: "computer.browser", methods: { execute: { contexts: ["direct"], execute } } };
  const clientDirectory = join(f.directory, "client");
  const client = await DeviceClient.open({
    gateway: f.url,
    credential,
    directory: clientDirectory,
    drivers: [driver],
    policy: { ...denyToolPolicy(), direct: { enabled: true, tools: ["computer.browser.execute"] } },
    allowLoopback: true,
    reconnectMs: 100,
  });
  let open = true;
  cleanup.push(async () => {
    if (open) await client.close();
  });
  client.start();
  await vi.waitFor(() => expect(client.online).toBe(true));

  expect(await f.devices.captureScreen(credential.deviceId, new AbortController().signal, "browser")).toMatchObject({ status: "succeeded" });
  expect(seen).toEqual([
    expect.objectContaining({
      capability: "computer.browser",
      method: "execute",
      input: { action: "view" },
      actors: [],
      conversation: expect.objectContaining({ platform: SCREEN_VIEW_PLATFORM }),
    }),
  ]);
  const operationId = seen[0].operationId;
  expect(await f.gateway.status(tenant, credential.deviceId, operationId)).toEqual({ status: "unknown", code: "operation_not_seen_on_device" });
  open = false;
  await client.close();
  const store = await OperationStore.open(clientDirectory);
  try {
    expect(store.get(operationId)).toBeUndefined();
  } finally {
    store.close();
  }

  // A client that shows the screen but predates the browser view never gets the browser read.
  const older = await f.enroll(["computer.desktop", "computer.browser"]);
  const socket = new WebSocket(f.url.replace("http:", "ws:") + "/v1/connect", {
    headers: { Authorization: `Device ${older.deviceId}:${older.secret}`, [DEVICE_FEATURES_HEADER]: "screen-view" },
  });
  const frames: Array<{ type: string }> = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  cleanup.push(async () => socket.terminate());
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "hello", version: 1, deviceId: older.deviceId, capabilities: ["computer.desktop", "computer.browser"] }));
  await vi.waitFor(() => expect(frames.map((frame) => frame.type)).toEqual(["welcome"]));
  expect(await f.devices.captureScreen(older.deviceId, new AbortController().signal, "browser")).toEqual({
    status: "rejected",
    code: "client_update_required",
  });
  expect(frames.map((frame) => frame.type)).toEqual(["welcome"]);
});

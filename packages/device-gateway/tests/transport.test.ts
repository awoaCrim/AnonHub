import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeviceInvocation, ToolPolicy } from "@yesimbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalFilesDriver } from "../../device-client/src/drivers/files.js";
import { DeviceClient, type DeviceDriver } from "../../device-client/src/index.js";
import { DeviceGateway } from "../src/gateway.js";

const tenant = "11111111-1111-4111-8111-111111111111",
  foreign = "22222222-2222-4222-8222-222222222222";
const policy: ToolPolicy = {
  version: 1,
  direct: { enabled: true, tools: ["computer.shell.exec"] },
  group: { enabled: false, tools: [] },
  actors: [{ kind: "direct", platform: "wechat", conversationId: "crimson", userId: "crimson", botId: "anon" }],
};
const directories: string[] = [],
  clients: DeviceClient[] = [],
  gateways: DeviceGateway[] = [],
  servers: Server[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "device-transport-"));
  directories.push(directory);
  const gateway = await DeviceGateway.open({
    directory: join(directory, "gateway"),
    authenticate: async (req) => (req.headers.authorization === "Bearer runtime-a" ? tenant : undefined),
    authorize: (invocation) => invocation.actors.every((actor) => actor.platform === "wechat" && actor.userId === "crimson"),
  });
  gateways.push(gateway);
  const server = createServer((req, res) => void gateway.handleHttp(req, res));
  servers.push(server);
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const enroll = async (tenantId: string, drivers: DeviceDriver[], clientPolicy = policy) => {
    const pair = gateway.registry.createPairing(tenantId);
    const { credential } = await gateway.registry.enroll({
      code: pair.code,
      name: "Computer",
      platform: "linux",
      capabilities: drivers.map((d) => d.capability),
    });
    const clientDirectory = join(directory, credential.deviceId);
    const options = { gateway: url, credential, directory: clientDirectory, drivers, policy: clientPolicy, allowLoopback: true, reconnectMs: 100 };
    const client = await DeviceClient.open(options);
    clients.push(client);
    client.start();
    await vi.waitFor(() => expect(client.online).toBe(true));
    return { client, credential, options };
  };
  return { directory, gateway, url, enroll };
}

function invocation(overrides: Partial<DeviceInvocation> = {}): DeviceInvocation {
  return {
    operationId: randomUUID(),
    capability: "computer.shell",
    method: "exec",
    expiresAt: Date.now() + 30_000,
    conversation: { tenantId: tenant, botId: "anon", platform: "wechat", kind: "direct", conversationId: "crimson" },
    actors: [{ platform: "wechat", userId: "crimson" }],
    input: { command: "example" },
    ...overrides,
  };
}

function driver(execute = vi.fn(async () => ({ status: "succeeded" as const, output: "done" }))): DeviceDriver {
  return { capability: "computer.shell", methods: { exec: { contexts: ["direct", "group"], execute } } };
}

describe("real WebSocket device transport", () => {
  it("routes to the exact tenant-owned device, denies cross-tenant/group/actor requests, and never falls back", async () => {
    const { gateway, enroll } = await fixture();
    const callA = vi.fn(async () => ({ status: "succeeded" as const, output: "A" })),
      callB = vi.fn(async () => ({ status: "succeeded" as const, output: "B" }));
    const a = await enroll(tenant, [driver(callA)]),
      b = await enroll(foreign, [driver(callB)]);
    expect(await gateway.invoke(tenant, b.credential.deviceId, invocation())).toMatchObject({ status: "rejected" });
    expect(await gateway.invoke(tenant, randomUUID(), invocation())).toMatchObject({ status: "rejected" });
    const group = invocation();
    group.conversation.kind = "group";
    expect(await gateway.invoke(tenant, a.credential.deviceId, group)).toMatchObject({ status: "rejected", code: "policy_denied" });
    expect(await gateway.invoke(tenant, a.credential.deviceId, invocation({ actors: [{ platform: "wechat", userId: "someone" }] }))).toMatchObject({
      status: "rejected",
    });
    const request = invocation();
    expect(await gateway.invoke(tenant, a.credential.deviceId, request)).toEqual({ status: "succeeded", output: "A" });
    expect(await gateway.invoke(tenant, a.credential.deviceId, request)).toEqual({ status: "succeeded", output: "A" });
    expect(await gateway.invoke(tenant, a.credential.deviceId, { ...request, input: { command: "changed" } })).toMatchObject({
      status: "rejected",
      code: "operation_id_conflict",
    });
    expect(callA).toHaveBeenCalledTimes(1);
    expect(callB).not.toHaveBeenCalled();
  });

  it("recovers a lost result by querying the durable journal, including after a client restart", async () => {
    const { gateway, enroll } = await fixture();
    let finish!: () => void;
    const executed = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: "succeeded" as const, output: "sent once" };
    });
    const a = await enroll(tenant, [driver(executed)]);
    const request = invocation(),
      result = gateway.invoke(tenant, a.credential.deviceId, request);
    await vi.waitFor(() => expect(executed).toHaveBeenCalledTimes(1));
    a.client.disconnect();
    expect(await result).toMatchObject({ status: "unknown" });
    await vi.waitFor(() => expect(a.client.online).toBe(false));
    finish();
    await vi.waitFor(() => expect(a.client.online).toBe(true));
    expect(await gateway.invoke(tenant, a.credential.deviceId, request)).toEqual({ status: "succeeded", output: "sent once" });
    await a.client.close();
    clients.splice(clients.indexOf(a.client), 1);
    await vi.waitFor(() => expect(gateway.list(tenant)[0]?.online).toBe(false));
    const restarted = await DeviceClient.open(a.options);
    clients.push(restarted);
    restarted.start();
    await vi.waitFor(() => expect(restarted.online).toBe(true));
    expect(await gateway.invoke(tenant, a.credential.deviceId, request)).toEqual({ status: "succeeded", output: "sent once" });
    expect(executed).toHaveBeenCalledTimes(1);
  });

  it("keeps interrupted native effects unknown and never executes them a second time", async () => {
    const { gateway, enroll } = await fixture();
    const execute = vi.fn(async () => {
      throw new Error("native process lost after send");
    });
    const a = await enroll(tenant, [driver(execute)]),
      request = invocation();
    expect(await gateway.invoke(tenant, a.credential.deviceId, request)).toMatchObject({ status: "unknown" });
    expect(await gateway.invoke(tenant, a.credential.deviceId, request)).toMatchObject({ status: "unknown" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("revokes a connected device and denies further commands", async () => {
    const { gateway, enroll } = await fixture();
    const execute = vi.fn();
    const a = await enroll(tenant, [driver(execute)]);
    expect(await gateway.revoke(foreign, a.credential.deviceId)).toBe(false);
    expect(await gateway.revoke(tenant, a.credential.deviceId)).toBe(true);
    await vi.waitFor(() => expect(a.client.online).toBe(false));
    expect(await gateway.invoke(tenant, a.credential.deviceId, invocation())).toMatchObject({ status: "rejected" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires trusted runtime credentials and rejects browser-origin management requests", async () => {
    const { url } = await fixture();
    expect((await fetch(url + "/v1/devices")).status).toBe(401);
    expect((await fetch(url + "/v1/devices", { headers: { Authorization: "Bearer runtime-a", Origin: "https://evil.test" } })).status).toBe(403);
    const response = await fetch(url + "/v1/pairings", { method: "POST", headers: { Authorization: "Bearer runtime-a" } });
    expect(response.status).toBe(201);
    const { code } = (await response.json()) as { code: string };
    const enrollment = await fetch(url + "/v1/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "Test device", platform: "win32", capabilities: [] }),
    });
    expect(enrollment.status).toBe(201);
    expect(((await enrollment.json()) as { device: { tenantId: string } }).device.tenantId).toBe(tenant);
  });

  it("allows idempotent device self-revocation without granting access to another device or management API", async () => {
    const { url, gateway, enroll } = await fixture();
    const a = await enroll(tenant, [driver()]),
      b = await enroll(foreign, [driver()]);
    const headers = { authorization: `Device ${a.credential.deviceId}:${a.credential.secret}`, "content-type": "application/json" };
    expect((await fetch(url + "/v1/devices", { headers })).status).toBe(401);
    expect(
      (await fetch(url + "/v1/device/revoke", { method: "POST", headers: { authorization: `Device ${a.credential.deviceId}:${"0".repeat(64)}` } })).status,
    ).toBe(401);
    expect((await fetch(url + "/v1/device/revoke", { method: "POST", headers: { ...headers, origin: "http://localhost" } })).status).toBe(403);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await fetch(url + "/v1/device/revoke", { method: "POST", headers, body: JSON.stringify({ deviceId: b.credential.deviceId }) })).status).toBe(200);
    }
    await vi.waitFor(() => expect(a.client.revoked).toBe(true));
    expect(gateway.registry.authenticate(a.credential.deviceId, a.credential.secret)).toBeUndefined();
    expect(gateway.registry.authenticate(b.credential.deviceId, b.credential.secret)).toBeDefined();
    expect(b.client.online).toBe(true);
  });
});

it("cannot replay an operation by selecting a replacement device", async () => {
  const { gateway, enroll } = await fixture();
  const first = vi.fn(async () => ({ status: "succeeded" as const, output: "first" }));
  const second = vi.fn(async () => ({ status: "succeeded" as const, output: "second" }));
  const a = await enroll(tenant, [driver(first)]),
    b = await enroll(tenant, [driver(second)]),
    request = invocation();
  expect(await gateway.invoke(tenant, a.credential.deviceId, request)).toMatchObject({ status: "succeeded" });
  await gateway.revoke(tenant, a.credential.deviceId);
  expect(await gateway.invoke(tenant, b.credential.deviceId, request)).toMatchObject({ status: "rejected", code: "operation_id_conflict" });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
});

it("transports an 8 MiB file over authenticated HTTP and WebSocket while retaining the ordinary command limit", async () => {
  const f = await fixture();
  const driver = new LocalFilesDriver(join(f.directory, "files"));
  const { credential } = await f.enroll(tenant, [driver], { ...policy, direct: { enabled: true, tools: ["workspace.files.write", "workspace.files.read"] } });
  const data = Buffer.alloc(8 * 1024 * 1024, 3).toString("base64");
  const request = invocation({ capability: "workspace.files", method: "write", input: { path: "upload.bin", data } });
  const response = await fetch(f.url + "/v1/invoke", {
    method: "POST",
    headers: { authorization: "Bearer runtime-a", "content-type": "application/json" },
    body: JSON.stringify({ deviceId: credential.deviceId, invocation: request }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "succeeded", output: { bytes: 8 * 1024 * 1024 } });
  const read = await f.gateway.invoke(
    tenant,
    credential.deviceId,
    invocation({ capability: "workspace.files", method: "read", input: { path: "upload.bin" } }),
  );
  expect(read).toMatchObject({ status: "succeeded", output: { data } });
  expect(await f.gateway.invoke(tenant, credential.deviceId, invocation({ input: { command: "x".repeat(300 * 1024) } }))).toMatchObject({
    status: "rejected",
    code: "input_too_large",
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { denyToolPolicy } from "@yesimbot/contracts";
import { afterEach, expect, it } from "vitest";

import { DeviceClient } from "../../device-client/src/client.js";
import type { DeviceDriver } from "../../device-client/src/driver.js";
import { DeviceGateway } from "../src/gateway.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

// The local address must be a private IPv4 one; use this machine's own, if it has one.
const privateAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address;

async function listen(gateway: DeviceGateway, host: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => void gateway.handleHttp(req, res));
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, port: (server.address() as { port: number }).port };
}

const waitOnline = (client: DeviceClient) =>
  new Promise<void>((resolve, reject) => {
    if (client.online) return resolve();
    const timer = setTimeout(() => reject(new Error("client did not come online")), 10_000);
    client.once("online", () => {
      clearTimeout(timer);
      resolve();
    });
  });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "local-route-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const gateway = await DeviceGateway.open({ directory: join(directory, "gateway"), authenticate: async () => tenant, authorize: () => true });
  cleanup.push(() => gateway.close());
  const proxied = await listen(gateway, "127.0.0.1");
  const driver: DeviceDriver = {
    capability: "computer.desktop",
    methods: { execute: { contexts: ["direct"], execute: async () => ({ status: "succeeded", output: null }) } },
  };
  const open = async (name: string, localGateway: string, options: { online?: boolean; localRetryMs?: number } = {}) => {
    const { credential } = await gateway.registry.enroll({
      code: gateway.registry.createPairing(tenant).code,
      name,
      platform: "linux",
      capabilities: ["computer.desktop"],
    });
    const client = await DeviceClient.open({
      gateway: `http://127.0.0.1:${proxied.port}`,
      localGateway,
      credential,
      directory: join(directory, name),
      drivers: [driver],
      policy: denyToolPolicy(),
      allowLoopback: true,
      reconnectMs: 100,
      localRetryMs: options.localRetryMs,
    });
    cleanup.push(() => client.close());
    client.start();
    if (options.online !== false) await waitOnline(client);
    return client;
  };
  return { gateway, open };
}

/** A private-address port nothing listens on (any more). */
async function closedPort(): Promise<number> {
  const unused = createServer();
  await new Promise<void>((resolve) => unused.listen(0, privateAddress, resolve));
  const port = (unused.address() as { port: number }).port;
  await new Promise<void>((resolve) => unused.close(() => resolve()));
  return port;
}

async function until(condition: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it.skipIf(!privateAddress)(
  "connects over the host-local address when it answers and over the public one when it does not",
  async () => {
    const { gateway, open } = await setup();
    // Nothing listens on the local address: the client comes online over the public one.
    expect((await open("fallback", `http://${privateAddress}:${await closedPort()}`)).route).toBe("public");

    // The same gateway also listening on the local address: that is the one used.
    const local = await listen(gateway, privateAddress!);
    expect((await open("local", `http://${privateAddress}:${local.port}`)).route).toBe("local");
  },
  30_000,
);

it.skipIf(!privateAddress)(
  "keeps to the local address while the gateway there answers, even with a refusal",
  async () => {
    const { open } = await setup();
    // E.g. 401 while the gateway still holds this device's previous connection.
    let attempts = 0;
    const refusing = createServer();
    refusing.on("upgrade", (_request, socket) => {
      attempts++;
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => refusing.listen(0, privateAddress, resolve));
    cleanup.push(() => new Promise<void>((resolve) => refusing.close(() => resolve())));
    const client = await open("refused", `http://${privateAddress}:${(refusing.address() as { port: number }).port}`, { online: false });
    await until(() => attempts >= 3, 5_000);
    // Never fell back to the public address, which would have accepted it.
    expect(client.online).toBe(false);
  },
  30_000,
);

it.skipIf(!privateAddress)(
  "goes back to the local address once it answers again",
  async () => {
    const { gateway, open } = await setup();
    const port = await closedPort();
    const client = await open("returns", `http://${privateAddress}:${port}`, { localRetryMs: 300 });
    expect(client.route).toBe("public");
    // The local entry comes up (e.g. after a gateway restart): the client switches over by itself.
    const server = createServer((req, res) => void gateway.handleHttp(req, res));
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(port, privateAddress, resolve));
    // Closed last, after the client and gateway have dropped the connection it holds.
    cleanup.unshift(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await until(() => client.online && client.route === "local", 10_000);
  },
  30_000,
);

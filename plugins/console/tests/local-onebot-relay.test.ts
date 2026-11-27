import { createServer, type IncomingHttpHeaders } from "node:http";

import { afterEach, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import type { Host } from "../src/host.js";
import { installLocalOneBotRelay } from "../src/local-onebot-relay.js";
import type { TenantManagerClient } from "../src/tenant-manager-client.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it("retains a custom reverse path, relays only loopback OneBot clients, and replaces their credentials with manager authentication", async () => {
  const upstream = createServer();
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const wss = new WebSocketServer({ server: upstream });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        upstream.close(() => resolve());
      }),
  );
  let seen: IncomingHttpHeaders | undefined;
  wss.on("connection", (ws, req) => {
    seen = req.headers;
    ws.on("message", (data) => ws.send(data));
  });
  let handler: Function | undefined, dispose: Function | undefined;
  const manager = {
    endpoint: `http://127.0.0.1:${port}`,
    runtime: async () => ({ state: "running" }),
    path: () => "/pinned/onebot",
    headers: async () => ({ authorization: "Bearer manager-token" }),
  } as unknown as TenantManagerClient;
  installLocalOneBotRelay(
    {
      server: {
        ws: (_path: string, cb: Function) => {
          expect(_path).toBe("/onebot/existing-path");
          handler = cb;
        },
      },
      on: (_event: string, cb: Function) => {
        dispose = cb;
      },
    } as unknown as Host,
    manager,
    "11111111-1111-4111-8111-111111111111",
    "/onebot/existing-path",
  );
  const front = createServer(),
    frontWS = new WebSocketServer({ server: front });
  frontWS.on("connection", (ws, req) => {
    void handler!(ws, req);
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        dispose?.();
        for (const ws of frontWS.clients) ws.terminate();
        frontWS.close();
        front.close(() => resolve());
      }),
  );
  const client = new WebSocket(`ws://127.0.0.1:${(front.address() as { port: number }).port}/onebot`, {
    headers: { "x-self-id": "123456789", "x-client-role": "Universal", authorization: "Bearer napcat-token", cookie: "not-forwarded=secret" },
  });
  cleanup.push(() => client.terminate());
  const response = new Promise<string>((resolve, reject) => {
    client.on("message", (data) => resolve(data.toString()));
    client.on("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  client.send("lifecycle-fixture");
  expect(await response).toBe("lifecycle-fixture");
  expect(seen?.authorization).toBe("Bearer manager-token");
  expect(seen?.cookie).toBeUndefined();
  expect(seen?.["x-self-id"]).toBe("123456789");
  for (const request of [
    { socket: { remoteAddress: "192.0.2.1" }, headers: {} },
    { socket: { remoteAddress: "127.0.0.1" }, headers: { origin: "http://evil.example" } },
    { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-self-id": "injected", "x-client-role": "Universal" } },
  ]) {
    let code: number | undefined;
    await handler!(
      {
        close: (value: number) => {
          code = value;
        },
      },
      request,
    );
    expect(code).toBe(1008);
  }
});

it("rejects a path outside the OneBot namespace", () => {
  for (const path of ["/", "/onebot/../admin", "/onebot?token=x", "/onebot/a/b", "/yesimbot/admin"])
    expect(() => installLocalOneBotRelay({} as Host, {} as TenantManagerClient, "11111111-1111-4111-8111-111111111111", path)).toThrow(
      "invalid_onebot_relay_path",
    );
});

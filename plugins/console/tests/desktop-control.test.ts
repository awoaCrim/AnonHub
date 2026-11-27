import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import type { DesktopReceiver } from "@yesimbot/contracts";
import { systemClock } from "@yesimbot/foundation";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { installDeviceControl } from "../src/webui/device-control";

const id = "22222222-2222-4222-8222-222222222222",
  token = "11111111-1111-4111-8111-111111111111";
type HttpFixture = { status: number; body: unknown; request: { body: unknown }; res: { destroyed: boolean }; get(name: string): string; set(): void };
const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of clean.splice(0).reverse()) await step();
  vi.unstubAllEnvs();
});
async function fixture() {
  const sessions = new Map([
    ["owner", { role: "owner" }],
    ["other", { role: "owner" }],
    ["member", { role: "member" }],
  ]);
  const revoke: Array<() => void> = [],
    dispose: Array<() => void> = [];
  let post!: (http: HttpFixture) => Promise<void>, upgrade!: (ws: WebSocket, request: IncomingMessage) => Promise<void>, receiver!: DesktopReceiver;
  const send = vi.fn(),
    close = vi.fn();
  const devices = {
    acquireControl: vi.fn(async () => token),
    renewControl: vi.fn(() => true),
    releaseControl: vi.fn(),
    openControlDesktop: vi.fn(async (_id: string, _token: string, r: DesktopReceiver) => {
      receiver = r;
      return { send, close };
    }),
  };
  installDeviceControl(
    {
      yesimbot: { devices },
      on: (_event: string, fn: () => void) => dispose.push(fn),
      clock: systemClock(),
      server: {
        post: (_path: string, fn: typeof post) => {
          post = fn;
        },
        ws: (_path: string, fn: typeof upgrade) => {
          upgrade = fn;
        },
      },
    } as never,
    {
      sessionFromCookie: (cookie: string) => sessions.get(cookie),
      sameOrigin: (http: { get(name: string): string }) => http.get("origin") === "https://console.test",
      onRevocation: (fn: () => void) => {
        revoke.push(fn);
        return () => {};
      },
    } as never,
  );
  const server = createServer(),
    wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => void upgrade(ws, req));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  clean.push(async () => {
    for (const d of dispose) d();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/yesimbot/api/v1/devices/desktop`;
  const acquire = async (login?: string) => {
    const http = {
      status: 200,
      body: undefined,
      request: { body: { op: "acquire", deviceId: id } },
      res: { destroyed: false },
      get: (key: string) =>
        ({
          cookie: "owner",
          origin: "https://console.test",
          "content-type": "application/json",
          ...(login
            ? { "x-yesimbot-control-login": login, "x-yesimbot-control-proof": createHmac("sha256", "owner").update(`desktop-login:${login}`).digest("hex") }
            : {}),
        })[key] ?? "",
      set() {},
    };
    await post(http);
  };
  const connect = async (cookie = "owner", origin = "https://console.test", login?: string) => {
    const ws = new WebSocket(url, {
      headers: {
        cookie,
        origin,
        ...(login
          ? { "x-yesimbot-control-login": login, "x-yesimbot-control-proof": createHmac("sha256", cookie).update(`desktop-login:${login}`).digest("hex") }
          : {}),
      },
    });
    clean.push(async () => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return ws;
  };
  return {
    devices,
    connect,
    acquire,
    send,
    receiver: () => receiver,
    logout: () => {
      sessions.delete("owner");
      for (const fn of revoke) fn();
    },
  };
}
it("requires owner, origin and a lease from the same login; tokens never select a foreign lease", async () => {
  const f = await fixture();
  await f.acquire();
  for (const [cookie, origin] of [
    ["", "https://console.test"],
    ["member", "https://console.test"],
    ["owner", "https://foreign.test"],
    ["other", "https://console.test"],
  ]) {
    const ws = await f.connect(cookie, origin);
    const closed = new Promise((resolve) => ws.once("close", resolve));
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ deviceId: id, token }));
    await closed;
  }
  expect(f.devices.openControlDesktop).not.toHaveBeenCalled();
  expect(f.devices.releaseControl).not.toHaveBeenCalled();
});
it("authenticates with the first frame, relays binary data, and closes immediately on logout", async () => {
  const f = await fixture();
  await f.acquire();
  const ws = await f.connect();
  ws.send(JSON.stringify({ deviceId: id, token }));
  await vi.waitFor(() => expect(f.devices.openControlDesktop).toHaveBeenCalledTimes(1));
  ws.send(Buffer.from([4, 1]), { binary: true });
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith(Buffer.from([4, 1])));
  const received = new Promise<Buffer>((resolve) => ws.once("message", (data) => resolve(Buffer.from(data as Buffer))));
  f.receiver().data(Buffer.from([255, 0]));
  expect(await received).toEqual(Buffer.from([255, 0]));
  const closed = new Promise((resolve) => ws.once("close", resolve));
  f.logout();
  await closed;
  expect(f.devices.releaseControl).toHaveBeenCalledWith(id, token);
});
it("refuses text frames or oversized frames after authentication without replay", async () => {
  const f = await fixture();
  await f.acquire();
  const ws = await f.connect();
  ws.send(JSON.stringify({ deviceId: id, token }));
  await vi.waitFor(() => expect(f.devices.openControlDesktop).toHaveBeenCalledTimes(1));
  const closed = new Promise((resolve) => ws.once("close", resolve));
  ws.send("unexpected");
  await closed;
  expect(f.send).not.toHaveBeenCalled();
});

it("separates parent logins sharing the manager's backend cookie", async () => {
  vi.stubEnv("YESIMBOT_TENANT_ID", id);
  const f = await fixture(),
    first = "a".repeat(64),
    second = "b".repeat(64);
  await f.acquire(first);
  const wrong = await f.connect("owner", "https://console.test", second);
  const closed = new Promise((resolve) => wrong.once("close", resolve));
  wrong.send(JSON.stringify({ deviceId: id, token }));
  await closed;
  expect(f.devices.openControlDesktop).not.toHaveBeenCalled();
  expect(f.devices.releaseControl).not.toHaveBeenCalled();
  const right = await f.connect("owner", "https://console.test", first);
  right.send(JSON.stringify({ deviceId: id, token }));
  await vi.waitFor(() => expect(f.devices.openControlDesktop).toHaveBeenCalledTimes(1));
});

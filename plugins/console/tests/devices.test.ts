import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { installDevices } from "../src/webui/devices.js";
type HttpFixture = { status: number; body: unknown; request: { body: unknown }; get(name: string): string; set: ReturnType<typeof vi.fn> };

type Handler = (http: HttpFixture) => Promise<void>;

function harness() {
  const routes = new Map<string, Handler>();
  const devices = {
    available: true,
    list: vi.fn(async () => []),
    pair: vi.fn(async () => ({ code: "test-only" })),
    revoke: vi.fn(async () => {}),
    workspaceSwitch: vi.fn((): { deviceId: string; switchedAt: number } | undefined => undefined),
    clearWorkspaceSwitch: vi.fn(async () => {}),
  };
  const auth = {
    onRevocation: () => () => {},
    sessionFromCookie: (cookie: string) => (cookie ? { role: cookie } : undefined),
    sameOrigin: (http: Pick<HttpFixture, "get">) => http.get("origin") === "https://console.test",
  };
  installDevices(
    {
      on: vi.fn(),
      server: {
        ws() {},
        get: (path: string, handler: Handler) => routes.set(path, handler),
        post: (path: string, handler: Handler) => routes.set(path, handler),
      },
      yesimbot: { devices },
    } as never,
    auth as never,
  );
  const request = async (route: string, role = "owner", origin = "https://console.test", body: unknown = {}) => {
    const headers: Record<string, string> = { cookie: role, origin, "content-type": "application/json" };
    const http = { status: 200, body: undefined as unknown, request: { body }, set: vi.fn(), get: (name: string) => headers[name] ?? "" };
    await routes.get("/yesimbot/api/v1/devices" + route)!(http);
    return http;
  };
  return { devices, request };
}
it("uses only the current runtime service and rejects anonymous, member and cross-origin mutations", async () => {
  const { devices, request } = harness();
  expect((await request("", "")).status).toBe(401);
  expect((await request("/pair", "member")).status).toBe(403);
  expect((await request("/pair", "owner", "https://foreign.test")).status).toBe(403);
  expect(devices.pair).not.toHaveBeenCalled();
  expect((await request("", "owner", "")).body).toEqual({ available: true, devices: [] });
  expect((await request("/pair")).body).toEqual({ code: "test-only" });
  expect(devices.pair).toHaveBeenCalledWith();
});
it("validates the revoke target and never echoes gateway exceptions", async () => {
  const { devices, request } = harness();
  expect((await request("/revoke", "owner", "https://console.test", { deviceId: "../other" })).status).toBe(400);
  expect(devices.revoke).not.toHaveBeenCalled();
  devices.revoke.mockRejectedValueOnce(new Error("private-token"));
  const result = await request("/revoke", "owner", "https://console.test", { deviceId: "11111111-1111-4111-8111-111111111111", tenantId: "foreign" });
  expect(result.status).toBe(503);
  expect(result.body).toEqual({ message: "device_gateway_unavailable" });
  expect(devices.revoke).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
});
it("ignores retired hosted policy metadata while retaining normal pairing and revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hosted-"));
  const file = join(dir, "computer.json");
  const cloud = "22222222-2222-4222-8222-222222222222",
    own = "33333333-3333-4333-8333-333333333333";
  writeFileSync(file, JSON.stringify({ version: 1, deviceId: cloud }));
  process.env.YESIMBOT_COMPUTER_FILE = file;
  try {
    const { devices, request } = harness();
    devices.list.mockResolvedValueOnce([{ deviceId: cloud }, { deviceId: own }] as never);
    expect((await request("", "owner", "")).body).toEqual({ available: true, devices: [{ deviceId: cloud }, { deviceId: own }] });
    expect((await request("/pair")).body).toEqual({ code: "test-only" });
    expect((await request("/revoke", "owner", "https://console.test", { deviceId: cloud })).body).toEqual({ revoked: true });
    expect((await request("/revoke", "owner", "https://console.test", { deviceId: own })).body).toEqual({ revoked: true });
    expect(devices.revoke).toHaveBeenCalledTimes(2);
    expect(devices.revoke).toHaveBeenNthCalledWith(1, cloud);
    expect(devices.revoke).toHaveBeenNthCalledWith(2, own);
  } finally {
    delete process.env.YESIMBOT_COMPUTER_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});
it("shows the bot's own computer switch and lets only the owner clear it", async () => {
  const { devices, request } = harness();
  const deviceId = "33333333-3333-4333-8333-333333333333";
  devices.workspaceSwitch.mockReturnValue({ deviceId, switchedAt: 5 });
  expect((await request("", "owner", "")).body).toEqual({ available: true, devices: [], botSwitch: { deviceId, switchedAt: 5 } });
  expect((await request("/switch/clear", "member")).status).toBe(403);
  expect((await request("/switch/clear", "owner", "https://foreign.test")).status).toBe(403);
  expect(devices.clearWorkspaceSwitch).not.toHaveBeenCalled();
  expect((await request("/switch/clear")).body).toEqual({ cleared: true });
  expect(devices.clearWorkspaceSwitch).toHaveBeenCalledOnce();
  devices.clearWorkspaceSwitch.mockRejectedValueOnce(new Error("private-detail"));
  const failed = await request("/switch/clear");
  expect(failed.status).toBe(503);
  expect(failed.body).toEqual({ message: "computer_switch_unavailable" });
});

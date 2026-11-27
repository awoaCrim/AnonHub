import { expect, it } from "vitest";

import {
  capabilitiesSchema,
  clientFrameSchema,
  deviceHealthSchema,
  deviceRecordSchema,
  deviceUrl,
  BROWSER_VIEW_READ,
  isBrowserControl,
  isScreenViewRead,
  localGatewayUrl,
  parseDeviceFeatures,
  parseDeviceVersion,
  SCREEN_VIEW_PLATFORM,
  SCREEN_VIEW_READS,
  type DeviceInvocation,
} from "../src/device.js";

const viewer = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  platform: SCREEN_VIEW_PLATFORM,
  botId: "webui",
  kind: "direct" as const,
  conversationId: "screen",
};
const read = (extra: Partial<DeviceInvocation> = {}): DeviceInvocation => ({
  operationId: "22222222-2222-4222-8222-222222222222",
  capability: "computer.desktop",
  method: "execute",
  input: { actions: [] },
  conversation: viewer,
  actors: [],
  expiresAt: 1,
  ...extra,
});

it("recognizes only the exact side-effect-free screen-view reads", () => {
  expect(isScreenViewRead(read())).toBe(true);
  expect(isScreenViewRead(read({ method: "ui", input: structuredClone(SCREEN_VIEW_READS.ui) }))).toBe(true);
  expect(SCREEN_VIEW_READS.ui).toEqual({ tool: "screenshot", args: {} });
  expect(isScreenViewRead(read({ capability: "computer.browser", input: structuredClone(BROWSER_VIEW_READ) }))).toBe(true);
  expect(BROWSER_VIEW_READ).toEqual({ action: "view" });
  for (const other of [
    read({ input: { actions: [{ type: "screenshot" }] } }),
    read({ input: { actions: [{ type: "click", x: 1, y: 1 }] } }),
    read({ input: { actions: [], extra: true } }),
    read({ input: {} }),
    read({ input: [] }),
    read({ method: "ui", input: { tool: "click", args: {} } }),
    read({ method: "ui", input: { tool: "screenshot", args: { app: "chromium" } } }),
    read({ method: "ui", input: { tool: "screenshot", args: { output_path: "/tmp/x.png" } } }),
    read({ method: "cua", input: { tool: "get_desktop_state", args: {} } }),
    read({ method: "windows", input: { actions: [] } }),
    read({ capability: "computer.browser" }),
    read({ capability: "computer.browser", input: { action: "screenshot", targetId: "t1" } }),
    read({ capability: "computer.browser", input: { action: "view", targetId: "t1" } }),
    read({ capability: "computer.browser", method: "ui", input: { action: "view" } }),
    read({ capability: "computer.desktop", input: { action: "view" } }),
    read({ capability: "computer.browser", input: { action: "view" }, conversation: { ...viewer, platform: "onebot" } }),
    read({ capability: "computer.browser", input: { action: "view" }, actors: [{ platform: SCREEN_VIEW_PLATFORM, userId: "owner" }] }),
    read({ conversation: { ...viewer, platform: "onebot" } }),
    read({ actors: [{ platform: SCREEN_VIEW_PLATFORM, userId: "owner" }] }),
  ])
    expect(isScreenViewRead(other)).toBe(false);
});

it("keeps only known device features", () => {
  expect(parseDeviceFeatures("screen-view")).toEqual(["screen-view"]);
  expect(parseDeviceFeatures(" future , screen-view ")).toEqual(["screen-view"]);
  expect(parseDeviceFeatures(["screen-view", "future", 1])).toEqual(["screen-view"]);
  expect(parseDeviceFeatures(undefined)).toEqual([]);
  expect(parseDeviceFeatures(["screen-views"])).toEqual([]);
  expect(parseDeviceFeatures("auto-update,screen-view")).toEqual(["screen-view", "auto-update"]);
});

it("keeps only release-shaped client versions", () => {
  expect(parseDeviceVersion(" 2026.1107.1930 ")).toBe("2026.1107.1930");
  for (const value of ["0.0.0-dev", "latest", "1", "<b>1.2</b>", 2026, undefined]) expect(parseDeviceVersion(value)).toBeUndefined();
});

it("accepts cleartext only for a private host-bridge gateway address", () => {
  expect(localGatewayUrl("http://172.18.0.1:17401", "/v1/devices").href).toBe("http://172.18.0.1:17401/v1/devices");
  expect(localGatewayUrl("http://192.168.241.1:17401/", "/v1/connect").href).toBe("http://192.168.241.1:17401/v1/connect");
  expect(localGatewayUrl("http://10.0.0.1:17401", "/v1/devices").host).toBe("10.0.0.1:17401");
  for (const bad of [
    "https://172.18.0.1:17401",
    "http://172.18.0.1",
    "http://172.32.0.1:17401",
    "http://8.8.8.8:17401",
    "http://127.0.0.1:17401",
    "http://example.com:17401",
    "http://user:pw@172.18.0.1:17401",
    "http://172.18.0.1:17401/api",
    "http://172.18.0.1:17401/?x=1",
    "http://[fd00::1]:17401",
  ])
    expect(() => localGatewayUrl(bad, "/v1/devices"), bad).toThrow();
  // The public address keeps requiring HTTPS.
  expect(() => deviceUrl("http://172.18.0.1:17401", "/v1/devices")).toThrow("secure_gateway_required");
});

it("recognises the owner's browser takeover input only in the reserved control scope", () => {
  const control = { ...viewer, conversationId: "control" };
  const input = { action: "control", input: { type: "click", x: 1, y: 2, button: "left" } };
  const owner = read({ capability: "computer.browser", input, conversation: control });
  expect(isBrowserControl(owner)).toBe(true);
  expect(
    isBrowserControl(read({ capability: "computer.browser", input: { action: "control", input: { type: "key", key: "ctrl+a" } }, conversation: control })),
  ).toBe(true);
  for (const other of [
    read({ capability: "computer.browser", input, conversation: viewer }),
    read({ capability: "computer.browser", input, conversation: { ...control, platform: "onebot" } }),
    read({ capability: "computer.browser", input, conversation: { ...control, botId: "bot" } }),
    read({ capability: "computer.browser", input, conversation: control, actors: [{ platform: "web", userId: "x" }] as never }),
    read({ capability: "computer.desktop", input, conversation: control }),
    read({ capability: "computer.browser", method: "ui", input, conversation: control }),
    read({ capability: "computer.browser", input: { ...input, extra: 1 }, conversation: control }),
    read({ capability: "computer.browser", input: { action: "control", input: { type: "key", key: "rm -rf" } }, conversation: control }),
  ])
    expect(isBrowserControl(other)).toBe(false);
  expect(parseDeviceFeatures("browser-view,browser-control")).toEqual(["browser-view", "browser-control"]);
});

it("refuses wechat capabilities and event frames, which devices no longer carry", () => {
  const record = {
    deviceId: "33333333-3333-4333-8333-333333333333",
    tenantId: "11111111-1111-4111-8111-111111111111",
    name: "Old computer",
    platform: "win32",
    createdAt: 1,
  };
  expect(deviceRecordSchema.parse({ ...record, capabilities: ["computer.shell"] }).capabilities).toEqual(["computer.shell"]);
  expect(deviceRecordSchema.safeParse({ ...record, capabilities: ["computer.shell", "wechat.receive"] }).success).toBe(false);
  expect(deviceHealthSchema.safeParse({ "computer.shell": true, "wechat.send": true }).success).toBe(false);
  const hello = { type: "hello", version: 1, deviceId: record.deviceId, capabilities: ["wechat.send"] };
  expect(clientFrameSchema.safeParse(hello).success).toBe(false);
  expect(clientFrameSchema.safeParse({ type: "event", connectionId: record.deviceId, eventId: record.deviceId }).success).toBe(false);
});

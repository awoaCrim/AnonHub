import type { DeviceInvocation, DeviceTransport, DeviceView, OperationResult } from "@yesimbot/contracts";
import { expect, it, vi } from "vitest";

import { Devices, type RuntimeIdentity } from "../src/devices.js";
const id = "22222222-2222-4222-8222-222222222222";
const tenant = "11111111-1111-4111-8111-111111111111";
function setup() {
  const devices = new Devices({
    tenantId: async () => tenant,
    conversation: async () => ({ tenantId: tenant, platform: "web", botId: "bot", kind: "direct", conversationId: "one" }),
  } as unknown as RuntimeIdentity);
  const invoke = vi.fn(async (_id: string, _input: DeviceInvocation): Promise<OperationResult> => ({ status: "succeeded", output: {} }));
  const list = vi.fn(async () => [{ deviceId: id, tenantId: tenant, online: true, capabilities: ["computer.desktop"] }] as DeviceView[]);
  devices.use({ invoke, list } as unknown as DeviceTransport);
  return { devices, invoke, list };
}
const operation = {
  scope: { platform: "web", selfId: "bot", channelId: "one", type: "direct" },
  capability: "computer.shell",
  method: "execute",
  input: { command: "true" },
  operationId: id,
  actors: [],
  expiresAt: Date.now() + 100000,
} as Parameters<Devices["invoke"]>[1];
it("blocks every bot device operation during human control, keeps viewing, and releases only with the matching token", async () => {
  const { devices, invoke } = setup();
  const token = await devices.acquireControl(id);
  expect(await devices.invoke(id, operation)).toMatchObject({ code: "computer_user_controlled" });
  expect(invoke).not.toHaveBeenCalled();
  await devices.captureScreen(id, AbortSignal.timeout(1000));
  expect(invoke).toHaveBeenCalledTimes(1);
  devices.releaseControl(id, tenant);
  expect(devices.renewControl(id, tenant)).toBe(false);
  await expect(devices.controlInput(id, tenant, { tool: "press", args: {} }, AbortSignal.timeout(1000))).rejects.toThrow("computer_control_expired");
  devices.releaseControl(id, token);
  expect(await devices.invoke(id, operation)).toMatchObject({ status: "succeeded" });
});
it("takes over the bot browser only on a client that supports it, keeps the bot out, and sends input only to the leased source", async () => {
  const { devices, invoke, list } = setup();
  const browser = { deviceId: id, tenantId: tenant, online: true, capabilities: ["computer.desktop", "computer.browser"], features: ["browser-view"] };
  list.mockResolvedValue([browser] as unknown as DeviceView[]);
  // A client without browser takeover cannot be leased for it.
  await expect(devices.acquireControl(id, "browser")).rejects.toThrow("computer_control_unavailable");
  list.mockResolvedValue([{ ...browser, features: ["browser-view", "browser-control"] }] as unknown as DeviceView[]);
  const token = await devices.acquireControl(id, "browser");
  // The whole device is the owner's: no bot operation, desktop or browser.
  expect(await devices.invoke(id, { ...operation, capability: "computer.browser", input: { action: "tabs" } })).toMatchObject({
    code: "computer_user_controlled",
  });
  expect(invoke).not.toHaveBeenCalled();
  // A browser lease drives the browser, never the desktop.
  await expect(devices.controlInput(id, token, { tool: "press", args: { combo: "Return" } }, AbortSignal.timeout(1000))).rejects.toThrow(
    "computer_control_unavailable",
  );
  expect(await devices.controlBrowser(id, token, { type: "click", x: 10, y: 20, button: "left" }, AbortSignal.timeout(1000))).toMatchObject({
    status: "succeeded",
  });
  const sent = invoke.mock.calls[0]![1];
  expect(sent).toMatchObject({
    capability: "computer.browser",
    method: "execute",
    input: { action: "control", input: { type: "click", x: 10, y: 20, button: "left" } },
    conversation: { platform: "yesimbot-viewer", botId: "webui", kind: "direct", conversationId: "control" },
    actors: [],
  });
  devices.releaseControl(id, token);
  // A desktop lease does not drive the browser.
  const desktop = await devices.acquireControl(id);
  await expect(devices.controlBrowser(id, desktop, { type: "text", text: "x" }, AbortSignal.timeout(1000))).rejects.toThrow("computer_control_unavailable");
  devices.releaseControl(id, desktop);
});
it("waits for an already running bot operation and blocks new calls while acquiring", async () => {
  const { devices, invoke } = setup();
  let finish!: (value: OperationResult) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = devices.invoke(id, operation);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const acquiring = devices.acquireControl(id);
  await new Promise((resolve) => setImmediate(resolve));
  expect(await devices.invoke(id, operation)).toMatchObject({ code: "computer_user_controlled" });
  finish({ status: "succeeded", output: {} });
  await pending;
  const token = await acquiring;
  expect(devices.renewControl(id, token)).toBe(true);
});
it("does not unlock in the middle of human input and rejects foreign or revoked devices", async () => {
  const { devices, invoke, list } = setup();
  const token = await devices.acquireControl(id);
  let finish!: (value: OperationResult) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const input = devices.controlInput(id, token, { tool: "press", args: { combo: "return" } }, AbortSignal.timeout(1000));
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  devices.releaseControl(id, token);
  expect(await devices.invoke(id, operation)).toMatchObject({ code: "computer_user_controlled" });
  finish({ status: "succeeded", output: {} });
  await input;
  expect(await devices.invoke(id, operation)).toMatchObject({ status: "succeeded" });
  list.mockResolvedValue([
    { deviceId: id, tenantId: "33333333-3333-4333-8333-333333333333", online: true, capabilities: ["computer.desktop"] },
  ] as DeviceView[]);
  await expect(devices.acquireControl(id)).rejects.toThrow("computer_control_unavailable");
});
it("expires abandoned leases without needing a cleanup request", async () => {
  const { devices } = setup();
  vi.useFakeTimers();
  try {
    const token = await devices.acquireControl(id);
    vi.advanceTimersByTime(30001);
    expect(devices.renewControl(id, token)).toBe(false);
    expect(await devices.invoke(id, operation)).toMatchObject({ status: "succeeded" });
  } finally {
    vi.useRealTimers();
  }
});
it("opens one desktop only under the current lease and closes it on release or expiry", async () => {
  const devices = new Devices({ tenantId: async () => tenant } as RuntimeIdentity);
  const close = vi.fn(),
    send = vi.fn(),
    receiver = { data: vi.fn(), close: vi.fn() };
  const openDesktop = vi.fn(async (_id, _invocation, _receiver, _signal) => ({ close, send }));
  devices.use({
    list: async () => [{ deviceId: id, tenantId: tenant, online: true, capabilities: ["computer.desktop"], features: ["desktop-stream"] }],
    openDesktop,
  } as unknown as DeviceTransport);
  const token = await devices.acquireControl(id);
  expect(devices.isUserControlled(id)).toBe(true);
  await expect(devices.openControlDesktop(id, tenant, receiver, AbortSignal.timeout(1000))).rejects.toThrow("computer_control_expired");
  const tunnel = await devices.openControlDesktop(id, token, receiver, AbortSignal.timeout(1000));
  expect(openDesktop).toHaveBeenCalledWith(
    id,
    expect.objectContaining({
      method: "remote",
      input: {},
      actors: [],
      conversation: { tenantId: tenant, platform: "yesimbot-viewer", botId: "webui", kind: "direct", conversationId: "control" },
    }),
    expect.any(Object),
    expect.any(AbortSignal),
  );
  await expect(devices.openControlDesktop(id, token, receiver, AbortSignal.timeout(1000))).rejects.toThrow("computer_control_busy");
  expect(await devices.invoke(id, operation)).toMatchObject({ code: "computer_user_controlled" });
  tunnel.send(new Uint8Array([1, 2]));
  expect(send).toHaveBeenCalledTimes(1);
  devices.releaseControl(id, token);
  expect(close).toHaveBeenCalledTimes(1);
  expect(receiver.close).toHaveBeenCalledTimes(1);
  expect(devices.isUserControlled(id)).toBe(false);
  tunnel.send(new Uint8Array([3]));
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps exclusion while an aborted desktop is still opening even when transport ignores cancellation", async () => {
  const devices = new Devices({ tenantId: async () => tenant } as RuntimeIdentity);
  const close = vi.fn();
  let finish!: (value: { close: typeof close; send: ReturnType<typeof vi.fn> }) => void;
  const openDesktop = vi.fn(
    () =>
      new Promise<{ close: typeof close; send: ReturnType<typeof vi.fn> }>((resolve) => {
        finish = resolve;
      }),
  );
  devices.use({
    list: async () => [{ deviceId: id, tenantId: tenant, online: true, capabilities: ["computer.desktop"], features: ["desktop-stream"] }],
    openDesktop,
  } as unknown as DeviceTransport);
  const token = await devices.acquireControl(id),
    controller = new AbortController();
  const opening = devices.openControlDesktop(id, token, { data() {}, close() {} }, controller.signal);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  controller.abort();
  expect(devices.isUserControlled(id)).toBe(true);
  expect(await devices.invoke(id, operation)).toMatchObject({ code: "computer_user_controlled" });
  finish({ close, send: vi.fn() });
  await expect(opening).rejects.toThrow("computer_control_expired");
  expect(close).toHaveBeenCalledTimes(1);
  expect(devices.isUserControlled(id)).toBe(false);
});
it("requires an upgraded client and ends a desktop when its lease expires", async () => {
  const devices = new Devices({ tenantId: async () => tenant } as RuntimeIdentity);
  const list = vi.fn(async () => [{ deviceId: id, tenantId: tenant, online: true, capabilities: ["computer.desktop"], features: [] }] as DeviceView[]);
  const close = vi.fn(),
    openDesktop = vi.fn(async () => ({ close, send() {} }));
  devices.use({ list, openDesktop } as unknown as DeviceTransport);
  const first = await devices.acquireControl(id);
  await expect(devices.openControlDesktop(id, first, { data() {}, close() {} }, new AbortController().signal)).rejects.toThrow("computer_control_unavailable");
  expect(openDesktop).not.toHaveBeenCalled();
  vi.useFakeTimers();
  try {
    list.mockResolvedValue([
      { deviceId: id, tenantId: tenant, online: true, capabilities: ["computer.desktop"], features: ["desktop-stream"] },
    ] as DeviceView[]);
    const token = await devices.acquireControl(id);
    await devices.openControlDesktop(id, token, { data() {}, close() {} }, new AbortController().signal);
    vi.advanceTimersByTime(30_001);
    expect(close).toHaveBeenCalledTimes(1);
    expect(devices.isUserControlled(id)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it("exposes the workspace plugin's computer switch and lets the owner's choice clear it", async () => {
  const { devices } = setup();
  expect(devices.workspaceSwitch()).toBeUndefined();
  let current: { deviceId: string; switchedAt: number } | undefined = { deviceId: id, switchedAt: 1 };
  const clear = vi.fn(async () => {
    current = undefined;
  });
  const dispose = devices.useWorkspaceResolver(() => current?.deviceId ?? tenant, { current: () => current, clear });
  expect(devices.workspaceDevice(operation.scope)).toBe(id);
  expect(devices.workspaceSwitch()).toEqual({ deviceId: id, switchedAt: 1 });
  await devices.clearWorkspaceSwitch();
  expect(clear).toHaveBeenCalledOnce();
  expect(devices.workspaceSwitch()).toBeUndefined();
  dispose();
  expect(devices.workspaceDevice(operation.scope)).toBeUndefined();
  // Without a workspace plugin there is nothing to clear.
  await expect(devices.clearWorkspaceSwitch()).resolves.toBeUndefined();
});

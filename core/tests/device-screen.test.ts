import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { denyToolPolicy, type DeviceTransport, type DeviceView, type OperationResult } from "@yesimbot/contracts";
import { OperationStore } from "@yesimbot/device-store";
import { afterEach, expect, it, vi } from "vitest";

import { DeviceExecutor } from "../../packages/device-client/src/executor.js";
import { Devices, RuntimeIdentity } from "../src/devices.js";

const tenant = "11111111-1111-4111-8111-111111111111",
  foreign = "33333333-3333-4333-8333-333333333333",
  id = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
const executors: DeviceExecutor[] = [];
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function harness() {
  const devices = new Devices({ tenantId: async () => tenant } as RuntimeIdentity);
  const invoke = vi.fn(async (): Promise<OperationResult> => ({ status: "succeeded", output: {} }));
  const list = vi.fn(async (): Promise<DeviceView[]> => []);
  devices.use({ invoke, list } as unknown as DeviceTransport);
  return { devices, invoke, list };
}
it("uses a fixed viewer scope and agent-desktop's screenshot, without actors, conversations or activity records", async () => {
  const { devices, invoke } = harness();
  const signal = new AbortController().signal;
  await devices.captureScreen(id, signal);
  expect(invoke).toHaveBeenCalledWith(
    id,
    expect.objectContaining({
      capability: "computer.desktop",
      method: "ui",
      input: { tool: "screenshot", args: {} },
      actors: [],
      conversation: { tenantId: tenant, platform: "yesimbot-viewer", botId: "webui", kind: "direct", conversationId: "screen" },
    }),
    signal,
  );
  expect(devices.activity.list()).toEqual([]);
});
it("filters foreign devices and does not reuse another runtime's activity", async () => {
  const first = harness(),
    second = harness();
  first.list.mockResolvedValue([
    { tenantId: tenant, deviceId: id },
    { tenantId: foreign, deviceId: foreign },
  ] as DeviceView[]);
  expect(await first.devices.list()).toEqual([{ tenantId: tenant, deviceId: id }]);
  await first.devices.activity.record("computer_exec", { command: "pwd" }, id, () => ({}));
  expect(second.devices.activity.list()).toEqual([]);
});
it("tries the empty-action desktop read only on a denied screenshot and never retries unknown operations", async () => {
  const { devices, invoke } = harness();
  const signal = new AbortController().signal;
  invoke.mockResolvedValueOnce({ status: "rejected", code: "policy_denied" });
  await devices.captureScreen(id, signal);
  expect(invoke).toHaveBeenLastCalledWith(id, expect.objectContaining({ method: "execute", input: { actions: [] } }), signal);
  invoke.mockClear();
  invoke.mockResolvedValueOnce({ status: "unknown", code: "gateway_result_unavailable" });
  expect(await devices.captureScreen(id, signal)).toMatchObject({ status: "unknown" });
  expect(invoke).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  controller.abort();
  await expect(devices.captureScreen(id, controller.signal)).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("remembers which capture method a device answers, so an older desktop driver takes one request per capture", async () => {
  const { devices, invoke } = harness();
  const signal = new AbortController().signal;
  const methods = () => invoke.mock.calls.map(([, invocation]) => (invocation as { method: string }).method);
  invoke.mockImplementation(async (_id, invocation) =>
    (invocation as { method: string }).method === "execute" ? { status: "succeeded", output: {} } : { status: "rejected", code: "policy_denied" },
  );
  await devices.captureScreen(id, signal);
  expect(methods()).toEqual(["ui", "execute"]);
  invoke.mockClear();
  await devices.captureScreen(id, signal);
  await devices.captureScreen(id, signal);
  expect(methods()).toEqual(["execute", "execute"]);
  // The device now has the other driver: one denied attempt, then that method is remembered instead.
  invoke.mockClear();
  invoke.mockImplementation(async (_id, invocation) =>
    (invocation as { method: string }).method === "ui" ? { status: "succeeded", output: {} } : { status: "rejected", code: "policy_denied" },
  );
  await devices.captureScreen(id, signal);
  await devices.captureScreen(id, signal);
  expect(methods()).toEqual(["execute", "ui", "ui"]);
});
it("keeps the client's local desktop policy and capability gates authoritative for the viewer", async () => {
  const root = await mkdtemp(join(tmpdir(), "viewer-policy-"));
  roots.push(root);
  const execute = vi.fn(async (): Promise<OperationResult> => ({ status: "succeeded", output: { data: "image" } }));
  const driver = { capability: "computer.desktop" as const, methods: { execute: { contexts: ["direct" as const], execute } } };
  for (const [drivers, policy, expected] of [
    [[driver], denyToolPolicy(), "rejected"],
    [[], { ...denyToolPolicy(), direct: { enabled: true, tools: ["*"] } }, "rejected"],
    [[driver], { ...denyToolPolicy(), direct: { enabled: true, tools: ["computer.desktop.execute"] } }, "succeeded"],
    [[driver], { ...denyToolPolicy(), direct: { enabled: true, tools: ["*"] }, platforms: { "yesimbot-viewer": denyToolPolicy() } }, "rejected"],
  ] as const) {
    const store = await OperationStore.open(join(root, String(executors.length)));
    const executor = new DeviceExecutor({ tenantId: tenant, deviceId: id }, drivers, store, policy as never);
    executors.push(executor);
    const devices = new Devices({ tenantId: async () => tenant } as RuntimeIdentity);
    devices.use({ invoke: (_id, invocation) => executor.execute(invocation) } as DeviceTransport);
    expect((await devices.captureScreen(id, new AbortController().signal)).status).toBe(expected);
  }
  expect(execute).toHaveBeenCalledTimes(1);
});
function arbitration() {
  const conversation = { tenantId: tenant, botId: "bot", platform: "onebot", kind: "direct" as const, conversationId: "private:user" };
  const devices = new Devices({ tenantId: async () => tenant, conversation: async () => conversation } as unknown as RuntimeIdentity);
  const pending: Array<{ method: string; capability: string; resolve: (value: OperationResult) => void }> = [];
  const invoke = vi.fn(
    (_id: string, invocation: { method: string; capability: string }) =>
      new Promise<OperationResult>((resolve) => pending.push({ method: invocation.method, capability: invocation.capability, resolve })),
  );
  devices.use({ invoke, list: vi.fn() } as unknown as DeviceTransport);
  const bot = (capability: "computer.desktop" | "computer.shell", signal?: AbortSignal) =>
    devices.invoke(
      id,
      {
        scope: {} as never,
        actors: [],
        operationId: "44444444-4444-4444-8444-444444444444",
        capability,
        method: "execute",
        input: { actions: [{ type: "click", x: 1, y: 1 }] },
        expiresAt: Date.now() + 60_000,
      },
      signal,
    );
  return { devices, invoke, pending, bot };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
it("refuses a viewer capture while a bot desktop call is in flight, without reaching the device", async () => {
  const { devices, invoke, pending, bot } = arbitration();
  const action = bot("computer.desktop");
  await tick();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(await devices.captureScreen(id, new AbortController().signal)).toEqual({ status: "rejected", code: "desktop_unavailable" });
  expect(invoke).toHaveBeenCalledTimes(1);
  pending[0]!.resolve({ status: "succeeded", output: {} });
  await action;
  const capture = devices.captureScreen(id, new AbortController().signal);
  await tick();
  expect(pending[1]).toMatchObject({ method: "ui", capability: "computer.desktop" });
  pending[1]!.resolve({ status: "succeeded", output: {} });
  expect((await capture).status).toBe("succeeded");
});
it("lets a started capture finish before dispatching the bot's desktop call; other capabilities do not wait", async () => {
  const { devices, invoke, pending, bot } = arbitration();
  const capture = devices.captureScreen(id, new AbortController().signal);
  await tick();
  const shell = bot("computer.shell");
  const action = bot("computer.desktop");
  await tick();
  expect(pending.map((call) => call.capability)).toEqual(["computer.desktop", "computer.shell"]);
  // The bot call starting during a policy-denied screenshot also suppresses the fallback attempt.
  pending[0]!.resolve({ status: "rejected", code: "policy_denied" });
  expect(await capture).toEqual({ status: "rejected", code: "desktop_unavailable" });
  await tick();
  expect(pending.map((call) => call.capability)).toEqual(["computer.desktop", "computer.shell", "computer.desktop"]);
  expect(
    invoke.mock.calls.filter(([, invocation]) => (invocation as unknown as { conversation: { platform: string } }).conversation.platform === "yesimbot-viewer"),
  ).toHaveLength(1);
  pending[1]!.resolve({ status: "succeeded", output: {} });
  pending[2]!.resolve({ status: "succeeded", output: { data: "bot" } });
  await expect(action).resolves.toEqual({ status: "succeeded", output: { data: "bot" } });
  await shell;
});
it("bounds the bot's wait for a hung capture and stops waiting when the bot call is aborted", async () => {
  vi.useFakeTimers();
  try {
    const { devices, pending, bot } = arbitration();
    void devices.captureScreen(id, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const aborted = bot("computer.desktop", controller.signal);
    const bounded = bot("computer.desktop");
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pending).toHaveLength(3);
    pending[1]!.resolve({ status: "rejected", code: "cancelled" });
    pending[2]!.resolve({ status: "succeeded", output: {} });
    await Promise.all([aborted, bounded]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

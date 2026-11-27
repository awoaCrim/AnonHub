import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { denyToolPolicy, type DeviceInvocation, type DeviceRecord, type ToolPolicy } from "@yesimbot/contracts";
import { afterEach, expect, it, vi } from "vitest";

import { LocalDeviceTransport, RoutedDeviceTransport } from "../src/local.js";

const record: DeviceRecord = {
  deviceId: randomUUID(),
  tenantId: randomUUID(),
  name: "local test",
  platform: "win32",
  capabilities: ["computer.shell"],
  createdAt: 1,
};
const policy: ToolPolicy = { ...denyToolPolicy(), direct: { enabled: true, tools: ["*"] } };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "local-device-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const request = (): DeviceInvocation => ({
  operationId: randomUUID(),
  capability: "computer.shell",
  method: "exec",
  conversation: { tenantId: record.tenantId, botId: "bot", platform: "test", kind: "direct", conversationId: "user" },
  actors: [],
  input: {},
  expiresAt: Date.now() + 30_000,
});
const driver = (execute = vi.fn(async () => ({ status: "succeeded" as const, output: "ok" }))) => ({
  capability: "computer.shell" as const,
  methods: { exec: { contexts: ["direct" as const], execute } },
});

it("runs locally once, retains results across restart and excludes a second process", async () => {
  const dir = await directory(),
    d = driver(),
    options = { directory: dir, record, policy, drivers: [d] };
  const first = await LocalDeviceTransport.open(options);
  cleanup.push(() => first.close());
  await expect(LocalDeviceTransport.open(options)).rejects.toThrow("already_running");
  const input = request();
  expect(await first.invoke(record.deviceId, input)).toEqual({ status: "succeeded", output: "ok" });
  await first.close();
  const next = await LocalDeviceTransport.open(options);
  cleanup.push(() => next.close());
  expect(await next.invoke(record.deviceId, input)).toEqual({ status: "succeeded", output: "ok" });
  expect(d.methods.exec.execute).toHaveBeenCalledTimes(1);
  expect(await next.invoke(record.deviceId, { ...input, input: { different: true } })).toMatchObject({ code: "operation_id_conflict" });
  expect(await next.invoke(record.deviceId, { ...request(), conversation: { ...input.conversation, tenantId: randomUUID() } })).toMatchObject({
    status: "rejected",
  });
});

it("cancels in-flight local work and never falls back to a remote device", async () => {
  const started = Promise.withResolvers<void>();
  const local = await LocalDeviceTransport.open({
    directory: await directory(),
    record,
    policy,
    drivers: [
      {
        capability: "computer.shell",
        methods: {
          exec: {
            contexts: ["direct"],
            execute: async (_input, signal) => {
              started.resolve();
              await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
              return { status: "unknown", code: "cancelled" };
            },
          },
        },
      },
    ],
  });
  cleanup.push(() => local.close());
  const remote = { ...local, invoke: vi.fn() } as unknown as LocalDeviceTransport;
  const routed = new RoutedDeviceTransport(record.deviceId, local, remote),
    abort = new AbortController();
  const result = routed.invoke(record.deviceId, request(), abort.signal);
  await started.promise;
  abort.abort();
  expect(await result).toMatchObject({ status: "unknown" });
  expect(remote.invoke).not.toHaveBeenCalled();
});

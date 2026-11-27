import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool, AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { manualClock } from "@yesimbot/foundation";
import { RuntimeIdentity } from "koishi-plugin-yesimbot";
import { afterEach, expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { ComputerSwitchStore, computerSelectionBasis } from "../src/computer-switch.js";
import { WorkspaceService } from "../src/index.js";
import type { WorkspacePluginConfig } from "../src/types.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const vm = "22222222-2222-4222-8222-222222222222";
const laptop = "33333333-3333-4333-8333-333333333333";
const away = "44444444-4444-4444-8444-444444444444";
const bridge = "55555555-5555-4555-8555-555555555555";
const policy = {
  version: 1 as const,
  direct: { enabled: true, tools: ["*"] },
  group: { enabled: true, tools: ["*"] },
  actors: [{ kind: "any" as const, platform: "*", conversationId: "*" }],
};
const direct = { type: "direct" as const, platform: "onebot", selfId: "bot", channelId: "private:alice", userId: "alice" };
const group = { type: "guild" as const, platform: "onebot", selfId: "bot", channelId: "room", guildId: "room" };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temp() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-computer-switch-"));
  roots.push(root);
  return root;
}

const device = (deviceId: string, name: string, online: boolean, capabilities = ["computer.shell", "workspace.files"]) => ({
  deviceId,
  tenantId: tenant,
  name,
  platform: "linux",
  online,
  capabilities,
});

async function fixture(computer: WorkspacePluginConfig["computer"] = { deviceId: vm }) {
  const baseDir = await temp();
  let resolver: ((scope: unknown) => string | undefined) | undefined;
  const invoke = vi.fn(async (_deviceId: string, _input: unknown) => ({ status: "succeeded", output: { exitCode: 0, data: "" } }));
  const ctx = {
    baseDir,
    logger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
    on: vi.fn(),
    yesimbot: {
      config: { basePath: "data/yesimbot" },
      identity: new RuntimeIdentity(baseDir, tenant),
      devices: {
        useWorkspaceResolver: vi.fn((resolve: (scope: unknown) => string | undefined) => {
          resolver = resolve;
          return vi.fn();
        }),
        activity: new ComputerActivity(),
        invoke,
        list: vi.fn(async () => [
          device(vm, "VM", true),
          device(laptop, "Laptop", true),
          device(away, "Away", false),
          device(bridge, "WeChat", true, ["wechat.receive"]),
        ]),
      },
      agent: { use: vi.fn(() => vi.fn()) },
      resource: { use: vi.fn(() => vi.fn()), get: vi.fn(async () => ({ path: baseDir, assets: {}, artifacts: {} })) },
    },
  };
  const plugin = new WorkspaceService(
    { host: ctx.yesimbot as never, baseDir, clock: manualClock(Date.UTC(2026, 10, 24)) },
    { toolPolicy: policy, computer, bash: { enableNetwork: false, mounts: [] } },
  );
  await plugin.start();
  const tools = async (scope: typeof direct | typeof group) => {
    const setup = await plugin.setup(scope as never);
    return (setup!.tools as AgentTool[]).reduce<Record<string, AgentTool>>((all, tool) => ({ ...all, [tool.name]: tool }), {});
  };
  return { baseDir, ctx, plugin, invoke, tools, resolve: (scope: unknown) => resolver!(scope) };
}

const execution = (id: string) =>
  ({
    toolCallId: id,
    turnId: "turn",
    runtime: { id: "runtime" },
    messages: [],
    abortSignal: new AbortController().signal,
  }) as unknown as AgentToolExecuteContext;

it("persists a switch, keeps it across restarts and drops it once the owner's setting changes", async () => {
  const file = join(await temp(), "computer-switch.json");
  const basis = computerSelectionBasis({ deviceId: vm });
  const clock = manualClock(Date.UTC(2026, 10, 24, 6));
  const store = new ComputerSwitchStore(file, basis, clock);
  await store.load();
  expect(store.current()).toBeUndefined();
  await store.switchTo(laptop);
  expect(store.current()).toEqual({ deviceId: laptop, switchedAt: clock.now() });
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, deviceId: laptop, basis });

  const restarted = new ComputerSwitchStore(file, basis);
  await restarted.load();
  expect(restarted.current()?.deviceId).toBe(laptop);

  // The owner picked another default meanwhile: the switch no longer applies and is removed.
  const changed = new ComputerSwitchStore(file, computerSelectionBasis({ deviceId: away }));
  await changed.load();
  expect(changed.current()).toBeUndefined();
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });

  await restarted.clear();
  expect(restarted.current()).toBeUndefined();
  expect(() => store.switchTo("not-a-uuid")).toThrow();
});

it("lets the bot switch the whole bot's computer at call time, without rebuilding the conversation", async () => {
  const f = await fixture();
  const tools = await f.tools(direct);
  expect(tools.computer_switch).toBeDefined();
  expect(f.resolve(direct)).toBe(vm);

  const listed = (await tools.computer_switch!.execute({}, execution("list"))) as { current: string; computers: Array<{ deviceId: string; current: boolean }> };
  expect(listed.current).toBe(vm);
  // A platform-only bridge is not a computer.
  expect(listed.computers.map((item) => [item.deviceId, item.current])).toEqual([
    [vm, true],
    [laptop, false],
    [away, false],
  ]);

  expect(await tools.computer_switch!.execute({ deviceId: away }, execution("offline"))).toMatchObject({ status: "rejected", code: "computer_offline" });
  expect(await tools.computer_switch!.execute({ deviceId: bridge }, execution("bridge"))).toMatchObject({ status: "rejected", code: "unknown_computer" });
  expect(f.resolve(direct)).toBe(vm);

  expect(await tools.computer_switch!.execute({ deviceId: laptop }, execution("switch"))).toMatchObject({
    status: "succeeded",
    changed: true,
    current: { deviceId: laptop },
  });
  // The same, already built tools now act on the new computer, as does every other conversation.
  await tools.computer_exec!.execute({ command: "true" }, execution("exec"));
  await tools.readFile!.execute({ path: "a.txt" }, execution("file"));
  expect(f.invoke.mock.calls.map(([deviceId]) => deviceId)).toEqual([laptop, laptop]);
  expect(f.resolve(group)).toBe(laptop);

  // Switching back to the owner's choice drops the switch instead of recording it.
  await tools.computer_switch!.execute({ deviceId: vm }, execution("back"));
  expect(f.resolve(direct)).toBe(vm);
  await expect(stat(join(f.baseDir, "data/yesimbot/computer-switch.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("offers switching in group chats too (the call is admin-gated centrally)", async () => {
  const f = await fixture({ deviceId: vm });
  expect((await f.tools(group)).computer_switch).toBeDefined();
  await (await f.tools(direct)).computer_switch!.execute({ deviceId: laptop }, execution("switch"));
  expect(f.resolve(direct)).toBe(laptop);

  // A restart keeps the switch; the owner's console choice clears it.
  const control = f.ctx.yesimbot.devices.useWorkspaceResolver.mock.lastCall![1] as unknown as ComputerSwitchStore;
  expect(control.current()?.deviceId).toBe(laptop);
  await control.clear();
  expect(f.resolve(direct)).toBe(vm);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EphemeralImageProjectionStore, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import type { DeviceInvocation, ToolPolicy } from "@yesimbot/contracts";
import { OperationStore } from "@yesimbot/device-store";
import type { ChannelContext } from "koishi-plugin-yesimbot";
import { afterEach, expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import type { DeviceDriver } from "../../../packages/device-client/src/driver.js";
import { DeviceExecutor } from "../../../packages/device-client/src/executor.js";
import { computerGuidance, createWorkspaceComputerTools } from "../src/computer.js";

vi.mock("@yesimbot/computer-agent", () => ({
  createComputerUseTool: (options: { driverFactory: (execution: AgentToolExecuteContext) => { execute(actions: unknown[]): Promise<unknown> } }) => ({
    name: "computer_use",
    execute: (_input: unknown, execution: AgentToolExecuteContext) => options.driverFactory(execution).execute([]),
  }),
}));

const tenantId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const scope: ChannelContext = { type: "direct", platform: "onebot", selfId: "bot", channelId: "private:owner", userId: "owner" };
const localPolicy: ToolPolicy = {
  version: 1,
  direct: { enabled: true, tools: ["*"] },
  group: { enabled: true, tools: ["*"] },
  actors: [],
};
const roots: string[] = [];
const executors: DeviceExecutor[] = [];
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function fixture(methods: DeviceDriver["methods"], policy = localPolicy) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-desktop-backends-"));
  roots.push(root);
  const executor = new DeviceExecutor({ tenantId, deviceId }, [{ capability: "computer.desktop", methods }], await OperationStore.open(root), policy);
  executors.push(executor);
  const invoke = vi.fn(async (_device: string, input: Omit<DeviceInvocation, "conversation"> & { scope: ChannelContext }) => {
    const { scope: origin, ...request } = input;
    return executor.execute({
      ...request,
      conversation: {
        tenantId,
        botId: origin.selfId!,
        platform: origin.platform,
        kind: origin.type === "direct" ? "direct" : "group",
        conversationId: origin.channelId,
      },
    });
  });
  const devices = { invoke, activity: new ComputerActivity() } as never;
  const execution = (id: string) => ({ runtime: { id: "runtime" }, turnId: "turn", toolCallId: id, messages: [] }) as AgentToolExecuteContext;
  return { devices, invoke, execution };
}

const screenshot = () => ({ status: "succeeded" as const, output: { data: "AQID", mediaType: "image/png" } });

it("keeps a configured visual model available beside UI and native declarations", async () => {
  const execute = vi.fn(async () => screenshot());
  const f = await fixture({ execute: { contexts: ["direct"], execute } });
  const resolveChatModel = vi.fn(() => ({ model: {}, capabilities: { imageToolResult: "native" } })) as never;
  const tools = createWorkspaceComputerTools(
    f.devices,
    scope,
    { deviceId, desktopModel: "provider:configured-model" },
    new EphemeralImageProjectionStore(),
    () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    { resolveChatModel },
  );
  const visual = tools.find((tool) => tool.name === "computer_use");
  expect(visual).toBeDefined();
  await expect(visual!.execute({ task: "observe the current screen" }, f.execution("visual"))).resolves.toMatchObject({ bytes: Buffer.from([1, 2, 3]) });
  expect(resolveChatModel).toHaveBeenCalledWith("provider:configured-model", scope);
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.invoke.mock.calls[0]![1]).toMatchObject({ capability: "computer.desktop", method: "execute", scope });
});

it("checks each actual device method and local consent; a group is no longer refused for being sensitive, only by the device's own policy", async () => {
  const execute = vi.fn(async () => screenshot());
  const ui = vi.fn(async () => screenshot());
  const f = await fixture(
    { execute: { contexts: ["direct", "group"], execute }, ui: { contexts: ["direct", "group"], execute: ui } },
    { ...localPolicy, direct: { enabled: true, tools: ["computer.desktop.ui"] } },
  );
  const tools = createWorkspaceComputerTools(f.devices, scope, { deviceId }, new EphemeralImageProjectionStore(), () => true);
  expect(tools.map((tool) => tool.name)).not.toContain("computer_desktop");
  const accessible = tools.find((tool) => tool.name === "computer_ui")!;
  expect(await accessible.execute({ tool: "screenshot" }, f.execution("ui"))).toMatchObject({ status: "succeeded" });
  expect(ui).toHaveBeenCalledOnce();
  const groupScope = { type: "guild" as const, platform: "onebot", selfId: "bot", channelId: "room", guildId: "room" };
  const group = createWorkspaceComputerTools(f.devices, groupScope, { deviceId }, new EphemeralImageProjectionStore(), () => true);
  expect(await group.find((tool) => tool.name === "computer_ui")!.execute({ tool: "screenshot" }, f.execution("group"))).toMatchObject({ status: "succeeded" });
  expect(ui).toHaveBeenCalledTimes(2);
  // The device's own local policy still decides: a device that left groups off refuses the same call.
  const closed = await fixture({ ui: { contexts: ["direct", "group"], execute: ui } }, { ...localPolicy, group: { enabled: false, tools: [] } });
  const refused = createWorkspaceComputerTools(closed.devices, groupScope, { deviceId }, new EphemeralImageProjectionStore(), () => true);
  expect(await refused.find((tool) => tool.name === "computer_ui")!.execute({ tool: "screenshot" }, closed.execution("closed"))).toMatchObject({
    status: "rejected",
    code: "policy_denied",
  });
  expect(ui).toHaveBeenCalledTimes(2);
});

it("refuses a visual model whose connection cannot carry tool-result images", async () => {
  const f = await fixture({ execute: { contexts: ["direct"], execute: vi.fn(async () => screenshot()) } });
  const resolveChatModel = vi.fn(() => ({ model: {}, capabilities: { imageToolResult: "unsupported" } })) as never;
  expect(() =>
    createWorkspaceComputerTools(
      f.devices,
      scope,
      { deviceId, desktopModel: "provider:m" },
      new EphemeralImageProjectionStore(),
      () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        resolveChatModel,
      },
    ),
  ).toThrow("workspace_desktop_model_unusable");
});

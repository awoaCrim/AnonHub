import { EphemeralImageProjectionStore, type AgentTool } from "@yesimbot/agent-runtime";
import { expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { createWorkspaceComputerTools } from "../src/computer.js";

// User, 2026-11-20: 「允许部署客户端」 — browser uploads, typing into web terminals and the wheel over one region.
const DEVICE = "44444444-4444-4444-8444-444444444444";

function setup(features: string[]) {
  const invoke = vi.fn(async () => ({ status: "succeeded", output: { action: "x", completed: true } }));
  const list = vi.fn(async () => [{ deviceId: DEVICE, capabilities: ["computer.browser"], features }]);
  const tools = createWorkspaceComputerTools(
    { invoke, list, activity: new ComputerActivity() } as never,
    { platform: "web", channelId: "c", type: "direct" } as never,
    { deviceId: DEVICE },
    new EphemeralImageProjectionStore(),
    (name) => name === "computer_browser",
  );
  return { invoke, tool: tools.find((candidate) => candidate.name === "computer_browser") as AgentTool };
}

let calls = 0;
const execution = () => ({ runtime: { id: "r" }, turnId: "t", toolCallId: `call-${++calls}`, messages: [] }) as never;
const inputs = [
  { action: "type", targetId: "tab", text: "ls -la\n" },
  { action: "hotkey", targetId: "tab", keys: "ctrl+c" },
  { action: "scroll", targetId: "tab", x: 300, y: 400, dy: 3 },
  { action: "upload", targetId: "tab", ref: "e4", files: ["out/report.pdf"] },
];

it("sends the new browser actions to a client that announces browser-input", async () => {
  const { invoke, tool } = setup(["browser-input"]);
  for (const input of inputs) await tool.execute!(input, execution());
  expect(invoke.mock.calls.map(([, invocation]) => (invocation as { input: unknown }).input)).toEqual(inputs);
});

it("tells the bot an older client needs an update, without sending anything", async () => {
  const { invoke, tool } = setup(["shell-jobs"]);
  for (const input of inputs)
    expect(await tool.execute!(input, execution())).toMatchObject({
      status: "rejected",
      code: "client_update_required",
      message: expect.stringContaining(input.action),
    });
  expect(invoke).not.toHaveBeenCalled();
});

it("says what is wrong with a new action's input before asking the computer", async () => {
  const { invoke, tool } = setup(["browser-input"]);
  const problem = async (input: Record<string, unknown>) => ((await tool.execute!(input, execution())) as { message?: string }).message;
  expect(await problem({ action: "type", targetId: "tab", text: "" })).toContain("1–4000");
  expect(await problem({ action: "hotkey", targetId: "tab", keys: "ctrl+alt+shift+cmd+c" })).toContain("ctrl+c");
  expect(await problem({ action: "scroll", targetId: "tab", x: 1, y: 1, dy: 0 })).toContain("-50 到 50");
  expect(await problem({ action: "upload", targetId: "tab", ref: "e1", files: [] })).toContain("1–10");
  expect(await problem({ action: "upload", targetId: "tab", ref: "button", files: ["a.txt"] })).toContain("ref");
  expect(await problem({ action: "scroll", targetId: "tab", x: 1, y: 1 })).toContain("缺少 dy");
  expect(invoke).not.toHaveBeenCalled();
});

import type { AgentTool, AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { expect, it, vi } from "vitest";

import { computerObservationAllowed } from "../src/tasks/computer-observation.js";
import { executionBoundary } from "../src/tasks/tool-execution.js";

const context = {} as AgentToolExecuteContext;
const reads = [
  ["computer_ui", { tool: "screenshot" }],
  ["computer_ui", { tool: "snapshot", args: { app: "Firefox" } }],
  ["computer_ui", { tool: "list_windows" }],
  // Two windows of one app: the Linux window id is a string.
  ["computer_ui", { tool: "snapshot", args: { app: "firefox-esr", window_id: "w-1.231-org-a11y-atspi-accessible-2" } }],
  ["computer_ui", { tool: "describe", args: { tool: "focus_window" } }],
  ["computer_browser", { action: "tabs" }],
  ["computer_browser", { action: "inspect", targetId: "tab-1" }],
  ["computer_browser", { action: "screenshot", targetId: "tab-1" }],
  ["computer_job", { action: "list" }],
  ["computer_job", { action: "read", jobId: "j", waitMs: 60_000, offset: 0 }],
  ["computer_switch", {}],
  // A foreground command that only reads (pipeline audit, 2026-11-20: a shell task could not check anything after an unknown).
  ["computer_exec", { command: "ls -la /tmp/venv/bin/python; echo probe", timeoutMs: 10_000 }],
  ["computer_exec", { command: "true" }],
] as const;
it.each(reads)("treats %s %j as an observation", (name, input) => {
  expect(computerObservationAllowed(name, input)).toBe(true);
});
const writes = [
  ["computer_ui", { tool: "click", args: { ref_id: "x" } }],
  ["computer_ui", { tool: "sequence", args: { actions: [{ tool: "click" }] } }],
  ["computer_ui", { tool: "snapshot", args: { actions: [{ tool: "click" }] } }],
  ["computer_ui", { tool: "describe", args: { actions: [{ tool: "click" }] } }],
  ["computer_ui", { tool: "focus_window", args: { window_id: "w-1.231-org-a11y-atspi-accessible-2" } }],
  ["computer_browser", { action: "navigate", url: "https://example.com" }],
  ["computer_browser", { action: "inspect", actions: [{ action: "click" }] }],
  ["computer_browser", { action: "click_at", targetId: "tab-1", x: 5, y: 5 }],
  ["computer_browser", { action: "screenshot", targetId: "tab-1", x: 5, y: 5 }],
  ["computer_job", { action: "stop", jobId: "j" }],
  ["computer_job", { action: "read", jobId: "j", command: "rm -rf /" }],
  ["computer_switch", { deviceId: "33333333-3333-4333-8333-333333333333" }],
  ["computer_exec", { command: "touch /tmp/x" }],
  ["computer_exec", { command: "ls -la > listing.txt" }],
  ["computer_exec", { command: "ls -la", background: true }],
] as const;
it.each(writes)("does not treat %s %j as an observation", (name, input) => {
  expect(computerObservationAllowed(name, input)).toBe(false);
});
it("gives the main agent the granted computer tools in full, like a computer worker", async () => {
  const tools = ["computer_ui", "computer_browser", "computer_exec", "computer_use", "writeFile"].map((name) => ({
    name,
    description: `original ${name}`,
    execute: vi.fn(async () => ({ ok: true })),
  }));
  for (const role of ["main", "computer"] as const) {
    const boundary = executionBoundary(role);
    const projected = (await (boundary.filterTools as Function)(tools)) as AgentTool[];
    expect(projected.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    expect(projected[0]!.description).toBe("original computer_ui");
    await projected[0]!.execute({ tool: "click", args: { ref_id: "x" } }, context);
    await projected[2]!.execute({ command: "ssh -o BatchMode=yes ssh2 true" }, context);
    expect(await (boundary.beforeToolCall as Function)({ toolName: "computer_browser", args: { action: "navigate", url: "https://example.com" } })).toEqual({
      type: "allow",
    });
  }
  expect(tools[0]!.execute).toHaveBeenCalledTimes(2);
  expect(tools[2]!.execute).toHaveBeenCalledTimes(2);
  // A content worker still cannot operate the computer.
  const content = (await (executionBoundary("content").filterTools as Function)(tools)) as AgentTool[];
  expect(content.map((tool) => tool.name)).toEqual(["writeFile"]);
});

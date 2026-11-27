import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { expect, it, vi } from "vitest";

import { ComputerActivity } from "../../../core/src/computer-activity.js";
import { createWorkspaceComputerTools } from "../src/computer.js";

vi.mock("@yesimbot/computer-agent", () => ({
  createComputerUseTool: (options: { driverFactory: (execution: unknown) => { execute(actions: unknown[], signal?: AbortSignal): Promise<unknown> } }) => ({
    name: "computer_use",
    execute: async (_input: unknown, execution: { abortSignal?: AbortSignal }) => {
      await options.driverFactory(execution).execute(
        [
          { type: "click", x: 0, y: 0 },
          { type: "type", text: "private" },
        ],
        execution.abortSignal,
      );
      return { status: "completed" };
    },
  }),
}));
const execution = { runtime: { id: "runtime" }, turnId: "turn", toolCallId: "call", messages: [] } as never;
const scope = { platform: "onebot", channelId: "private:user", type: "direct", selfId: "bot", userId: "user" } as const;
it.each([
  ["computer_exec", { command: "pwd" }, "命令行", "pwd"],
  ["computer_ui", { tool: "screenshot" }, "桌面操作", "screenshot"],
  [
    "computer_browser",
    { action: "navigate", targetId: "tab1", url: "https://example.test/?token=private" },
    "浏览器",
    "navigate https://example.test/?[redacted]",
  ],
])("records %s at the actual routed device without exposing results", async (name, input, label, summary) => {
  const activity = new ComputerActivity();
  const invoke = vi.fn(async () => ({ status: "succeeded", output: { text: "private output" } }));
  const tools = createWorkspaceComputerTools(
    { invoke, activity } as never,
    scope,
    { deviceId: "selected" },
    new EphemeralImageProjectionStore(),
    (tool) => tool === name,
  );
  expect(tools.some((tool) => tool.name.includes("viewer") || tool.name.includes("captureScreen"))).toBe(false);
  const tool = tools.find((tool) => tool.name === name)!;
  await tool.execute(input, execution);
  expect(activity.list()).toEqual([expect.objectContaining({ tool: name, label, summary, status: "ok", deviceId: "selected" })]);
  // The origin names the conversation (a OneBot private chat is "private:<id>"); nothing else may carry inputs or results.
  expect(activity.list().every((item) => item.origin?.platform === "onebot" && item.origin.channelId === "private:user")).toBe(true);
  expect(JSON.stringify(activity.list().map(({ origin: _origin, ...item }) => item))).not.toContain("private");
  invoke.mockRejectedValueOnce(new Error("private error"));
  await expect(tool.execute(input, execution)).rejects.toThrow();
  expect(activity.list()[0].status).toBe("failed");
});
it("records background command management as its own kind of work, without its output", async () => {
  const activity = new ComputerActivity();
  const invoke = vi.fn(async () => ({ status: "succeeded", output: { output: "private output" } }));
  const list = vi.fn(async () => [{ deviceId: "selected", capabilities: ["computer.shell"], features: ["shell-jobs"] }]);
  const tools = createWorkspaceComputerTools(
    { invoke, list, activity } as never,
    scope,
    { deviceId: "selected" },
    new EphemeralImageProjectionStore(),
    (tool) => tool === "computer_exec",
  );
  await tools.find((tool) => tool.name === "computer_job")!.execute({ action: "read", jobId: "44444444-4444-4444-8444-444444444444", waitMs: 1000 }, execution);
  expect(activity.list()).toEqual([
    expect.objectContaining({ tool: "computer_job", label: "后台命令", summary: "read 44444444", status: "ok", deviceId: "selected" }),
  ]);
  expect(JSON.stringify(activity.list().map(({ origin: _origin, ...item }) => item))).not.toContain("private");
});
it("records computer_use plus its actual action batches, including failed screenshot validation", async () => {
  const activity = new ComputerActivity();
  const invoke = vi.fn(async () => ({ status: "succeeded", output: { data: "AQID", mediaType: "image/png" } }));
  const tool = createWorkspaceComputerTools(
    { invoke, activity } as never,
    scope,
    { deviceId: "selected", desktopModel: "provider:test" },
    new EphemeralImageProjectionStore(),
    (name) => name === "computer_use",
    undefined,
    undefined,
    undefined,
    undefined,
    { resolveChatModel: () => ({ model: {}, capabilities: { imageToolResult: "native" } }) } as never,
  )[0]!;
  await tool.execute({ task: "private task" }, execution);
  expect(activity.list()).toMatchObject([
    { tool: "computer_use", summary: "click, type", status: "ok", deviceId: "selected" },
    { tool: "computer_use", status: "ok", deviceId: "selected" },
  ]);
  invoke.mockResolvedValueOnce({ status: "succeeded", output: { data: "", mediaType: "image/png" } });
  await expect(tool.execute({ task: "private task" }, execution)).rejects.toThrow("workspace_desktop_screenshot_invalid");
  expect(
    activity
      .list()
      .slice(0, 2)
      .map((item) => item.status),
  ).toEqual(["failed", "failed"]);
  // The origin names the conversation (a OneBot private chat is "private:<id>"); nothing else may carry inputs or results.
  expect(activity.list().every((item) => item.origin?.platform === "onebot" && item.origin.channelId === "private:user")).toBe(true);
  expect(JSON.stringify(activity.list().map(({ origin: _origin, ...item }) => item))).not.toContain("private");
});

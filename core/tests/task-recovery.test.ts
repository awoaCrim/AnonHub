import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema } from "@yesimbot/agent-runtime";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import { computerOperationUnknown } from "../src/tasks/computer-recovery.js";
import { Tasks } from "../src/tasks/manager.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("blocks new write call IDs after a device unknown result while permitting strictly read-only computer observation", async () => {
  const path = await mkdtemp(join(tmpdir(), "yib-task-recovery-"));
  directories.push(path);
  const calls = [
    { name: "computer_exec", input: { command: "submit-once" } },
    { name: "computer_exec", input: { command: "submit-once" } },
    { name: "computer_ui", input: { tool: "screenshot", args: {} } },
    { name: "computer_ui", input: { tool: "screenshot", args: { actions: [{ type: "click" }] } } },
    { name: "computer_ui", input: { tool: "click", args: { ref_id: "@1" } } },
    { name: "task_report", input: { status: "succeeded", result: "已观察当前状态，未重新提交操作。" } },
  ];
  let requests = 0;
  const write = vi.fn(async () => ({ status: "unknown", code: "gateway_result_unavailable" }));
  const observe = vi.fn(async () => ({ status: "succeeded", output: { text: "actual observed screen" } }));
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      const step = calls[requests++]!;
      if (requests === 3) expect(JSON.stringify(options.prompt)).toContain("execution_unknown");
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "different-call-" + requests, toolName: step.name, input: JSON.stringify(step.input) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } },
        ]),
      };
    },
  });
  const diagnostic = vi.fn();
  const manager = new Tasks(path, {
    prepare: async () => ({
      config: {
        model,
        tools: [
          { name: "computer_exec", inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } } }), execute: write },
          {
            name: "computer_ui",
            inputSchema: jsonSchema({ type: "object", properties: { tool: { type: "string" }, args: { type: "object" } } }),
            execute: observe,
          },
        ],
      },
    }),
    notify: async () => "delivered",
    diagnostic,
    changed() {},
  });
  await manager.start();
  try {
    const task = await manager.create({ channel: "channel", session: "s.jsonl" }, "computer", "submit once, then verify", "unknown-result");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    expect((await manager.store.get(task.id))?.status).toBe("unknown");
    expect((await manager.store.get(task.id))?.result).toContain("结果未确认");
    expect((await manager.store.get(task.id))?.handoff).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toEqual({ tool: "screenshot", args: {} });
    expect(requests).toBe(calls.length);
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    await manager.stop();
  }
});

it("recognizes only known computer operation envelopes, leaving other tool result protocols unchanged", () => {
  const unknown = { status: "unknown", code: "gateway_result_unavailable", coordinates: { note: "projected display metadata" } };
  expect(computerOperationUnknown("computer_ui", unknown)).toBe(true);
  expect(computerOperationUnknown("computer_exec", unknown)).toBe(true);
  expect(computerOperationUnknown("gmail_send", unknown)).toBe(false);
  expect(computerOperationUnknown("custom_tool", unknown)).toBe(false);
  expect(computerOperationUnknown("computer_exec", { status: "succeeded", output: unknown })).toBe(false);
  expect(computerOperationUnknown("computer_exec", { status: "unknown" })).toBe(false);
  // An older client's timeout: the command ran and was stopped, not lost track of.
  expect(computerOperationUnknown("computer_exec", { status: "unknown", code: "shell_interrupted", message: "…" })).toBe(false);
  expect(computerOperationUnknown("computer_ui", { status: "unknown", code: "shell_interrupted" })).toBe(true);
});

it("lets a task keep running commands after a command was stopped at its timeout", async () => {
  const path = await mkdtemp(join(tmpdir(), "yib-task-recovery-timeout-"));
  directories.push(path);
  const calls = [
    { name: "computer_exec", input: { command: "yarn build" } },
    { name: "computer_exec", input: { command: "git status --short" } },
    { name: "task_report", input: { status: "succeeded", result: "构建超时后检查了工作区状态。" } },
  ];
  let requests = 0;
  const exec = vi.fn(async ({ command }: { command: string }) =>
    command === "yarn build" ? { status: "unknown", code: "shell_interrupted" } : { status: "succeeded", output: { exitCode: 0, stdout: "" } },
  );
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const step = calls[requests++]!;
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-" + requests, toolName: step.name, input: JSON.stringify(step.input) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } },
        ]),
      };
    },
  });
  const manager = new Tasks(path, {
    prepare: async () => ({
      config: {
        model,
        tools: [{ name: "computer_exec", inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } } }), execute: exec }],
      },
    }),
    notify: async () => "delivered",
    diagnostic: vi.fn(),
    changed() {},
  });
  await manager.start();
  try {
    const task = await manager.create({ channel: "channel", session: "s.jsonl" }, "computer", "build, then check", "timeout-result");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    expect((await manager.store.get(task.id))?.status).toBe("succeeded");
    expect(exec.mock.calls.map(([input]) => input.command)).toEqual(["yarn build", "git status --short"]);
  } finally {
    await manager.stop();
  }
});

it("does not treat an unknown screenshot as an external effect or block a later authorized operation", async () => {
  const path = await mkdtemp(join(tmpdir(), "yib-task-recovery-observe-"));
  directories.push(path);
  let requests = 0;
  const write = vi.fn(async () => ({ status: "succeeded", output: { exitCode: 0 } }));
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const step = ++requests;
      const name = step === 1 ? "computer_ui" : step === 2 ? "computer_exec" : "task_report";
      const input =
        step === 1 ? { tool: "screenshot", args: {} } : step === 2 ? { command: "authorized-operation" } : { status: "succeeded", result: "操作回执已确认。" };
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "step-" + step, toolName: name, input: JSON.stringify(input) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } },
        ]),
      };
    },
  });
  const manager = new Tasks(path, {
    prepare: async () => ({
      config: {
        model,
        tools: [
          {
            name: "computer_ui",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => ({ status: "unknown", code: "gateway_result_unavailable" }),
          },
          { name: "computer_exec", inputSchema: jsonSchema({ type: "object" }), execute: write },
        ],
      },
    }),
    notify: async () => "delivered",
    diagnostic: vi.fn(),
    changed() {},
  });
  await manager.start();
  try {
    const task = await manager.create({ channel: "channel", session: "s.jsonl" }, "computer", "observe, then operate", "unknown-observe");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    expect((await manager.store.get(task.id))?.status).toBe("succeeded");
    expect(write).toHaveBeenCalledTimes(1);
    expect(requests).toBe(3);
  } finally {
    await manager.stop();
  }
});

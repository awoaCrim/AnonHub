import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import { Tasks } from "../src/tasks/manager.js";
import { LiveSteps, mergeSteps, TranscriptSteps, workValue } from "../src/tasks/steps.js";

// User, 2026-11-20: 「我点开这个后台任务不就是为了看进度吗？至少我得知道，执行了哪些命令，正在执行什么命令吧？」
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "yib-task-steps-"));
  dirs.push(path);
  return path;
}

const line = (role: string, content: unknown[], timestamp = 1000) =>
  JSON.stringify({ type: "message", data: { id: `${role}-${timestamp}`, timestamp, role, content } }) + "\n";
const call = (id: string, command: string) => ({ type: "tool-call", toolCallId: id, toolName: "computer_exec", input: { command } });
const result = (id: string, output: unknown) => ({ type: "tool-result", toolCallId: id, toolName: "computer_exec", output });

it("reads a transcript's calls with their results, parsing only what was appended since", async () => {
  const path = join(await directory(), "task.jsonl");
  await writeFile(
    path,
    line("user", [{ type: "text", text: "装 komari-agent" }]) +
      line("assistant", [{ type: "text", text: "先看看" }, call("a", "uname -a"), call("b", "false")], 2000) +
      line("tool", [
        result("a", { type: "json", value: { status: "succeeded", output: { exitCode: 0, stdout: "Linux denver" } } }),
        result("b", { type: "json", value: { status: "succeeded", output: { exitCode: 1, stdout: "" } } }),
      ]) +
      "not json\n",
  );
  const transcript = new TranscriptSteps(path);
  expect(await transcript.read()).toEqual([
    {
      id: "a",
      tool: "computer_exec",
      input: { command: "uname -a" },
      status: "ok",
      output: { status: "succeeded", output: { exitCode: 0, stdout: "Linux denver" } },
      at: 2000,
    },
    {
      id: "b",
      tool: "computer_exec",
      input: { command: "false" },
      status: "failed",
      output: { status: "succeeded", output: { exitCode: 1, stdout: "" } },
      at: 2000,
    },
  ]);
  // A line still being written is left for the next read.
  const next = line("assistant", [call("c", "ls /tmp")], 3000) + line("tool", [result("c", { type: "error-text", value: "device offline" })]);
  await appendFile(path, next.slice(0, next.length - 20));
  expect((await transcript.read()).map((step) => [step.id, step.status])).toEqual([
    ["a", "ok"],
    ["b", "failed"],
    ["c", "unknown"],
  ]);
  await appendFile(path, next.slice(next.length - 20));
  const steps = await transcript.read();
  expect(steps.at(-1)).toMatchObject({ id: "c", status: "failed", output: "device offline" });
  expect(await new TranscriptSteps(join(await directory(), "missing.jsonl")).read()).toEqual([]);
});

it("keeps long text's start and end, and leaves out images and binary data", () => {
  const output = "开头" + "x".repeat(10_000) + "结尾";
  const clipped = workValue({ stdout: output, image: "data:image/png;base64,AAAA", raw: "QUJD".repeat(300) }) as Record<string, string>;
  expect(clipped.stdout.startsWith("开头")).toBe(true);
  expect(clipped.stdout.endsWith("结尾")).toBe(true);
  expect(clipped.stdout).toContain(`（中间省略 ${output.length - 4000} 字）`);
  expect(clipped.image).toBe("[图片或二进制内容，未显示]");
  expect(clipped.raw).toBe("[图片或二进制内容，未显示]");
  expect(workValue(Array.from({ length: 60 }, (_, index) => index))).toHaveLength(51);
});

it("lists calls under way after the written ones, until the transcript has them", () => {
  const live = new LiveSteps();
  live.started("b", "computer_exec", { command: "curl -O https://example.com/k.tgz" }, 5000);
  live.started("c", "computer_exec", { command: "sleep 1" }, 5000);
  live.ended("c", { status: "succeeded", output: { exitCode: 0 } }, false);
  const written = [{ id: "a", tool: "computer_exec", input: { command: "ls" }, status: "ok" as const }];
  expect(mergeSteps(written, live.list()).map((step) => [step.id, step.status])).toEqual([
    ["a", "ok"],
    ["b", "running"],
    ["c", "ok"],
  ]);
  live.written();
  expect(live.list().map((step) => step.id)).toEqual(["b"]);
});

it("shows a running task's finished commands and the one it is running now, then what came of it", async () => {
  const path = await directory();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const exec: AgentTool<{ command: string }> = {
    name: "computer_exec",
    description: "run a command",
    inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false }),
    execute: async ({ command }) => {
      if (command.startsWith("curl")) await hold;
      return { status: "succeeded", output: { exitCode: 0, stdout: `ran ${command}` } };
    },
  };
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const plan = [
    { tool: "computer_exec", input: { command: "uname -a" } },
    { tool: "computer_exec", input: { command: "curl -L -o /tmp/k.tgz https://example.com/k.tgz" } },
    { tool: "task_report", input: { status: "succeeded", result: "下载好了" } },
  ];
  let requests = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const step = plan[requests++]!;
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `call-${requests}`, toolName: step.tool, input: JSON.stringify(step.input) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
        ] as never),
      } as never;
    },
  });
  const manager = new Tasks(path, {
    prepare: async () => ({ config: { model, tools: [exec as AgentTool] } }),
    notify: vi.fn(async () => "delivered" as const),
    diagnostic: vi.fn(),
    changed: vi.fn(),
  });
  await manager.start();
  try {
    const task = await manager.create({ channel: "c", session: "s.jsonl" }, "computer", "下载 komari-agent", "key", [], { timeLimitMinutes: 30 });
    await vi.waitFor(async () => expect((await manager.steps(task.id)).steps).toHaveLength(2));
    const running = await manager.steps(task.id);
    expect(running.total).toBe(2);
    expect(running.steps[0]).toMatchObject({ id: "call-1", status: "ok", input: { command: "uname -a" }, output: { output: { stdout: "ran uname -a" } } });
    expect(running.steps[1]).toMatchObject({ id: "call-2", status: "running", input: { command: "curl -L -o /tmp/k.tgz https://example.com/k.tgz" } });
    expect(running.steps[1]).not.toHaveProperty("output");
    // A caller holding the first step asks from the one still running.
    expect((await manager.steps(task.id, 1)).steps.map((step) => step.id)).toEqual(["call-2"]);
    release();
    // The result is handed over after the task ends; stopping before that write lands leaves it writing into a removed directory.
    await vi.waitFor(async () => expect(await manager.store.get(task.id)).toMatchObject({ status: "succeeded", notification: "delivered" }));
    const done = await manager.steps(task.id);
    expect(done.steps.map((step) => [step.id, step.tool, step.status])).toEqual([
      ["call-1", "computer_exec", "ok"],
      ["call-2", "computer_exec", "ok"],
      ["call-3", "task_report", "ok"],
    ]);
    expect(done.steps[1]).toMatchObject({ output: { output: { stdout: "ran curl -L -o /tmp/k.tgz https://example.com/k.tgz" } } });
    await expect(manager.steps("00000000-0000-4000-8000-000000000000")).rejects.toThrow("task_not_found");
  } finally {
    release();
    await manager.stop();
  }
});

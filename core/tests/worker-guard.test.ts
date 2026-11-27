import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerActivity, workerRepeatGuard } from "../src/tasks/worker-guard.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const call = (toolName: string, input: unknown, id: string): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName, input }],
});
const step = (stepNumber: number) => ({ stepNumber, turnId: "t", runtime: { id: "r" } }) as never;
const note = async (messages: ModelMessage[], stepNumber: number) => {
  const result = await workerRepeatGuard().prepareStep!(messages, step(stepNumber));
  return result ? String((result.at(-1) as { content: string }).content) : undefined;
};

// Preview records, 2026-11-19: one task took the same screenshot 12 times.
describe("background task repeat guard", () => {
  // User, 2026-11-20: 「超时/步数超了仅提醒主bot…不强制结束。步数非必要」.
  it("never asks a task to wrap up because of its steps", async () => {
    for (const stepNumber of [0, 42, 49, 50, 200]) expect(await note([], stepNumber)).toBeUndefined();
  });

  it("points out the third identical call with the same result, whatever the order of its fields", async () => {
    const result = (id: string, text: string): ModelMessage => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "computer_browser",
          output: {
            type: "content",
            value: [
              { type: "text", text },
              { type: "image-data", data: id, mediaType: "image/png" },
            ],
          },
        },
      ],
    });
    const screenshot = (id: string, input: Record<string, unknown>, text = "login page") => [call("computer_browser", input, id), result(id, text)];
    const twice = [...screenshot("1", { action: "screenshot", targetId: "a" }), ...screenshot("2", { targetId: "a", action: "screenshot" })];
    expect(await note(twice, 3)).toBeUndefined();
    const thrice = [...twice, ...screenshot("3", { action: "screenshot", targetId: "a" })];
    expect(await note(thrice, 4)).toContain("3 次用完全相同的参数调用 computer_browser");
    // A page that changes is new information each time, as is a job polled for new output.
    const changing = [
      ...screenshot("1", { action: "screenshot" }, "loading"),
      ...screenshot("2", { action: "screenshot" }, "half"),
      ...screenshot("3", { action: "screenshot" }, "done"),
    ];
    expect(await note(changing, 4)).toBeUndefined();
    // A different call last is not a repetition, and neither is the report itself.
    expect(await note([...thrice, ...screenshot("4", { action: "inspect", targetId: "a" })], 5)).toBeUndefined();
    expect(await note([...thrice, call("task_report", { status: "failed", result: "x" }, "5")], 5)).toBeUndefined();
  });
});

describe("background task activity", () => {
  it("lists what a task did without what it typed or any token", () => {
    const activity = new WorkerActivity();
    expect(activity.summary()).toContain("还没有执行任何工具操作");
    const after = activity.plugin.afterToolCall!;
    after(
      {
        toolCallId: "1",
        toolName: "computer_browser",
        args: { action: "fill", ref: "e1", text: "hunter2-password" },
        result: { status: "succeeded" },
        isError: false,
      },
      {} as never,
    );
    after(
      {
        toolCallId: "2",
        toolName: "computer_exec",
        args: { command: "curl -H 'Authorization: Bearer abc123secret' https://example.com" },
        result: { status: "succeeded", output: { exitCode: 7 } },
        isError: false,
      },
      {} as never,
    );
    after(
      {
        toolCallId: "3",
        toolName: "computer_browser",
        args: { action: "click", ref: "e9" },
        result: { status: "rejected", code: "stale_browser_snapshot" },
        isError: false,
      },
      {} as never,
    );
    after({ toolCallId: "4", toolName: "task_report", args: { status: "failed", result: "x" }, result: { ok: true }, isError: false }, {} as never);
    const summary = activity.summary();
    expect(summary).toContain("一共调用了 3 次工具（computer_browser ×2、computer_exec ×1）");
    expect(summary).toContain("computer_browser action=fill ref=e1 → 完成");
    expect(summary).toContain("→ 退出码 7");
    expect(summary).toContain("rejected stale_browser_snapshot");
    expect(summary).not.toContain("hunter2");
    expect(summary).not.toContain("abc123secret");
    expect(summary).not.toContain("task_report");
  });

  it("advises a fresh delegation only when nothing may have run", () => {
    expect(new WorkerActivity().summary()).toContain("可以直接重新委派");
    // A call of unknown outcome may never reach the plugin; nothing is said to be safe to repeat then.
    expect(new WorkerActivity().summary(true)).not.toContain("重新委派");
    expect(new WorkerActivity().summary(true)).toContain("请先核实");
  });

  it("hides the value after a password or token option in a listed command", () => {
    const activity = new WorkerActivity();
    activity.plugin.afterToolCall!(
      { toolCallId: "1", toolName: "computer_exec", args: { command: "npm login --password hunter2 --token=npm_abc123" }, result: {}, isError: false },
      {} as never,
    );
    const summary = activity.summary();
    expect(summary).toContain("npm login --password [redacted]");
    expect(summary).not.toMatch(/hunter2|npm_abc123/);
  });

  it("keeps only the latest calls", () => {
    const activity = new WorkerActivity();
    for (let index = 0; index < 20; index++)
      activity.plugin.afterToolCall!({ toolCallId: String(index), toolName: "probe", args: { id: `n${index}` }, result: {}, isError: false }, {} as never);
    const summary = activity.summary();
    expect(summary).toContain("一共调用了 20 次工具（probe ×20），最后 8 次");
    expect(summary).toContain("id=n19");
    expect(summary).not.toContain("id=n11 ");
  });
});

function streamOf(...parts: unknown[]) {
  return async () => {
    const { convertArrayToReadableStream } = await import("ai/test");
    return {
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        ...parts,
        {
          type: "finish",
          finishReason: parts.some((part) => (part as { type: string }).type === "tool-call")
            ? { unified: "tool-calls", raw: "tool-calls" }
            : { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        },
      ] as never),
    };
  };
}
const toolCall = (toolName: string, input: unknown, id: string) => ({ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) });
const words = (text: string, id: string) => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
];

async function worker(respond: (request: number, prompt: string) => Promise<unknown>) {
  const { Tasks } = await import("../src/tasks/manager.js");
  const { MockLanguageModelV3 } = await import("ai/test");
  const path = await mkdtemp(join(tmpdir(), "yib-worker-guard-"));
  dirs.push(path);
  const prompts: string[] = [];
  const offered: string[][] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      prompts.push(prompt);
      offered.push((options.tools ?? []).map((tool) => tool.name));
      return (await respond(prompts.length, prompt)) as never;
    },
  });
  const probe: AgentTool = {
    name: "probe",
    executionKind: "read",
    description: "look at the page",
    inputSchema: jsonSchema({ type: "object", properties: { target: { type: "string" } }, additionalProperties: false }),
    execute: async () => ({ status: "succeeded", output: { text: "same page" } }),
  };
  const notify = vi.fn(async () => "delivered" as const);
  const manager = new Tasks(path, { prepare: async () => ({ config: { model, tools: [probe] } }), notify, diagnostic: vi.fn(), changed: () => {} });
  await manager.start();
  const task = await manager.create({ channel: "channel-a", session: "first.jsonl" }, "computer", "check the page", "key", [], { timeLimitMinutes: 30 });
  return { manager, task, prompts, offered, notify, transcript: () => readFile(join(path, task.id + ".jsonl"), "utf8") };
}

// User, 2026-11-20: 「超时/步数超了仅提醒主bot（主bot可以结束/延长/sterr等），不强制结束。步数非必要」.
it("keeps a looping task going past its steps, with every tool, until the main conversation ends it", async () => {
  // Like the model in the records: the same look again and again.
  const w = await worker(async (request) => streamOf(toolCall("probe", { target: "page" }, `call-${request}`))());
  await vi.waitFor(() => expect(w.prompts.length).toBeGreaterThan(60), { timeout: 30000 });
  expect(await w.manager.store.get(w.task.id)).toMatchObject({ status: "running" });
  // No request was cut down to the report alone, and the next stretch went on with what was seen before.
  expect(w.offered.every((tools) => tools.includes("probe"))).toBe(true);
  expect(w.prompts.some((prompt) => prompt.includes("3 次用完全相同的参数调用 probe"))).toBe(true);
  expect(w.prompts.some((prompt) => /最后一步|还剩 \d+ 步|时限已到/.test(prompt))).toBe(false);
  expect(w.prompts.at(-1)).toContain("check the page");
  expect(await w.transcript()).toContain("接着上面的进展继续完成委派的工作");
  // The repeat note lives in the request only; the stored history has none of it.
  expect(await w.transcript()).not.toContain("完全相同的参数");
  await w.manager.cancel(w.task.id);
  expect(await w.manager.store.get(w.task.id)).toMatchObject({ status: "cancelled" });
  await w.manager.stop();
}, 60000);

it("reminds a task that stopped without its report, and it reports", async () => {
  const w = await worker(async (request, prompt) => {
    if (request === 1) return streamOf(toolCall("probe", { target: "page" }, "look"))();
    if (!prompt.includes("你还没有调用 task_report")) return streamOf(...words("页面看过了，一切正常。", "a"))();
    return streamOf(toolCall("task_report", { status: "succeeded", result: "页面正常" }, "report"))();
  });
  await vi.waitFor(async () => expect(await w.manager.store.get(w.task.id)).toMatchObject({ status: "succeeded", notification: "delivered" }), {
    timeout: 30000,
  });
  expect((await w.manager.store.get(w.task.id))?.result).toBe("页面正常");
  await w.manager.stop();
});

it("keeps the worker's last words and what it did when it still never reports", async () => {
  const w = await worker(async (request) =>
    request === 1 ? streamOf(toolCall("probe", { target: "page" }, "look"))() : streamOf(...words(`第 ${request} 次：页面正常，komari 已上报。`, "a"))(),
  );
  await vi.waitFor(async () => expect(await w.manager.store.get(w.task.id)).toMatchObject({ status: "failed", notification: "delivered" }), {
    timeout: 30000,
  });
  // One reminder, then the run ends instead of asking again and again.
  expect(w.prompts).toHaveLength(3);
  const result = (await w.manager.store.get(w.task.id))!.result!;
  expect(result).toContain("[task_worker_report_missing]");
  expect(result).toContain("停止前代理一共调用了 1 次工具（probe ×1）");
  expect(result).toContain("代理最后写下的说明（没有通过 task_report 提交，内容未经核实）：\n第 3 次：页面正常，komari 已上报。");
  await w.manager.stop();
});

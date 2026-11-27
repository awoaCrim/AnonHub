import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema, type AgentPlugin } from "@yesimbot/agent-runtime";
import { APICallError } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import { TASK_ERRORS, taskError } from "../src/tasks/errors.js";
import { rejectedTaskReportDraft, taskFailureReason, workerTurnFailed } from "../src/tasks/failure.js";
import { Tasks, type TaskHost } from "../src/tasks/manager.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(prepare: TaskHost["prepare"]) {
  const path = await mkdtemp(join(tmpdir(), "yib-task-report-"));
  directories.push(path);
  const diagnostic = vi.fn(),
    toolFailed = vi.fn();
  const manager = new Tasks(path, { prepare, notify: async () => "delivered", diagnostic, toolFailed, changed() {} });
  await manager.start();
  return { path, diagnostic, toolFailed, manager };
}

function toolStream(name: string, input: unknown, id: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: id, toolName: name, input: JSON.stringify(input) },
      {
        type: "finish" as const,
        finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      },
    ]),
  };
}

function providerError() {
  return new APICallError({
    message: "SECRET_PROVIDER_BODY key=sk-private-provider-value",
    url: "https://private.invalid/v1",
    statusCode: 401,
    responseBody: "SECRET_PROVIDER_BODY",
    requestBodyValues: { secret: "PRIVATE_REQUEST" },
    isRetryable: false,
  });
}

it("rejects malformed report values and oversize fields as correctable local errors before accepting a valid report", async () => {
  const bad: Array<{ input: unknown; code: string }> = [
    { input: null, code: "task_report_input_invalid" },
    { input: [], code: "task_report_input_invalid" },
    { input: { status: "not-a-status", result: "local report only" }, code: "task_report_status_invalid" },
    { input: { status: 12, result: "local report only" }, code: "task_report_status_invalid" },
    { input: { status: "failed", result: 123 }, code: "task_report_result_invalid" },
    { input: { status: "failed", result: " " }, code: "task_report_result_invalid" },
    { input: { status: "failed", result: "x".repeat(12001) }, code: "task_report_result_invalid" },
    { input: { status: "waiting", result: "draft", handoff: 123 }, code: "task_report_handoff_invalid" },
    { input: { status: "waiting", result: "draft", handoff: " " }, code: "task_report_handoff_invalid" },
    { input: { status: "waiting", result: "draft", handoff: "x".repeat(2001) }, code: "task_report_handoff_invalid" },
    { input: { status: "failed", result: "draft", artifacts: "not an array" }, code: "task_report_artifacts_invalid" },
    { input: { status: "failed", result: "draft", artifacts: [123] }, code: "task_report_artifacts_invalid" },
    { input: { status: "failed", result: "draft", artifacts: Array.from({ length: 31 }, () => "asset://location") }, code: "task_report_artifacts_invalid" },
    { input: { status: "failed", result: "draft", artifacts: ["x".repeat(2049)] }, code: "task_report_artifacts_invalid" },
    { input: { status: "failed", result: "draft", extra: true }, code: "task_report_fields_invalid" },
  ];
  let requests = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      if (requests > 0) {
        const previous = bad[requests - 1]!;
        const prompt = JSON.stringify(options.prompt);
        expect(prompt).toContain(previous.code);
        expect(prompt).toContain("not_started");
        expect(prompt).not.toContain("execution_unknown");
      }
      const candidate = bad[requests++];
      const input = candidate ? candidate.input : { status: "succeeded", result: "corrected report", artifacts: ["asset://existing-resource"] };
      return toolStream("task_report", input, "report-value-" + requests);
    },
  });
  const { manager, diagnostic, path } = await fixture(async () => ({ config: { model } }));
  try {
    const task = await manager.create({ channel: "channel", session: "s.jsonl" }, "content", "report actual result", "report-values");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    expect(await manager.store.get(task.id)).toMatchObject({ status: "succeeded", result: "corrected report", artifacts: ["asset://existing-resource"] });
    expect(requests).toBe(bad.length + 1);
    expect(await readFile(join(path, task.id + ".jsonl"), "utf8")).not.toContain("execution_unknown");
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    await manager.stop();
  }
});

it("lets a failed report with an incompatible handoff be corrected without losing failure details or fabricating a handoff", async () => {
  let requests = 0;
  const result = "渲染器已返回 renderer_unavailable，未生成图片；未发送消息。";
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      if (++requests === 2) {
        expect(JSON.stringify(options.prompt)).toContain("handoff_requires_waiting");
        expect(JSON.stringify(options.prompt)).not.toContain("execution_unknown");
      }
      return toolStream("task_report", { status: "failed", result, ...(requests === 1 ? { handoff: "请检查后台服务" } : {}) }, "report-" + requests);
    },
  });
  const { manager, diagnostic, path } = await fixture(async () => ({ config: { model } }));
  try {
    const task = await manager.create({ channel: "channel", session: "s.jsonl" }, "content", "render HTML", "report");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    expect(await manager.store.get(task.id)).toMatchObject({ status: "failed", result });
    expect((await manager.store.get(task.id))?.handoff).toBeUndefined();
    expect(requests).toBe(2);
    const transcript = await readFile(join(path, task.id + ".jsonl"), "utf8");
    expect(transcript).toContain("handoff_requires_waiting");
    expect(transcript).not.toContain("execution_unknown");
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    await manager.stop();
  }
});

// Preview task ac39c981, 2026-11-15: one error inside task_report counted as an operation of unknown outcome, so the
// task ended as unknown and its report was lost.
it("lets the worker report again when task_report itself fails once, without an unknown outcome", async () => {
  let requests = 0,
    failures = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => toolStream("task_report", { status: "succeeded", result: "检查完成" }, "report-" + ++requests),
  });
  const flaky: AgentPlugin = {
    name: "test.flaky-report",
    filterTools: (tools) =>
      tools.map((tool) =>
        tool.name !== "task_report"
          ? tool
          : {
              ...tool,
              execute: (input, context) => {
                if (!failures++) throw new Error("report_store_busy");
                return tool.execute(input, context);
              },
            },
      ),
  };
  const { manager, path, toolFailed } = await fixture(async () => ({ config: { model, plugins: [flaky] } }));
  try {
    const task = await manager.create({ channel: "channel", session: "s.jsonl" }, "computer", "check", "flaky-report");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    expect(await manager.store.get(task.id)).toMatchObject({ status: "succeeded", result: "检查完成" });
    expect(requests).toBe(2);
    expect(await readFile(join(path, task.id + ".jsonl"), "utf8")).not.toContain("execution_unknown");
    expect(toolFailed).toHaveBeenCalledWith(task.id, "task_report", "report_store_busy");
  } finally {
    await manager.stop();
  }
});

it("keeps an unaccepted report as a bounded unverified draft when the correction request fails", async () => {
  let requests = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      if (++requests > 1) throw providerError();
      return toolStream(
        "task_report",
        { status: "failed", result: "已完成文件读取，未能渲染。token=PRIVATE_TOKEN\n" + "未完成部分。".repeat(1000), handoff: "查看内部错误" },
        "bad-report",
      );
    },
  });
  const { manager } = await fixture(async () => ({ config: { model } }));
  try {
    const task = await manager.create({ channel: "channel", session: "s.jsonl" }, "content", "render HTML", "draft");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    const record = (await manager.store.get(task.id))!;
    expect(record.status).toBe("failed");
    expect(record.result).toContain("模型认证失败");
    expect(record.result).toContain("handoff_requires_waiting");
    expect(record.result).toContain("内容未验证");
    expect(record.result).toContain("已完成文件读取，未能渲染");
    expect(record.result!.length).toBeLessThan(2500);
    expect(record.result).not.toMatch(/PRIVATE_TOKEN|SECRET_PROVIDER_BODY|PRIVATE_REQUEST/);
    expect(record.handoff).toBeUndefined();
    expect(requests).toBe(2);
  } finally {
    await manager.stop();
  }
});

it("keeps unknown external effects unknown when a subsequent model request fails, without replaying the operation", async () => {
  let requests = 0;
  const execute = vi.fn(async () => {
    throw new Error("PRIVATE_OPERATION_ERROR");
  });
  const model = new MockLanguageModelV3({
    doStream: async () => {
      if (++requests > 1) throw providerError();
      return toolStream("computer_exec", {}, "external-operation");
    },
  });
  const { manager } = await fixture(async () => ({
    config: { model, tools: [{ name: "computer_exec", inputSchema: jsonSchema({ type: "object", properties: {} }), execute }] },
  }));
  try {
    const task = await manager.create({ channel: "channel", session: "s.jsonl" }, "computer", "execute once", "unknown");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    const record = (await manager.store.get(task.id))!;
    expect(record.status).toBe("unknown");
    expect(record.result).toContain("结果未确认");
    expect(record.result).toContain("模型认证失败");
    expect(record.result).not.toMatch(/PRIVATE_OPERATION_ERROR|SECRET_PROVIDER_BODY|PRIVATE_REQUEST/);
    expect(record.handoff).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toBe(2);
  } finally {
    await manager.stop();
  }
});

it("reports known setup failures with a safe code and keeps arbitrary exception text private", async () => {
  const { manager, diagnostic } = await fixture(async (record) => {
    throw record.key === "known" ? taskError(TASK_ERRORS.task_bot_unavailable) : new Error("PRIVATE_REQUEST token=sk-provider-secret");
  });
  try {
    const known = await manager.create({ channel: "channel", session: "s.jsonl" }, "content", "render", "known");
    const unknown = await manager.create({ channel: "channel", session: "s.jsonl" }, "content", "render", "private");
    await vi.waitFor(async () => expect((await manager.store.get(unknown.id))?.notification).toBe("delivered"));
    expect((await manager.store.get(known.id))?.result).toContain("task_bot_unavailable");
    expect((await manager.store.get(known.id))?.result).toContain("机器人当前不可用");
    expect((await manager.store.get(unknown.id))?.result).toContain("worker_failed");
    expect((await manager.store.get(unknown.id))?.result).not.toMatch(/PRIVATE_REQUEST|sk-provider-secret/);
    expect(diagnostic).toHaveBeenCalledTimes(2);
  } finally {
    await manager.stop();
  }
});

it.each(["waiting", "succeeded"] as const)("records a host-confirmed budget %s report without creating human handoff", async (status) => {
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      expect(options.tools?.map((tool) => tool.name)).toEqual(["task_report"]);
      expect(JSON.stringify(options.prompt)).toContain("内部上下文预算");
      return toolStream(
        "task_report",
        { status, result: "已保存已完成步骤和资源。", ...(status === "waiting" ? { handoff: "请接管电脑后交还" } : {}) },
        "budget-report",
      );
    },
  });
  const { manager, diagnostic } = await fixture(async () => ({ modelLimit: { context: 1024 * 1024, output: 8192 }, config: { model } }));
  try {
    const task = await manager.create({ channel: "channel", session: "s.jsonl" }, "content", "x".repeat(900000), "budget-" + status);
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    const record = (await manager.store.get(task.id))!;
    expect(record.status).toBe(status);
    expect(record.handoff).toBeUndefined();
    if (status === "waiting") {
      expect(record.pauseReason).toBe("context_budget");
      expect(record.result).toContain("无需用户接管");
    } else expect(record.pauseReason).toBeUndefined();
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    await manager.stop();
  }
});

it("uses typed model failure metadata and diagnostic IDs instead of arbitrary diagnostic prose", () => {
  const reason = taskFailureReason(
    workerTurnFailed(
      { name: "ModelRequestError", message: "PRIVATE_MESSAGE", cause: "PRIVATE_CAUSE", modelFailure: "context_limit", status: 413 },
      "diagnostic-123",
    ),
  );
  expect(reason).toContain("模型上下文超出限制");
  expect(reason).toContain("context_limit:413");
  expect(reason).toContain("diagnostic-123");
  expect(reason).not.toMatch(/PRIVATE_MESSAGE|PRIVATE_CAUSE/);
  expect(rejectedTaskReportDraft("已读取输入，未渲染。 https://user:password@example.test/path?token=secret#private Authorization: Bearer abcdefgh")).toBe(
    "已读取输入，未渲染。 https://example.test/path Authorization: [redacted]",
  );
});

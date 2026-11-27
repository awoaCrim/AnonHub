import type { AgentModelRequestContext } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKER_CONTEXT_TOKENS,
  shortenToolResults,
  WORKER_REQUEST_TEXT_BYTES,
  workerInputTokenLimit,
  workerRequestBudget,
} from "../src/tasks/request-budget.js";

function request(messages: readonly ModelMessage[], signal = new AbortController().signal): AgentModelRequestContext {
  return {
    model: new MockLanguageModelV3(),
    system: "Execute only the delegated task.",
    messages,
    tools: {},
    currentMessageIds: ["request"],
    turnId: "turn",
    stepNumber: 0,
    signal,
    rebuildMessages: async () => messages,
  };
}

function textResult(size: number, id = "call"): ModelMessage {
  return { role: "tool", content: [{ type: "tool-result", toolName: "computer_ui", toolCallId: id, output: { type: "text", value: "x".repeat(size) } }] };
}

describe("worker context capacity", () => {
  it("uses the selected model window with output and framing reserves", () => {
    expect(workerInputTokenLimit({ context: 16000, output: 2000 })).toBe(12400);
    expect(workerInputTokenLimit({ context: 1000000, output: 64000 })).toBe(891808);
    expect(workerInputTokenLimit()).toBe(DEFAULT_WORKER_CONTEXT_TOKENS - 8192 - Math.ceil(DEFAULT_WORKER_CONTEXT_TOKENS * 0.1));
  });

  it("does not mistake a 128 KB request for 128K tokens or stop a 14K-token computer task", async () => {
    const budget = workerRequestBudget();
    const initial = request([textResult(140000)]);
    expect(await budget.guard(initial)).toBe(initial.messages);
    budget.observe(14170);
    const next = request([...initial.messages, textResult(24000, "next")]);
    expect(await budget.guard(next)).toBe(next.messages);
    expect(budget.finalizing).toBeUndefined();
  });

  it("uses actual provider usage to reserve a final report near the model limit", async () => {
    const budget = workerRequestBudget({ context: 16000, output: 2000 });
    const current = request([{ role: "user", content: "instruction" }]);
    await budget.guard(current);
    budget.observe(12000);
    const guarded = await budget.guard(current);
    expect(guarded).toMatchObject({ activeTools: ["task_report"] });
    expect(budget.finalizing).toMatchObject({ reason: "context_tokens", estimatedTokens: 12000, inputTokenLimit: 12400 });
    expect(JSON.stringify(guarded)).toContain("不需要用户补充信息或接管电脑");
    // Once saving a report, a shorter next request must not re-enable execution tools.
    budget.observe(100);
    expect(await budget.guard(request([]))).toMatchObject({ activeTools: ["task_report"] });
  });

  it("stops a request that exceeds actual model capacity before calling the provider again", async () => {
    const budget = workerRequestBudget({ context: 16000, output: 2000 });
    const current = request([{ role: "user", content: "instruction" }]);
    await budget.guard(current);
    budget.observe(13000);
    await expect(budget.guard(current)).rejects.toMatchObject({ code: "task_worker_budget_exceeded" });
    expect(budget.finalizing).toMatchObject({ reason: "context_tokens", estimatedTokens: 13000 });
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("does not release new tool-text protection for invalid usage %s", async (usage) => {
    const budget = workerRequestBudget();
    const current = request([textResult(140000)]);
    await budget.guard(current);
    budget.observe(usage);
    await expect(budget.guard(request([...current.messages, textResult(90000, "next")]))).rejects.toMatchObject({ code: "task_worker_budget_exceeded" });
  });

  it("ignores usage from an aborted request", async () => {
    const budget = workerRequestBudget();
    const controller = new AbortController();
    const current = request([textResult(140000)], controller.signal);
    await budget.guard(current);
    controller.abort();
    budget.observe(1000);
    await expect(budget.guard(request([...current.messages, textResult(90000, "next")]))).rejects.toMatchObject({ code: "task_worker_budget_exceeded" });
  });

  it("bounds accumulated text independently of a large model window and cheap measured usage", async () => {
    const budget = workerRequestBudget({ context: 2000000, output: 8192 });
    const current = request([{ role: "user", content: "x".repeat(Math.floor(WORKER_REQUEST_TEXT_BYTES * 0.9)) }]);
    expect(await budget.guard(current)).toMatchObject({ activeTools: ["task_report"] });
    budget.observe(1000);
    await expect(budget.guard(request([{ role: "user", content: "x".repeat(WORKER_REQUEST_TEXT_BYTES) }]))).rejects.toMatchObject({
      code: "task_worker_budget_exceeded",
    });
    expect(budget.finalizing?.reason).toBe("serialized_text");
  });

  it("preserves native images and carries their measured tokens without inflating subsequent text", async () => {
    const budget = workerRequestBudget({ context: 32768, output: 4096 });
    const image: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolName: "computer_ui",
          toolCallId: "screen",
          output: {
            type: "content",
            value: [{ type: "image-data", data: "A".repeat(2 * 1024 * 1024), mediaType: "image/png" }],
          },
        },
      ],
    };
    const current = request([image]);
    expect(await budget.guard(current)).toBe(current.messages);
    budget.observe(10000);
    const next = request([...current.messages, textResult(1500, "observation")]);
    expect(await budget.guard(next)).toBe(next.messages);
    expect(budget.finalizing).toBeUndefined();
    expect(next.messages[0]).toBe(image);
  });
});

// User, 2026-11-20: 「超时/步数超了仅提醒主bot…不强制结束」: older results give way so a task carries on.
describe("older tool results past half the budget", () => {
  const results = (count: number, size = 3000) => Array.from({ length: count }, (_, index) => textResult(size, `call-${index}`));
  const output = (message: ModelMessage) => (message.content as { output: { value: string } }[])[0]!.output.value;

  it("shortens all but the latest ten large results in the request, keeping the task's own history", async () => {
    const budget = workerRequestBudget({ context: 40000, output: 8192 });
    const history = [...results(20), textResult(500, "small")];
    const guarded = (await budget.guard(request(history))) as readonly ModelMessage[];
    expect(Array.isArray(guarded)).toBe(true);
    expect(budget.finalizing).toBeUndefined();
    for (const message of guarded.slice(0, 11)) expect(output(message)).toMatch(/^\[较早的 computer_ui 结果（约 3 KB）已从这次请求中省略/);
    for (const message of guarded.slice(11)) expect(output(message)).not.toContain("已从这次请求中省略");
    expect(output(history[0]!)).toBe("x".repeat(3000));
  });

  it("keeps what it shortened the same from step to step, so the start of the request stays cached", async () => {
    const budget = workerRequestBudget({ context: 40000, output: 8192 });
    const history = results(20);
    const first = (await budget.guard(request(history))) as readonly ModelMessage[];
    // The provider's count for the shortened request, as after every real step.
    budget.observe(9000);
    const second = (await budget.guard(request([...history, textResult(3000, "call-20")]))) as readonly ModelMessage[];
    expect(second.slice(0, 20).map(output)).toEqual(first.map(output));
    expect(output(second[20]!)).toBe("x".repeat(3000));
  });

  it("never shortens small results or anything below half the budget", async () => {
    expect(shortenToolResults(results(20, 1000), 15).every((message, index) => output(message) === "x".repeat(1000) || index > 99)).toBe(true);
    const roomy = workerRequestBudget();
    const history = results(20);
    expect(await roomy.guard(request(history))).toBe(history);
  });
});

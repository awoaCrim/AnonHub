import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema } from "@yesimbot/agent-runtime";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { expect, it, vi } from "vitest";

import { estimateContextValue } from "../src/runtimes/context-budget.js";
import { Tasks } from "../src/tasks/manager.js";

it("continues a measured computer task through repeated large observations and returns its accepted report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-budget-run-"));
  let requests = 0;
  let maxTextBytes = 0;
  let requestFailure: unknown;
  const execute = vi.fn(async () => ({ status: "succeeded", text: "UI observation ".repeat(4000) }));
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      try {
        requests++;
        const names = options.tools?.map((tool) => tool.name);
        expect(
          names,
          `request ${requests}, text ${estimateContextValue(options.prompt)}, budget ${JSON.stringify(options.prompt).includes("本次执行已接近内部上下文预算")}`,
        ).toContain("computer_ui");
        expect(names).toContain("task_report");
        expect(JSON.stringify(options.prompt)).not.toContain("本次执行已接近内部上下文预算");
        maxTextBytes = Math.max(maxTextBytes, estimateContextValue(options.prompt));
        if (requests > 1) {
          const nativeImages = options.prompt
            .filter((message) => message.role === "tool")
            .flatMap((message) => message.content)
            .filter((part) => part.type === "tool-result" && part.output.type === "content")
            .flatMap((part) => (part.type === "tool-result" && part.output.type === "content" ? part.output.value : []))
            .filter((part) => part.type === "image-data");
          expect(nativeImages.length).toBeGreaterThan(0);
        }
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: `step-${requests}`,
              toolName: requests <= 12 ? "computer_ui" : "task_report",
              input: JSON.stringify(requests <= 12 ? {} : { status: "succeeded", result: "已核实浏览器当前状态。" }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: {
                inputTokens: { total: 14000 + requests * 1000 },
                outputTokens: { total: 20 },
              },
            },
          ]),
        };
      } catch (error) {
        requestFailure = error;
        throw error;
      }
    },
  });
  const diagnostic = vi.fn();
  const notify = vi.fn(async () => "delivered" as const);
  const manager = new Tasks(directory, {
    prepare: async () => ({
      modelLimit: { context: 128 * 1024, output: 8192 },
      config: {
        model,
        tools: [
          {
            name: "computer_ui",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute,
            toModelOutput: ({ output }) => ({
              type: "content",
              value: [
                { type: "text", text: JSON.stringify(output) },
                { type: "image-data", data: "AQID".repeat(40000), mediaType: "image/png" },
              ],
            }),
          },
        ],
      },
    }),
    notify,
    diagnostic,
    changed() {},
  });
  try {
    await manager.start();
    const task = await manager.create({ channel: "test", session: "test.jsonl" }, "computer", "核实浏览器当前状态", "budget-regression");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"), { timeout: 5000 });
    if (requestFailure) throw requestFailure;
    expect(await manager.store.get(task.id)).toMatchObject({ status: "succeeded", result: "已核实浏览器当前状态。" });
    expect((await manager.store.get(task.id))?.pauseReason).toBeUndefined();
    expect(requests).toBe(13);
    expect(execute).toHaveBeenCalledTimes(12);
    expect(maxTextBytes).toBeGreaterThan(128 * 1024);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    await manager.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

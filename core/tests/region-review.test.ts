import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { appendUserText, runRegionReview } from "../src/runtimes/region-review.js";

function model(step: (call: number, options: LanguageModelV3CallOptions) => Promise<unknown[]> | unknown[]) {
  const calls: LanguageModelV3CallOptions[] = [];
  const value: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "main",
    supportedUrls: {},
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content: (await step(calls.length, options)) as never,
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 2, cacheRead: 8, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("unexpected stream");
    },
  };
  return { model: value, calls };
}

const remember = { type: "function" as const, inputSchema: jsonSchema({ type: "object" }), execute: vi.fn() };
const call = (id: string, name = "remember") => ({ type: "tool-call", toolCallId: id, toolName: name, input: "{}" });

describe("pre-summary review request", () => {
  it("appends the instruction as a new user message after a tool result", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "x", output: { type: "text", value: "ok" } }] },
    ];
    expect(appendUserText(messages, "TEXT").slice(-2)).toEqual([messages[1], { role: "user", content: "TEXT" }]);
    expect(appendUserText([{ role: "user", content: [{ type: "text", text: "a" }] }], "b")).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
  });

  it("stops at the step limit and reports cached input", async () => {
    const { model: main, calls } = model(() => [call(`c${Math.random()}`)]);
    const execute = vi.fn(async () => ({ saved: true }));
    const outcome = await runRegionReview({
      request: { model: main, system: "S", messages: [{ role: "user", content: "x" }], tools: { remember } },
      review: { instructions: "R", tools: [{ name: "remember", execute }] },
      terminalTools: ["finish"],
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(3);
    expect(outcome).toMatchObject({ status: "done", steps: 3, executed: 3, refused: 0, inputTokens: 30, cachedInputTokens: 24 });
    expect(remember.execute).not.toHaveBeenCalled();
  });

  it("lets a slow request finish and starts no further step after the window", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const { model: main, calls } = model(async (_call, options) => {
      signals.push(options.abortSignal);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return [call("c1")];
    });
    const execute = vi.fn(async () => ({ saved: true }));
    const outcome = await runRegionReview({
      request: { model: main, system: undefined, messages: [{ role: "user", content: "x" }], tools: { remember } },
      review: { instructions: "R", tools: [{ name: "remember", execute }] },
      terminalTools: ["finish"],
      signal: new AbortController().signal,
      stepWindowMs: 10,
    });
    expect(calls).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: "timeout", steps: 1, executed: 1 });
  });

  it("cuts only a request that hangs past the limit, without throwing", async () => {
    const { model: main } = model(
      (_call, options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason));
        }),
    );
    const outcome = await runRegionReview({
      request: { model: main, system: undefined, messages: [{ role: "user", content: "x" }], tools: { remember } },
      review: { instructions: "R", tools: [{ name: "remember", execute: async () => ({}) }] },
      terminalTools: ["finish"],
      signal: new AbortController().signal,
      timeoutMs: 20,
    });
    expect(outcome).toMatchObject({ status: "timeout", steps: 0 });
  });

  it("skips without a model call when no review tool was offered", async () => {
    const { model: main, calls } = model(() => []);
    const outcome = await runRegionReview({
      request: { model: main, system: "S", messages: [], tools: { send_message: remember } },
      review: { instructions: "R", tools: [{ name: "remember", execute: async () => ({}) }] },
      terminalTools: ["finish"],
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});

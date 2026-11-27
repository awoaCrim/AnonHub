import type { LanguageModelV3 } from "@ai-sdk/provider";
import { configureLogging, type LogRecord } from "@yesimbot/foundation";
import { generateText, wrapLanguageModel } from "ai";
import { expect, it, vi } from "vitest";

import {
  consumeModelRetry,
  currentModelRequestContext,
  modelRequestContextMiddleware,
  reportModelUsageDiagnostic,
  withModelRequestContext,
} from "../src/model-request-context.js";

it("isolates concurrent request scopes and never adds correlation metadata to prompts", async () => {
  const observed: unknown[] = [];
  const params: unknown[] = [];
  const base = {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    async doGenerate(input: unknown) {
      params.push(input);
      await Promise.resolve();
      observed.push(currentModelRequestContext());
      return {
        content: [{ type: "text", text: "OK" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: {}, outputTokens: {} },
        warnings: [],
      };
    },
  } as unknown as LanguageModelV3;
  await Promise.all(
    ["a", "b"].map((taskId) =>
      generateText({
        model: wrapLanguageModel({ model: base, middleware: modelRequestContextMiddleware({ sessionId: "private-session", taskId }) }),
        prompt: "hello",
        maxRetries: 0,
      }),
    ),
  );
  expect(observed).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: "a" }), expect.objectContaining({ taskId: "b" })]));
  expect(JSON.stringify(params)).not.toContain("private-session");
  expect(currentModelRequestContext()).toBeUndefined();
});

it("keeps actual upstream usage separate from estimates and suppresses provider metadata", () => {
  vi.stubEnv("YESIMBOT_MODEL_DIAGNOSTICS", "1");
  const records: LogRecord[] = [];
  configureLogging({ sink: (record) => records.push(record) });
  try {
    reportModelUsageDiagnostic(
      { inputTokens: { total: 24 }, outputTokens: { total: 8 }, secret: "provider-private" },
      { requestId: "request-1", sessionId: "private-session" },
    );
    const serialized = JSON.stringify(records);
    expect(serialized).toContain("actualUsage");
    expect(serialized).not.toContain("provider-private");
    expect(serialized).not.toContain("private-session");
    expect(records.find((record) => record.event === "model_usage.actual")).toMatchObject({
      correlation: { requestId: "request-1" },
      actualUsage: { inputTokens: 24, outputTokens: 8 },
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("bounds the shared retry budget", () => {
  const retryBudget = { remaining: 1 };
  withModelRequestContext({ retryBudget }, () => {
    expect(consumeModelRetry()).toBe(true);
    expect(consumeModelRetry()).toBe(false);
  });
  expect(retryBudget.remaining).toBe(0);
});

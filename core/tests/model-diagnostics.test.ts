import { currentModelRequestContext, modelDiagnosticId } from "@yesimbot/agent-runtime";
import { configureLogging, type LogRecord } from "@yesimbot/foundation";
import { generateText } from "ai";
import { expect, it, vi } from "vitest";

import { deriveChannelKey } from "../src/channels/context.js";
import { ModelService } from "../src/models/index.js";

it("correlates actual usage with the same request and session for standalone auxiliary-model calls", async () => {
  const context = { type: "direct", platform: "webui", channelId: "private-channel", selfId: "private-bot", userId: "private-user" } as const;
  const service = new ModelService({ baseDir: "/", emit: () => {} }, { logLevel: 0 });
  let observed: ReturnType<typeof currentModelRequestContext>;
  service.register({
    id: "fixture",
    capabilities: { chat: true, embedding: false },
    chatModels: () => [{ id: "fixture" }],
    embeddingModels: () => [],
    chat: () => ({
      specificationVersion: "v3",
      provider: "fixture",
      modelId: "fixture",
      supportedUrls: {},
      async doGenerate() {
        observed = currentModelRequestContext();
        return {
          content: [{ type: "text", text: "OK" }],
          finishReason: { unified: "stop", raw: "stop" },
          warnings: [],
          usage: { inputTokens: { total: 11 }, outputTokens: { total: 2 } },
        };
      },
      doStream: vi.fn(),
    }),
  });
  const records: LogRecord[] = [];
  configureLogging({ sink: (record) => records.push(record) });
  vi.stubEnv("YESIMBOT_MODEL_DIAGNOSTICS", "1");
  try {
    await generateText({ model: service.resolveChatModel("fixture:fixture", context).model, prompt: "hello", maxRetries: 0 });
    expect(observed?.sessionId).toBe(deriveChannelKey(context));
    const event = records.find((record) => record.event === "model_usage.actual") as unknown as {
      correlation: Record<string, string>;
      actualUsage: unknown;
    };
    expect(event).toMatchObject({
      correlation: { requestId: observed?.requestId, sessionId: modelDiagnosticId(deriveChannelKey(context)) },
      actualUsage: { inputTokens: 11, outputTokens: 2 },
    });
    expect(event.correlation.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(records)).not.toContain("private-");
  } finally {
    vi.unstubAllEnvs();
  }
});

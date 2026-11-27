import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { generateText, streamText } from "ai";
import { expect, it, vi } from "vitest";

import { reasoningRoute, withReasoningOrigin } from "../src/reasoning-origin.js";

it("tags generated reasoning and rejects foreign/unverifiable reasoning while retaining normal text/tools", async () => {
  const doGenerate = vi.fn(async () => ({
    content: [{ type: "reasoning", text: "private", providerMetadata: { anthropic: { signature: "signature" } } }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: { inputTokens: {}, outputTokens: {} },
    warnings: [],
  }));
  const base = { specificationVersion: "v3", provider: "fixture", modelId: "new", supportedUrls: {}, doGenerate } as unknown as LanguageModelV3;
  const model = withReasoningOrigin(base, "connection", "anthropic");
  const params = {
    prompt: [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "old", providerOptions: { yesimbot: { connection: "connection", protocol: "anthropic", model: "old" } } },
          { type: "reasoning", text: "legacy" },
          { type: "text", text: "answer" },
          { type: "tool-call", toolCallId: "call", toolName: "read", input: {} },
        ],
      },
    ],
  } as LanguageModelV3CallOptions;
  const result = await model.doGenerate(params);
  expect(result.content[0]).toMatchObject({
    providerMetadata: { anthropic: { signature: "signature" }, yesimbot: { connection: "connection", protocol: "anthropic", model: "new" } },
  });
  const projected = doGenerate.mock.calls[0]?.[0] as unknown as LanguageModelV3CallOptions;
  expect(JSON.stringify(projected.prompt)).not.toContain('"old"');
  expect(JSON.stringify(projected.prompt)).not.toContain('"legacy"');
  expect(JSON.stringify(projected.prompt)).toContain('"tool-call"');
  expect(params.prompt[0]?.content).toHaveLength(4);
});

it("preserves same-origin signatures through SDK history and strips private metadata after a route change", async () => {
  const calls: LanguageModelV3CallOptions[] = [];
  const base: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    async doGenerate(params) {
      calls.push(params);
      return {
        content: [
          { type: "reasoning", text: "private", providerMetadata: { google: { thoughtSignature: "secret-signature" } } },
          { type: "text", text: "answer", providerMetadata: { openai: { itemId: "cached-item" } } },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: {}, outputTokens: {} },
        warnings: [],
      };
    },
    doStream: vi.fn() as never,
  };
  const same = withReasoningOrigin(base, "connection", "google");
  const first = await generateText({ model: same, prompt: "hello", maxRetries: 0 });
  expect(first.response.messages[0]?.content[0]).toMatchObject({ providerOptions: { yesimbot: { model: "fixture" } } });
  const history = [{ role: "user" as const, content: "hello" }, ...first.response.messages];
  await generateText({ model: same, messages: history, maxRetries: 0 });
  expect(JSON.stringify(calls[1]?.prompt)).toContain("secret-signature");
  for (const changed of [
    withReasoningOrigin(base, "other", "google"),
    withReasoningOrigin(base, "connection", "openai:responses"),
    withReasoningOrigin({ ...base, modelId: "another" }, "connection", "google"),
  ]) {
    await generateText({ model: changed, messages: history, maxRetries: 0 });
    const sent = JSON.stringify(calls.at(-1)?.prompt);
    expect(sent).not.toContain("secret-signature");
    expect(sent).not.toContain("cached-item");
    expect(sent).toContain("answer");
  }
});

it("tags streamed text and reasoning without losing native metadata", async () => {
  const base: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "fixture",
    supportedUrls: {},
    doGenerate: vi.fn() as never,
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "reasoning-start", id: "r" });
            controller.enqueue({ type: "reasoning-delta", id: "r", delta: "private" });
            controller.enqueue({ type: "reasoning-end", id: "r", providerMetadata: { anthropic: { signature: "native" } } });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "answer" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} } });
            controller.close();
          },
        }),
      };
    },
  };
  const result = streamText({ model: withReasoningOrigin(base, "conn", "anthropic"), prompt: "hello", maxRetries: 0 });
  await result.consumeStream();
  const messages = (await result.response).messages;
  expect(messages[0]?.content[0]).toMatchObject({
    type: "reasoning",
    providerOptions: { anthropic: { signature: "native" }, yesimbot: { connection: "conn" } },
  });
  expect(messages[0]?.content[1]).toMatchObject({ type: "text", providerOptions: { yesimbot: { connection: "conn" } } });
});

it("invalidates private state when the destination or account changes under the same connection ID", async () => {
  const original = reasoningRoute({ baseURL: "https://same.example/v1/", apiKey: "private-original-key" });
  expect(original).toBe(reasoningRoute({ baseURL: "https://same.example/v1", apiKey: "private-original-key" }));
  expect(original).not.toContain("private");
  const doGenerate = vi.fn(async () => ({
    content: [{ type: "text", text: "OK" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: {}, outputTokens: {} },
    warnings: [],
  }));
  const base = { specificationVersion: "v3", provider: "fixture", modelId: "fixture", supportedUrls: {}, doGenerate } as unknown as LanguageModelV3;
  for (const route of [
    reasoningRoute({ baseURL: "https://other.example/v1", apiKey: "private-original-key" }),
    reasoningRoute({ baseURL: "https://same.example/v1", apiKey: "private-new-key" }),
  ]) {
    await withReasoningOrigin(base, "connection", "google", route).doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "private",
              providerOptions: {
                yesimbot: { connection: "connection", protocol: "google", model: "fixture", route: original },
                google: { thoughtSignature: "old" },
              },
            },
            { type: "text", text: "normal" },
          ],
        },
      ],
    });
    expect(JSON.stringify(doGenerate.mock.lastCall?.[0])).not.toContain("private");
    expect(JSON.stringify(doGenerate.mock.lastCall?.[0])).toContain("normal");
  }
});

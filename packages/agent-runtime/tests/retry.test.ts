import type { LanguageModelV3, LanguageModelV3FinishReason, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createAgent } from "../src/agent.js";
import { createUserMessage } from "../src/message.js";

function retryableError(statusCode = 429, isRetryable = true, retryImmediately = true): APICallError {
  return new APICallError({
    message: `fixture ${statusCode}`,
    url: "https://fixture.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: retryImmediately ? { "retry-after": "0" } : undefined,
    isRetryable,
  });
}

function networkError(cause: unknown, isRetryable = true, retryImmediately = true): APICallError {
  return new APICallError({
    message: "Cannot connect to API",
    url: "https://fixture.invalid/v1/chat/completions",
    requestBodyValues: {},
    cause,
    responseHeaders: retryImmediately ? { "retry-after": "0" } : undefined,
    isRetryable,
  });
}

function socketError(code = "UND_ERR_SOCKET"): Error {
  return Object.assign(new Error("other side closed"), { code });
}

function textStream(text = "ok"): ReadableStream<LanguageModelV3StreamPart> {
  const finishReason = "stop" as unknown as LanguageModelV3FinishReason;
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "text" });
      controller.enqueue({ type: "text-delta", id: "text", delta: text });
      controller.enqueue({ type: "text-end", id: "text" });
      controller.enqueue({
        type: "finish",
        finishReason,
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      });
      controller.close();
    },
  });
}

function toolCallStream(): ReadableStream<LanguageModelV3StreamPart> {
  const finishReason = "tool-calls" as unknown as LanguageModelV3FinishReason;
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "tool-input-start", id: "side-effect-1", toolName: "side_effect" });
      controller.enqueue({ type: "tool-input-delta", id: "side-effect-1", delta: "{}" });
      controller.enqueue({ type: "tool-input-end", id: "side-effect-1" });
      controller.enqueue({ type: "tool-call", toolCallId: "side-effect-1", toolName: "side_effect", input: "{}" });
      controller.enqueue({
        type: "finish",
        finishReason,
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 } },
      });
      controller.close();
    },
  });
}

function createFailThenSucceedModel(failures: number, error: unknown = retryableError()) {
  let attempts = 0;
  const model = {
    specificationVersion: "v3",
    provider: "fixture",
    modelId: "retry-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream() {
      attempts += 1;
      if (attempts <= failures) throw error;
      return { stream: textStream() };
    },
  } as unknown as LanguageModelV3;
  return { model, attempts: () => attempts };
}

async function userMessageCount(agent: ReturnType<typeof createAgent>): Promise<number> {
  return (await agent.storage.read()).filter((entry) => entry.type === "message" && entry.data.role === "user").length;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("main model retries", () => {
  it("does not retry an HTTP 429 quota failure or expose provider request data", async () => {
    const failure = new APICallError({
      message: "secret-provider-body",
      url: "https://fixture.invalid",
      requestBodyValues: { secret: true },
      statusCode: 429,
      isRetryable: true,
      data: { error: { code: "insufficient_quota" } },
    });
    const source = createFailThenSucceedModel(1, failure);
    const agent = createAgent({ model: source.model, maxRetries: 3 });
    const streamErrors: unknown[] = [];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    agent.channel.subscribe("stream", (part) => {
      if (part.type === "error") streamErrors.push(part.error);
    });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));
    expect(source.attempts()).toBe(1);
    expect(JSON.stringify(events)).toContain("quota");
    expect(JSON.stringify(events)).not.toContain("secret-provider-body");
    expect(JSON.stringify(streamErrors)).not.toContain("secret-provider-body");
    expect(log).not.toHaveBeenCalled();
    const last = events.at(-1);
    expect(last?.type === "turn.failed" && last.error.requestId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it.each([408, 429, 500, 502, 503, 504, 529])("retries transient HTTP %s without persisting the user message again", async (statusCode) => {
    const fixture = createFailThenSucceedModel(2, retryableError(statusCode));
    const agent = createAgent({ model: fixture.model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

    expect(fixture.attempts()).toBe(3);
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(await userMessageCount(agent)).toBe(1);
  });

  it.each([retryableError(), retryableError(503), networkError(socketError())])(
    "exhausts three retries after four total attempts for $message",
    async (error) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY, error);
      const agent = createAgent({ model: fixture.model, maxRetries: 3 });
      const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

      expect(fixture.attempts()).toBe(4);
      expect(events.at(-1)?.type).toBe("turn.failed");
      expect(await userMessageCount(agent)).toBe(1);
      expect((await agent.storage.read()).filter((entry) => entry.type === "event" && entry.data.type === "turn.failed")).toHaveLength(1);
    },
  );

  it.each([retryableError(), retryableError(503), networkError(socketError())])(
    "keeps the default at zero and bounds excessive retry configuration to five: $message",
    async (error) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const defaultFixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY, error);
      const defaultAgent = createAgent({ model: defaultFixture.model });
      const defaultEvents = await Array.fromAsync(defaultAgent.run(createUserMessage("default")));
      expect(defaultEvents.at(-1)?.type).toBe("turn.failed");
      expect(defaultFixture.attempts()).toBe(1);

      const boundedFixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY, error);
      const boundedAgent = createAgent({ model: boundedFixture.model, maxRetries: 99 });
      const boundedEvents = await Array.fromAsync(boundedAgent.run(createUserMessage("bounded")));
      expect(boundedEvents.at(-1)?.type).toBe("turn.failed");
      expect(boundedFixture.attempts()).toBe(6);
    },
  );

  it.each([
    [408, false],
    [429, false],
    [503, false],
    [400, true],
    [401, true],
    [403, true],
    [404, true],
    [409, true],
    [422, true],
    [600, true],
  ] as const)("does not retry HTTP %s with provider retryable=%s", async (statusCode, isRetryable) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY, retryableError(statusCode, isRetryable));
    const agent = createAgent({ model: fixture.model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

    expect(fixture.attempts()).toBe(1);
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ])("retries SDK network failures with code %s", async (code) => {
    const fixture = createFailThenSucceedModel(1, networkError(socketError(code)));
    const agent = createAgent({ model: fixture.model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

    expect(fixture.attempts()).toBe(2);
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(await userMessageCount(agent)).toBe(1);
  });

  it.each([new DOMException("request timed out", "TimeoutError"), new TypeError("fetch failed", { cause: socketError("ECONNREFUSED") })])(
    "retries a known nested connection or timeout failure: $name",
    async (cause) => {
      const fixture = createFailThenSucceedModel(1, networkError(cause));
      const agent = createAgent({ model: fixture.model, maxRetries: 3 });
      const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

      expect(fixture.attempts()).toBe(2);
      expect(events.at(-1)?.type).toBe("turn.done");
    },
  );

  it.each([
    networkError(socketError(), false),
    networkError(new Error("unknown transport failure")),
    networkError(socketError("ENOTFOUND")),
    networkError(socketError("CERT_HAS_EXPIRED")),
    networkError(new DOMException("cancelled", "AbortError")),
    networkError(Object.assign(new Error("cancelled"), { name: "ResponseAborted", code: "ECONNRESET" })),
    networkError(Object.assign(new Error("cancelled"), { name: "AbortError", code: "ECONNRESET" })),
    networkError(Object.assign(new Error("connection reset", { cause: new DOMException("cancelled", "AbortError") }), { code: "ECONNRESET" })),
    networkError(
      Object.assign(new Error("timed out", { cause: Object.assign(new Error("cancelled"), { name: "ResponseAborted" }) }), { name: "TimeoutError" }),
    ),
    networkError(undefined),
    new Error("unknown model failure"),
  ])("does not retry permanent, cancelled or unclassified failures: $message", async (error) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY, error);
    const agent = createAgent({ model: fixture.model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

    expect(fixture.attempts()).toBe(1);
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  it("backs off exponentially for a temporary connection failure", async () => {
    vi.useFakeTimers();
    const fixture = createFailThenSucceedModel(2, networkError(socketError(), true, false));
    const agent = createAgent({ model: fixture.model, maxRetries: 3 });
    const events = Array.fromAsync(agent.run(createUserMessage("hello")));
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.attempts()).toBe(1);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fixture.attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.attempts()).toBe(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(fixture.attempts()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);

    expect((await events).at(-1)?.type).toBe("turn.done");
    expect(fixture.attempts()).toBe(3);
  });

  it.each([retryableError(429, true, false), retryableError(503, true, false), networkError(socketError(), true, false)])(
    "aborts during retry backoff without issuing another provider call: $message",
    async (error) => {
      vi.useFakeTimers();
      const fixture = createFailThenSucceedModel(Number.POSITIVE_INFINITY, error);
      const agent = createAgent({ model: fixture.model, maxRetries: 3 });
      const events = Array.fromAsync(agent.run(createUserMessage("hello")));
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.attempts()).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      await agent.interrupt("cancel retry");
      await vi.advanceTimersByTimeAsync(60_000);

      expect((await events).at(-1)?.type).toBe("turn.aborted");
      expect(fixture.attempts()).toBe(1);
      expect(await userMessageCount(agent)).toBe(1);
    },
  );

  it.each([false, true])("retries an unfinished response stream with partial text=%s", async (partialText) => {
    let modelCalls = 0;
    const fixture = createFailThenSucceedModel(0);
    const model = {
      ...fixture.model,
      async doStream() {
        modelCalls += 1;
        if (modelCalls > 1) return { stream: textStream("complete") };
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (partialText) {
                controller.enqueue({ type: "text-start", id: "partial" });
                controller.enqueue({ type: "text-delta", id: "partial", delta: "discard this response" });
              }
              controller.enqueue({ type: "error", error: networkError(socketError()) });
              controller.close();
            },
          }),
        };
      },
    };
    const agent = createAgent({ model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));

    expect(modelCalls).toBe(2);
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(events.filter((event) => event.type === "turn.delta").map((event) => event.delta)).toEqual(["complete"]);
    expect(await userMessageCount(agent)).toBe(1);
  });

  it.each(["error-part", "reader-error", "incomplete"])("recovers an actual terminated stream: %s", async (mode) => {
    vi.useFakeTimers();
    const error = new TypeError("terminated", { cause: socketError() });
    const fixture = createFailThenSucceedModel(0);
    let attempts = 0;
    const model = {
      ...fixture.model,
      async doStream() {
        if (++attempts > 1) return { stream: textStream() };
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              if (mode === "reader-error") return controller.error(error);
              controller.enqueue({ type: "text-start", id: "partial" });
              controller.enqueue({ type: "text-delta", id: "partial", delta: "discard" });
              if (mode === "error-part") controller.enqueue({ type: "error", error });
              controller.close();
            },
          }),
        };
      },
    };
    const agent = createAgent({ model, maxRetries: 3 });
    const events = Array.fromAsync(agent.run(createUserMessage("hello")));
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await events).at(-1)?.type).toBe("turn.done");
    expect(attempts).toBe(2);
  });

  it("shares the retry budget between request and stream failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = createFailThenSucceedModel(0);
    let attempts = 0;
    const model = {
      ...fixture.model,
      async doStream() {
        attempts += 1;
        if (attempts % 2 === 1) throw retryableError(503);
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
              c.enqueue({ type: "error", error: networkError(socketError()) });
              c.close();
            },
          }),
        };
      },
    };
    const agent = createAgent({ model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));
    expect(attempts).toBe(4);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    expect(await userMessageCount(agent)).toBe(1);
  });

  it("discards uncommitted tool calls without executing them on a failed stream", async () => {
    const fixture = createFailThenSucceedModel(0);
    let attempts = 0;
    const sideEffect = vi.fn(async () => ({ ok: true }));
    const model = {
      ...fixture.model,
      async doStream() {
        if (++attempts > 1) return { stream: textStream() };
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(c) {
              c.enqueue({ type: "tool-call", toolCallId: "discard", toolName: "side_effect", input: "{}" });
              c.enqueue({ type: "error", error: networkError(socketError()) });
              c.close();
            },
          }),
        };
      },
    };
    const agent = createAgent({ model, maxRetries: 3, tools: [{ name: "side_effect", inputSchema: z.object({}), execute: sideEffect }] });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(attempts).toBe(2);
    expect(sideEffect).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "tool.start")).toBe(false);
  });

  it("cancels a pending buffered read without a retry or leaked provider stream", async () => {
    const fixture = createFailThenSucceedModel(0);
    const cancel = vi.fn();
    const opened = Promise.withResolvers<void>();
    let attempts = 0;
    const model = {
      ...fixture.model,
      async doStream() {
        attempts += 1;
        opened.resolve();
        return { stream: new ReadableStream<LanguageModelV3StreamPart>({ cancel }) };
      },
    };
    const agent = createAgent({ model, maxRetries: 3 });
    const events = Array.fromAsync(agent.run(createUserMessage("hello")));
    await opened.promise;
    await agent.interrupt("stop");
    expect((await events).at(-1)?.type).toBe("turn.aborted");
    expect(attempts).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["limit", "finish", "provider-effect"])("never replays a committed stream after %s", async (boundary) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = createFailThenSucceedModel(0);
    let attempts = 0;
    const model = {
      ...fixture.model,
      async doStream() {
        attempts += 1;
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            async start(c) {
              if (boundary === "finish") {
                for await (const part of textStream()) c.enqueue(part);
              } else if (boundary === "provider-effect") {
                c.enqueue({ type: "tool-input-start", id: "remote", toolName: "remote", providerExecuted: true });
              } else {
                c.enqueue({ type: "text-start", id: "large" });
                c.enqueue({ type: "text-delta", id: "large", delta: "x".repeat(4 * 1024 * 1024) });
              }
              c.enqueue({ type: "error", error: networkError(socketError()) });
              c.close();
            },
          }),
        };
      },
    };
    const agent = createAgent({ model, maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("hello")));
    expect(events.some((event) => event.type === "turn.failed")).toBe(true);
    expect(events.some((event) => event.type === "turn.done")).toBe(false);
    expect(attempts).toBe(1);
  });

  it.each([retryableError(401), networkError(new DOMException("cancelled", "AbortError")), new Error("unknown")])(
    "does not retry permanent, cancelled or unknown stream errors: $message",
    async (error) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fixture = createFailThenSucceedModel(0);
      let attempts = 0;
      const model = {
        ...fixture.model,
        async doStream() {
          attempts += 1;
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(c) {
                c.enqueue({ type: "error", error });
                c.close();
              },
            }),
          };
        },
      };
      const agent = createAgent({ model, maxRetries: 3 });
      const events = await Array.fromAsync(agent.run(createUserMessage("hello")));
      expect(events.at(-1)?.type).toBe("turn.failed");
      expect(attempts).toBe(1);
    },
  );

  it.each([retryableError(), retryableError(503), networkError(socketError())])(
    "retries only the failed model step without replaying a completed tool: $message",
    async (error) => {
      let modelCalls = 0;
      let sideEffects = 0;
      const prepareRequest = vi.fn(async () => {});
      const model = {
        specificationVersion: "v3",
        provider: "fixture",
        modelId: "retry-model",
        supportedUrls: {},
        async doGenerate() {
          throw new Error("not implemented");
        },
        async doStream() {
          modelCalls += 1;
          if (modelCalls === 1) return { stream: toolCallStream() };
          if (modelCalls === 2)
            return {
              stream: new ReadableStream<LanguageModelV3StreamPart>({
                start(c) {
                  c.enqueue({ type: "error", error });
                  c.close();
                },
              }),
            };
          return { stream: textStream("done") };
        },
      } as unknown as LanguageModelV3;
      const agent = createAgent({
        model,
        maxRetries: 3,
        beforeModelRequest: prepareRequest,
        tools: [
          {
            name: "side_effect",
            inputSchema: z.object({}),
            execute: async () => {
              sideEffects += 1;
              return { ok: true };
            },
          },
        ],
      });

      const events = await Array.fromAsync(agent.run(createUserMessage("hello")));
      const messages = (await agent.storage.read()).filter((entry) => entry.type === "message").map((entry) => entry.data);

      expect(events.at(-1)?.type).toBe("turn.done");
      expect(modelCalls).toBe(3);
      expect(sideEffects).toBe(1);
      expect(prepareRequest).toHaveBeenCalledTimes(2);
      expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(messages.filter((message) => message.role === "tool")).toHaveLength(1);
    },
  );
});

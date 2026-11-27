import { createServer } from "node:http";

import { withModelRequestContext } from "@yesimbot/agent-runtime";
import { configureLogging, type LogRecord } from "@yesimbot/foundation";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyModelFailure, modelTransport, type RequestDiagnostic } from "../src/transport.js";
import { diagnosticObserver } from "../src/transport.js";

afterEach(() => vi.restoreAllMocks());
describe("model transport", () => {
  it("uses one explicit metadata fallback and remembers it per model without touching generation controls", async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      bodies.push(body);
      res.setHeader("content-type", "application/json");
      res.setHeader("x-request-id", "upstream-123");
      if (body.stream_options) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { param: "stream_options", message: "Unknown parameter" } }));
      } else res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const events: RequestDiagnostic[] = [];
    const request = modelTransport(fetch, "fixture", (event) => events.push(event));
    const options = {
      method: "POST",
      body: JSON.stringify({
        model: "fixture",
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "SECRET" }],
        temperature: 0.3,
        max_tokens: 100,
        reasoning_effort: "high",
        tools: [],
      }),
    };
    try {
      expect((await request(`http://127.0.0.1:${address.port}`, options)).ok).toBe(true);
      expect((await request(`http://127.0.0.1:${address.port}`, options)).ok).toBe(true);
      expect(bodies).toHaveLength(3);
      expect(bodies[1]).toMatchObject({ temperature: 0.3, max_tokens: 100, reasoning_effort: "high" });
      expect(bodies[1]).not.toHaveProperty("stream_options");
      expect(events[0]).toMatchObject({ compatibility: "omit_usage_metadata", status: 400 });
      expect(events[1]).toMatchObject({ upstreamRequestId: "upstream-123" });
      expect(JSON.stringify(events)).not.toContain("SECRET");
      expect(events[0]?.largestMessage?.index).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  it.each([401, 429, 503])("does not independently retry HTTP %s", async (status) => {
    const fetcher = vi.fn(async () => Response.json({ error: { message: "stream_options unsupported" } }, { status }));
    const response = await modelTransport(fetcher, "fixture")("https://fixture.invalid", { body: JSON.stringify({ stream_options: { include_usage: true } }) });
    expect(response.status).toBe(status);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never removes thinking or mixed stream settings on an error", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { param: "reasoning_effort" } }, { status: 400 }));
    const request = modelTransport(fetcher, "fixture");
    await request("https://fixture.invalid", { body: JSON.stringify({ reasoning_effort: "high" }) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await request("https://fixture.invalid", { body: JSON.stringify({ stream_options: { include_usage: true, user_required: true } }) });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("classifies errors without provider prose", () => {
    expect(classifyModelFailure(400, "context_length_exceeded")).toBe("context_limit");
    expect(classifyModelFailure(429, "insufficient_quota")).toBe("quota");
    expect(classifyModelFailure(401)).toBe("authentication");
  });
  it("does not mistake an unrelated 400 or a known parameter with a bad value for an unsupported optional field", async () => {
    for (const error of [
      { param: "stream_options", message: "Invalid value" },
      { param: "other", message: "Unknown parameter" },
    ]) {
      const fetcher = vi.fn(async () => Response.json({ error }, { status: 400 }));
      await modelTransport(fetcher, "conn")("https://fixture.invalid", { body: JSON.stringify({ stream_options: { include_usage: true } }) });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("consumes the shared retry budget only for explicit compatibility and never retries a fallback failure", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { param: "stream_options", message: "Unknown parameter" } }, { status: 400 }));
    const transport = modelTransport(fetcher, "conn");
    const retryBudget = { remaining: 1 };
    const response = await withModelRequestContext({ retryBudget }, () =>
      transport("https://fixture.invalid", { body: JSON.stringify({ stream_options: { include_usage: true } }) }),
    );
    expect(response.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(retryBudget.remaining).toBe(0);
    const none = vi.fn(async () => Response.json({ error: { param: "stream_options", message: "Unknown parameter" } }, { status: 400 }));
    await withModelRequestContext({ retryBudget: { remaining: 0 } }, () =>
      modelTransport(none, "conn")("https://different.invalid", { body: JSON.stringify({ stream_options: { include_usage: true } }) }),
    );
    expect(none).toHaveBeenCalledTimes(1);
  });
  it("is opt-in and reports only bounded metadata, hashed scope, request IDs and sizes", async () => {
    const records: LogRecord[] = [];
    configureLogging({ sink: (record) => records.push(record) });
    const request = modelTransport(
      async () => Response.json({ ok: true }, { headers: { "x-request-id": "up-123" } }),
      "secret-connection",
      diagnosticObserver("secret-connection"),
    );
    const options = {
      body: JSON.stringify({
        model: "secret-model",
        messages: [
          { role: "user", content: "secret-prompt" },
          { role: "tool", content: "secret-tool-output" },
        ],
        tools: [{ secret: "secret-schema" }],
      }),
    };
    vi.stubEnv("YESIMBOT_MODEL_DIAGNOSTICS", "0");
    await request("https://secret-address.invalid?key=secret-key", options);
    expect(records).toEqual([]);
    vi.stubEnv("YESIMBOT_MODEL_DIAGNOSTICS", "1");
    await withModelRequestContext({ sessionId: "secret-session", taskId: "secret-task", turnId: "secret-turn", requestId: "request-fixture" }, () =>
      request("https://secret-address.invalid?key=secret-key", options),
    );
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("secret-");
    const record = records.find((entry) => entry.event === "model_request.diagnostic") as unknown as RequestDiagnostic;
    expect(record).toMatchObject({
      request: "request-fixture",
      upstreamRequestId: "up-123",
      largestToolResult: { messageIndex: 1 },
      estimatedTokens: { method: "serialized_bytes_div_4" },
    });
    expect(record.sections.messages).toBeGreaterThan(0);
    expect(record.correlation.taskId).toHaveLength(16);
    vi.unstubAllEnvs();
  });
});

import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import { describe, expect, it, vi } from "vitest";

import { explicitResponsesStreamFetch } from "../src/openai.js";

describe("Responses stream mode", () => {
  it("makes SDK generateText explicitly non-streaming for gateways that otherwise return SSE", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.stream !== false) return new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
      return Response.json({
        id: "resp_test",
        created_at: 1,
        model: "fixture",
        status: "completed",
        output: [{ type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const client = createOpenAI({ apiKey: "fixture", fetch: explicitResponsesStreamFetch(fetcher) });
    const result = await generateText({ model: client.responses("fixture"), prompt: "Reply OK.", maxRetries: 0 });
    expect(result.text).toBe("OK");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ stream: false, model: "fixture" });
  });

  it("keeps SDK streaming calls streaming", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
    const client = createOpenAI({ apiKey: "fixture", fetch: explicitResponsesStreamFetch(fetcher) });
    await streamText({ model: client.responses("fixture"), prompt: "Reply OK.", maxRetries: 0 }).consumeStream();
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).stream).toBe(true);
  });

  it("does not modify Chat Completions or explicit flags", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
    const wrapped = explicitResponsesStreamFetch(fetcher);
    for (const [path, body] of [
      ["chat/completions", '{"model":"fixture"}'],
      ["responses", '{"stream":false}'],
      ["responses", '{"stream":true}'],
    ]) {
      const init = { method: "POST", body };
      await wrapped(`https://example.com/v1/${path}`, init);
      expect(fetcher.mock.lastCall?.[1]).toBe(init);
    }
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";

import { createOpenAI } from "@ai-sdk/openai";
import { expect, it } from "vitest";

import { createAgent } from "../../../packages/agent-runtime/src/agent.js";
import { createUserMessage } from "../../../packages/agent-runtime/src/message.js";

it.each(["chat", "responses"] as const)("retries a real interrupted HTTP 200 SSE response via OpenAI %s", async (api) => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain the local fixture request */
    }
    const attempt = ++requests;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const write = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const text = attempt === 1 ? "discarded partial response" : "recovered";
    if (api === "chat") {
      write({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      });
    } else {
      write({ type: "response.created", response: { id: "fixture", created_at: 1, model: "fixture", service_tier: null } });
      write({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg", role: "assistant", content: [] } });
      write({ type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: text });
    }
    if (attempt === 1) {
      // Headers and partial data arrive first; the socket then closes without a finish event.
      await setTimeout(30);
      res.destroy();
      return;
    }
    if (api === "chat") {
      write({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    } else {
      write({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
      });
      write({
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
          reasoning: null,
          service_tier: null,
        },
      });
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createOpenAI({ apiKey: "local-fixture", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    const agent = createAgent({ model: api === "chat" ? client.chat("fixture") : client.responses("fixture"), maxRetries: 3 });
    const events = await Array.fromAsync(agent.run(createUserMessage("fixture")));
    expect(requests).toBe(2);
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(events.filter((event) => event.type === "turn.delta").map((event) => event.delta)).toEqual(["recovered"]);
    expect((await agent.storage.read()).filter((entry) => entry.type === "message" && entry.data.role === "user")).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

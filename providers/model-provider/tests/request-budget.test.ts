import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createOpenAI } from "@ai-sdk/openai";
import { createAgent, createUserMessage } from "@yesimbot/agent-runtime";
import { expect, it } from "vitest";

import { modelTransport } from "../src/transport.js";

it.each([0, 1, 2])("shares a real HTTP compatibility fallback with the existing SDK retry budget of %s", async (maxRetries) => {
  let calls = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body: Record<string, unknown> = JSON.parse(raw);
    bodies.push(body);
    calls++;
    res.setHeader("retry-after", "0");
    if (body.stream_options) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unknown parameter: stream_options", param: "stream_options" } }));
    } else if (calls === 2) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream unavailable" } }));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: unknown) => ({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      });
      res.end(`data: ${JSON.stringify(chunk({ role: "assistant", content: "OK" }, null))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createOpenAI({
      apiKey: "fixture",
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      fetch: modelTransport(fetch, "fixture"),
    });
    const events = await Array.fromAsync(createAgent({ model: client.chat("fixture"), maxRetries }).run(createUserMessage("hello")));
    expect(calls).toBe(maxRetries + 1);
    expect(events.at(-1)?.type).toBe(maxRetries === 2 ? "turn.done" : "turn.failed");
    if (maxRetries > 0) expect(bodies[1]).not.toHaveProperty("stream_options");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

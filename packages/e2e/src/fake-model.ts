import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type ToolCall = { readonly name: string; readonly input: Record<string, unknown> };

/** What the fake model answers: tool calls, or plain text. */
export type ModelStep = { readonly toolCalls: readonly ToolCall[] } | { readonly text: string };

export type ModelScript = (request: ModelRequest) => ModelStep;

/** One request the host made to the model service, OpenAI Chat Completions format. */
export interface ModelRequest {
  readonly model: string;
  readonly stream: boolean;
  readonly messages: ReadonlyArray<{ role: string; content?: unknown; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>;
  readonly tools: ReadonlyArray<{ function: { name: string; parameters?: { properties?: Record<string, unknown> } } }>;
  /** Everything the model was shown, as one string, for `toContain` checks. */
  readonly prompt: string;
}

/**
 * An OpenAI-compatible model service on loopback. By default it answers every conversation turn by sending `reply`
 * once through `send_message` and then calling `finish`; tests replace `script` for other behaviour.
 */
export class FakeModel {
  readonly requests: ModelRequest[] = [];
  script: ModelScript = replyOnce("好的");
  /** The input size every answer reports as its usage (what Magic Context measures against its trigger). */
  promptTokens = 10;
  /** Tool call IDs stay unique for the server's lifetime, as real providers' are. */
  private callCounter = 0;
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeModel> {
    let model!: FakeModel;
    const server = createServer((request, response) => void model.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    model = new FakeModel(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
    return model;
  }

  /** Requests from conversation turns (they offer `send_message`), not background helpers. */
  turns(): ModelRequest[] {
    return this.requests.filter((request) => request.tools.some((tool) => tool.function.name === "send_message"));
  }

  /**
   * The prompt of the first conversation-turn request whose current message contains `text`. The previous turn's last
   * step can still arrive after its reply, so a turn is told apart by its message, never by position.
   */
  promptFor(text: string): string | undefined {
    return this.turns()
      .map((turn) => turn.prompt)
      .find((prompt) => prompt.includes(`[CURRENT_MESSAGE]\\n${text}`));
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"not found"}}');
      return;
    }
    const parsed = JSON.parse(body) as { model: string; stream?: boolean; messages: ModelRequest["messages"]; tools?: ModelRequest["tools"] };
    const entry: ModelRequest = {
      model: parsed.model,
      stream: !!parsed.stream,
      messages: parsed.messages,
      tools: parsed.tools ?? [],
      prompt: JSON.stringify(parsed.messages),
    };
    this.requests.push(entry);
    let step: ModelStep;
    try {
      step = this.script(entry);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: String(error) } }));
      return;
    }
    const id = `chatcmpl-${this.requests.length}`;
    const usage = { prompt_tokens: this.promptTokens, completion_tokens: 5, total_tokens: this.promptTokens + 5 };
    const toolCalls =
      "toolCalls" in step
        ? step.toolCalls.map((call, index) => ({
            index,
            id: `call_${++this.callCounter}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          }))
        : undefined;
    const finish = toolCalls ? "tool_calls" : "stop";
    if (!entry.stream) {
      const message = toolCalls
        ? { role: "assistant", content: null, tool_calls: toolCalls.map(({ index: _index, ...call }) => call) }
        : { role: "assistant", content: (step as { text: string }).text };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id, object: "chat.completion", created: 1, model: parsed.model, choices: [{ index: 0, message, finish_reason: finish }], usage }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: parsed.model, choices, ...extra })}\n\n`);
    chunk([
      {
        index: 0,
        delta: toolCalls ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: (step as { text: string }).text },
        finish_reason: null,
      },
    ]);
    chunk([{ index: 0, delta: {}, finish_reason: finish }], { usage });
    response.end("data: [DONE]\n\n");
  }
}

/** The input that started this turn, as the model saw it (the user message marked `[CURRENT_MESSAGE]`). */
export function currentMessage(request: ModelRequest): string {
  const index = currentIndex(request);
  if (index < 0) return "";
  const content = request.messages[index]!.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

/** Whether the tool `name` was already called after the input that started this turn. */
export function calledThisTurn(request: ModelRequest, name: string): boolean {
  const start = currentIndex(request);
  return request.messages.some(
    (message, index) => index > start && message.role === "assistant" && (message.tool_calls ?? []).some((call) => call.function.name === name),
  );
}

/** Whether `send_message` was already called after the input that started this turn. */
export function sentThisTurn(request: ModelRequest): boolean {
  return calledThisTurn(request, "send_message");
}

/**
 * Sends `text` once per turn, then finishes. Picks the `send_message` shape the host offers: chat platforms take
 * `parts`, the web chat takes `messages`.
 */
export function replyOnce(text: string | ((request: ModelRequest) => string)): ModelScript {
  return (request) => {
    // The host appends reminders after tool results, so the last message says nothing about progress.
    if (sentThisTurn(request)) return { toolCalls: [{ name: "finish", input: {} }] };
    const send = request.tools.find((tool) => tool.function.name === "send_message");
    if (!send) return { text: "摘要" };
    const value = typeof text === "function" ? text(request) : text;
    const properties = send.function.parameters?.properties ?? {};
    return { toolCalls: [{ name: "send_message", input: "messages" in properties ? { messages: [value] } : { parts: [{ kind: "text", text: value }] } }] };
  };
}

/** Calls `name` once this turn, sends back what it returned, then finishes. */
export function callThenReport(name: string, input: (request: ModelRequest) => Record<string, unknown>): ModelScript {
  return (request) => {
    if (!request.tools.some((tool) => tool.function.name === "send_message")) return { text: "摘要" };
    if (!calledThisTurn(request, name)) return { toolCalls: [{ name, input: input(request) }] };
    if (sentThisTurn(request)) return { toolCalls: [{ name: "finish", input: {} }] };
    const result = request.messages.filter((message) => message.role === "tool").pop()?.content;
    return { toolCalls: [{ name: "send_message", input: { messages: [typeof result === "string" ? result : JSON.stringify(result)] } }] };
  };
}

/** Ends every turn silently. */
export function staySilent(): ModelScript {
  return (request) => (request.tools.some((tool) => tool.function.name === "finish") ? { toolCalls: [{ name: "finish", input: {} }] } : { text: "摘要" });
}

function currentIndex(request: ModelRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index]!;
    if (message.role === "user" && JSON.stringify(message.content ?? "").includes("[CURRENT_MESSAGE]")) return index;
  }
  return -1;
}

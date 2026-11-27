import type { LanguageModelV3, LanguageModelV3FinishReason, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createAgent } from "../src/agent.js";
import { createUserMessage } from "../src/message.js";
import type { AgentTool, AgentToolSet } from "../src/tools.js";

const STOP = "stop" as unknown as LanguageModelV3FinishReason;
const TOOL_CALLS = "tool-calls" as unknown as LanguageModelV3FinishReason;

type ScriptedStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly toolName: string; readonly input: string }
  | { readonly kind: "empty" };

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

function createScriptedModel(steps: readonly ScriptedStep[]) {
  let callCount = 0;
  const observedToolChoices: unknown[] = [];
  const observedPrompts: unknown[] = [];
  const observedTools: string[][] = [];

  const model = {
    specificationVersion: "v3",
    provider: "mock-provider",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream(options: { toolChoice?: unknown; prompt?: unknown; tools?: Array<{ name: string }> }) {
      observedToolChoices.push(options.toolChoice);
      observedPrompts.push(options.prompt);
      observedTools.push((options.tools ?? []).map((tool) => tool.name).sort());
      const index = callCount;
      callCount += 1;
      const step = steps[Math.min(index, steps.length - 1)] ?? { kind: "empty" };

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (step.kind === "text") {
              controller.enqueue({ type: "text-start", id: `text_${index}` });
              controller.enqueue({ type: "text-delta", id: `text_${index}`, delta: step.text });
              controller.enqueue({ type: "text-end", id: `text_${index}` });
            }
            if (step.kind === "tool") {
              const id = `call_${index}`;
              controller.enqueue({ type: "tool-input-start", id, toolName: step.toolName });
              controller.enqueue({ type: "tool-input-delta", id, delta: step.input });
              controller.enqueue({ type: "tool-input-end", id });
              controller.enqueue({ type: "tool-call", toolCallId: id, toolName: step.toolName, input: step.input });
            }
            controller.enqueue({
              type: "finish",
              finishReason: step.kind === "tool" ? TOOL_CALLS : STOP,
              usage: USAGE,
            } as LanguageModelV3StreamPart);
            controller.close();
          },
        }),
      };
    },
    observedToolChoices,
    observedPrompts,
    observedTools,
    get callCount() {
      return callCount;
    },
  };

  return model as unknown as LanguageModelV3 & {
    observedToolChoices: unknown[];
    observedPrompts: unknown[];
    observedTools: string[][];
    readonly callCount: number;
  };
}

function createTerminalTools(execute = vi.fn(async () => ({ ok: true }))): { tools: AgentToolSet; execute: typeof execute } {
  const finalize: AgentTool = {
    name: "finalize",
    terminal: true,
    inputSchema: z.object({}),
    execute,
  };
  const inspect: AgentTool = { name: "inspect", inputSchema: z.object({}), execute: async () => "observed" };
  return { tools: [finalize, inspect], execute };
}

async function runTurn(agent: ReturnType<typeof createAgent>) {
  const events: string[] = [];
  let failure: { name: string; message: string } | undefined;
  for await (const event of agent.run(createUserMessage("hello"))) {
    events.push(event.type);
    if (event.type === "turn.failed") failure = event.error;
  }
  // The stream ends on the terminal event, one microtask before the turn's own cleanup finishes.
  await agent.wait();
  return { events, failure };
}

describe("agent protocol invariant", () => {
  it("passes a required tool choice to the provider only when configured", async () => {
    const required = createScriptedModel([{ kind: "tool", toolName: "finalize", input: "{}" }]);
    const requiredAgent = createAgent({ model: required, tools: createTerminalTools().tools, toolChoice: "required" });
    requiredAgent.send(createUserMessage("hello"));
    await requiredAgent.wait();

    expect(required.observedToolChoices[0]).toEqual({ type: "required" });

    const compatible = createScriptedModel([{ kind: "tool", toolName: "finalize", input: "{}" }]);
    const compatibleAgent = createAgent({ model: compatible, tools: createTerminalTools().tools });
    compatibleAgent.send(createUserMessage("hello"));
    await compatibleAgent.wait();

    expect(compatible.observedToolChoices[0]).toEqual({ type: "auto" });
  });

  it("fails a text-only turn when a terminal tool is required", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = createScriptedModel([{ kind: "text", text: "这段文本不是平台消息" }]);
    const { tools, execute } = createTerminalTools();
    const onTurnFinish = vi.fn();
    const agent = createAgent({ model, tools, requireTerminalTool: true, plugins: [{ name: "observer", onTurnFinish }] });

    try {
      const { events, failure } = await runTurn(agent);

      expect(events).not.toContain("turn.done");
      expect(events.at(-1)).toBe("turn.failed");
      expect(failure).toMatchObject({ name: "AgentProtocolError" });
      expect(failure?.message).toContain("text-only");
      expect(execute).not.toHaveBeenCalled();
      expect(model.callCount).toBe(1);
      expect(onTurnFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }), expect.any(Object));

      const entries = await agent.storage.read();
      expect(entries.filter((entry) => entry.type === "event")).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ type: "turn.failed", error: expect.objectContaining({ name: "AgentProtocolError" }) }),
        }),
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("repairs an intermediate-only turn with one request-only terminal step", async () => {
    const model = createScriptedModel([
      { kind: "tool", toolName: "inspect", input: "{}" },
      { kind: "empty" },
      { kind: "tool", toolName: "finalize", input: "{}" },
    ]);
    const { tools, execute } = createTerminalTools();
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(execute).toHaveBeenCalledOnce();
    expect(model.callCount).toBe(3);
    expect(model.observedToolChoices.at(-1)).toEqual({ type: "required" });
    expect(JSON.stringify(model.observedPrompts.at(-1))).toContain("internal repair step");
    expect(JSON.stringify(await agent.storage.read())).not.toContain("internal repair step");
    expect((await agent.storage.read()).filter((entry) => entry.type === "message" && entry.data.role === "user")).toHaveLength(1);
  });

  it("preserves the protocol failure when terminal recovery also stops without a terminal tool", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = createScriptedModel([{ kind: "tool", toolName: "inspect", input: "{}" }, { kind: "empty" }, { kind: "empty" }]);
    const agent = createAgent({ model, tools: createTerminalTools().tools, requireTerminalTool: true });

    try {
      const { events, failure } = await runTurn(agent);

      expect(events).not.toContain("turn.done");
      expect(failure?.name).toBe("AgentProtocolError");
      expect(failure?.message).toContain("non-terminal-tool");
      expect(model.callCount).toBe(3);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fails a turn that produced neither text nor a tool call", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = createScriptedModel([{ kind: "empty" }]);
    const agent = createAgent({ model, tools: createTerminalTools().tools, requireTerminalTool: true });

    try {
      const { events, failure } = await runTurn(agent);

      expect(events).not.toContain("turn.done");
      expect(failure?.message).toContain("empty-or-no-terminal-tool");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("accepts a terminal tool call that arrives after intermediate steps", async () => {
    const model = createScriptedModel([
      { kind: "tool", toolName: "inspect", input: "{}" },
      { kind: "tool", toolName: "finalize", input: "{}" },
    ]);
    const { tools, execute } = createTerminalTools();
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(execute).toHaveBeenCalledOnce();
    expect(model.callCount).toBe(2);
  });

  it("keeps a predicate terminal tool with continue true non-terminal across steps", async () => {
    const continueSend = vi.fn(async () => ({ ok: true }));
    const finalize = vi.fn(async () => ({ ok: true }));
    const tools: AgentToolSet = [
      {
        name: "send_message",
        terminal: (input: { continue?: boolean }) => input.continue !== true,
        inputSchema: z.object({ continue: z.boolean().optional() }),
        execute: continueSend,
      },
      {
        name: "finalize",
        terminal: true,
        inputSchema: z.object({}),
        execute: finalize,
      },
    ];
    const model = createScriptedModel([
      { kind: "tool", toolName: "send_message", input: '{"continue":true}' },
      { kind: "tool", toolName: "finalize", input: "{}" },
    ]);
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(continueSend).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(model.callCount).toBe(2);
  });

  it("refuses a call that breaks a bare jsonSchema() tool's schema, tells the model why, and runs the corrected call", async () => {
    const setMood = vi.fn(async (input: { mood: string }) => ({ ok: true, mood: input.mood }));
    const tools: AgentToolSet = [
      {
        name: "set_mood",
        inputSchema: jsonSchema<{ mood: string }>({
          type: "object",
          properties: { mood: { type: "string", enum: ["happy", "calm"] } },
          required: ["mood"],
          additionalProperties: false,
        }),
        execute: setMood,
      },
      { name: "finalize", terminal: true, inputSchema: z.object({}), execute: async () => ({ ok: true }) },
    ];
    const model = createScriptedModel([
      { kind: "tool", toolName: "set_mood", input: '{"mood":"furious","extra":1}' },
      { kind: "tool", toolName: "set_mood", input: '{"mood":"calm"}' },
      { kind: "tool", toolName: "finalize", input: "{}" },
    ]);
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events.at(-1)).toBe("turn.done");
    expect(setMood).toHaveBeenCalledOnce();
    expect(setMood.mock.calls[0]![0]).toEqual({ mood: "calm" });
    expect(JSON.stringify(model.observedPrompts[1])).toContain("参数不符合工具定义");
  });

  it("does not accept an invalid terminal tool call as the end of a turn", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn(async () => ({ ok: true }));
    const tools: AgentToolSet = [
      {
        name: "finalize",
        terminal: true,
        inputSchema: z.object({ value: z.string() }),
        execute,
      },
    ];
    const model = createScriptedModel([{ kind: "tool", toolName: "finalize", input: "{}" }, { kind: "empty" }]);
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    try {
      const { events, failure } = await runTurn(agent);

      expect(events).not.toContain("turn.done");
      expect(failure?.message).toContain("empty-or-no-terminal-tool");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("lets a rejected terminal report correct its arguments before accepting the result", async () => {
    const reports: Array<{ status: string; handoff?: string }> = [];
    const report: AgentTool<{ status: string; handoff?: string }, { ok: boolean; executionStatus?: string }> = {
      name: "task_report",
      terminal: (_input, output) => output.ok === true,
      inputSchema: z.object({ status: z.string(), handoff: z.string().optional() }),
      execute: (input) => {
        if (input.handoff && input.status !== "waiting") return { ok: false, executionStatus: "not_started" };
        reports.push(input);
        return { ok: true };
      },
    };
    const model = createScriptedModel([
      { kind: "tool", toolName: "task_report", input: '{"status":"failed","handoff":"finish login"}' },
      { kind: "tool", toolName: "task_report", input: '{"status":"waiting","handoff":"finish login"}' },
    ]);
    const agent = createAgent({ model, tools: [report], requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events.at(-1)).toBe("turn.done");
    expect(model.callCount).toBe(2);
    expect(reports).toEqual([{ status: "waiting", handoff: "finish login" }]);
    expect(JSON.stringify(model.observedPrompts[1])).toContain("not_started");
  });

  it("allows correction of a rejected terminal report during terminal recovery", async () => {
    const execute = vi.fn(async (input: { accepted: boolean }) => ({ accepted: input.accepted }));
    const tools: AgentToolSet = [
      { name: "inspect", inputSchema: z.object({}), execute: async () => "observed" },
      {
        name: "task_report",
        terminal: (_input, output: { accepted: boolean }) => output.accepted,
        inputSchema: z.object({ accepted: z.boolean() }),
        execute,
      },
    ];
    const model = createScriptedModel([
      { kind: "tool", toolName: "inspect", input: "{}" },
      { kind: "empty" },
      { kind: "tool", toolName: "task_report", input: '{"accepted":false}' },
      { kind: "tool", toolName: "task_report", input: '{"accepted":true}' },
    ]);
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events.at(-1)).toBe("turn.done");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(model.callCount).toBe(4);
  });

  it.each([false, true])("does not accept a blocked terminal call with retry=%s", async (retry) => {
    const { tools, execute } = createTerminalTools();
    let attempts = 0;
    const model = createScriptedModel([
      { kind: "tool", toolName: "finalize", input: "{}" },
      { kind: "tool", toolName: "finalize", input: "{}" },
    ]);
    const agent = createAgent({
      model,
      tools,
      requireTerminalTool: true,
      toolBoundary: {
        beforeToolCall: () => (++attempts === 1 ? { type: "block", reason: "review_required", retry } : { type: "allow" }),
      },
    });

    const { events } = await runTurn(agent);

    expect(events).toContain("tool.blocked");
    expect(events.at(-1)).toBe("turn.done");
    expect(execute).toHaveBeenCalledOnce();
    expect(model.callCount).toBe(2);
  });

  it("does not accept a throwing terminal call before a later successful call", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    execute.mockRejectedValueOnce(new Error("report rejected"));
    const { tools } = createTerminalTools(execute);
    const model = createScriptedModel([
      { kind: "tool", toolName: "finalize", input: "{}" },
      { kind: "tool", toolName: "finalize", input: "{}" },
    ]);
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events).toContain("tool.failed");
    expect(events.at(-1)).toBe("turn.done");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(model.callCount).toBe(2);
  });

  it("keeps send_message non-terminal until a successful finish call", async () => {
    const finish = vi.fn(async () => ({ ok: true }));
    const model = createScriptedModel([
      { kind: "tool", toolName: "send_message", input: "{}" },
      { kind: "tool", toolName: "finish", input: "{}" },
    ]);
    const agent = createAgent({
      model,
      requireTerminalTool: true,
      tools: [
        { name: "send_message", terminal: false, inputSchema: z.object({}), execute: async () => ({ ok: false, error: "send_failed" }) },
        { name: "finish", terminal: true, inputSchema: z.object({}), execute: finish },
      ],
    });

    const { events } = await runTurn(agent);

    expect(events.at(-1)).toBe("turn.done");
    expect(finish).toHaveBeenCalledOnce();
    expect(model.callCount).toBe(2);
  });

  describe("step limit", () => {
    function createReportingTools() {
      const report = vi.fn(async () => ({ ok: true }));
      const { tools, execute: finalize } = createTerminalTools();
      return { tools: [...tools, { name: "send_message", inputSchema: z.object({}), execute: report } satisfies AgentTool], report, finalize };
    }

    it("lets a turn cut off by the step limit report where it got to, then end", async () => {
      const model = createScriptedModel([
        { kind: "tool", toolName: "inspect", input: "{}" },
        { kind: "tool", toolName: "inspect", input: "{}" },
        { kind: "tool", toolName: "send_message", input: "{}" },
        { kind: "tool", toolName: "finalize", input: "{}" },
      ]);
      const { tools, report, finalize } = createReportingTools();
      const onStepLimit = vi.fn();
      const agent = createAgent({ model, tools, requireTerminalTool: true, maxSteps: 2, stepLimitReportTools: ["send_message"], onStepLimit });

      const { events } = await runTurn(agent);

      expect(events).toContain("turn.done");
      expect(onStepLimit).toHaveBeenCalledExactlyOnceWith({ turnId: expect.any(String), steps: 2 });
      expect(report).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledOnce();
      expect(model.callCount).toBe(4);
      // The repair offers the report tool and the terminal tool, never the work tool.
      expect(model.observedTools.slice(2)).toEqual([
        ["finalize", "send_message"],
        ["finalize", "send_message"],
      ]);
      expect(model.observedToolChoices.slice(2)).toEqual([{ type: "required" }, { type: "required" }]);
      expect(JSON.stringify(model.observedPrompts.at(-1))).toContain("used all of its 2 tool steps");
      expect(JSON.stringify(await agent.storage.read())).not.toContain("internal repair step");
    });

    it("bounds the report repair and keeps the protocol failure when it never ends", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const model = createScriptedModel([
        { kind: "tool", toolName: "inspect", input: "{}" },
        { kind: "tool", toolName: "send_message", input: "{}" },
      ]);
      const { tools, report } = createReportingTools();
      const agent = createAgent({ model, tools, requireTerminalTool: true, maxSteps: 1, stepLimitReportTools: ["send_message"] });

      try {
        const { failure } = await runTurn(agent);

        expect(failure?.name).toBe("AgentProtocolError");
        expect(report).toHaveBeenCalledTimes(4);
        expect(model.callCount).toBe(5);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("offers only terminal tools after the step limit when no report tool is configured", async () => {
      const model = createScriptedModel([
        { kind: "tool", toolName: "inspect", input: "{}" },
        { kind: "tool", toolName: "finalize", input: "{}" },
      ]);
      const { tools, finalize } = createReportingTools();
      const onStepLimit = vi.fn();
      const agent = createAgent({ model, tools, requireTerminalTool: true, maxSteps: 1, onStepLimit });

      const { events } = await runTurn(agent);

      expect(events).toContain("turn.done");
      expect(onStepLimit).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledOnce();
      expect(model.observedTools.at(-1)).toEqual(["finalize"]);
      expect(JSON.stringify(model.observedPrompts.at(-1))).toContain("stopped before completing the turn");
    });

    it("keeps the terminal-only repair when the provider stops early without reaching the limit", async () => {
      const model = createScriptedModel([
        { kind: "tool", toolName: "inspect", input: "{}" },
        { kind: "empty" },
        { kind: "tool", toolName: "finalize", input: "{}" },
      ]);
      const { tools, report } = createReportingTools();
      const onStepLimit = vi.fn();
      const agent = createAgent({ model, tools, requireTerminalTool: true, stepLimitReportTools: ["send_message"], onStepLimit });

      const { events } = await runTurn(agent);

      expect(events).toContain("turn.done");
      expect(onStepLimit).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      expect(model.observedTools.at(-1)).toEqual(["finalize"]);
      expect(JSON.stringify(model.observedPrompts.at(-1))).toContain("stopped before completing the turn");
    });

    it("does not count a final terminal step as running out of steps", async () => {
      const model = createScriptedModel([
        { kind: "tool", toolName: "inspect", input: "{}" },
        { kind: "tool", toolName: "finalize", input: "{}" },
      ]);
      const { tools } = createReportingTools();
      const onStepLimit = vi.fn();
      const agent = createAgent({ model, tools, requireTerminalTool: true, maxSteps: 2, stepLimitReportTools: ["send_message"], onStepLimit });

      const { events } = await runTurn(agent);

      expect(events).toContain("turn.done");
      expect(onStepLimit).not.toHaveBeenCalled();
      expect(model.callCount).toBe(2);
    });
  });

  it("leaves intermediate-only turns untouched when a terminal tool is not required", async () => {
    const model = createScriptedModel([{ kind: "tool", toolName: "inspect", input: "{}" }, { kind: "empty" }]);
    const agent = createAgent({ model, tools: createTerminalTools().tools });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(model.callCount).toBe(2);
  });

  it("leaves plain text turns untouched when a terminal tool is not required", async () => {
    const model = createScriptedModel([{ kind: "text", text: "ok" }]);
    const agent = createAgent({ model, tools: createTerminalTools().tools });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
  });
});

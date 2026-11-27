import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createAgent, createUserMessage, jsonSchema, type AgentTool, type AgentPlugin } from "../src/index.js";

function fixture(calls: Array<{ name: string; args: unknown }>) {
  const requests: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const call = calls[requests.length];
      requests.push(request);
      return {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          ...(call
            ? [{ type: "tool-call" as const, toolCallId: `call-${requests.length}`, toolName: call.name, input: JSON.stringify(call.args) }]
            : [
                { type: "text-start" as const, id: "done" },
                { type: "text-delta" as const, id: "done", delta: "done" },
                { type: "text-end" as const, id: "done" },
              ]),
          {
            type: "finish",
            finishReason: { unified: call ? "tool-calls" : "stop", raw: call ? "tool-calls" : "stop" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
  return { model, requests };
}

const read: AgentTool["capability"] = { platforms: ["web"], sensitive: false, executionKind: "read" };
const tool = (name: string, execute = vi.fn(async (..._args: unknown[]) => "ok")): AgentTool => ({
  name,
  capability: read,
  inputSchema: z.object({}),
  execute,
});
async function run(config: Parameters<typeof createAgent>[0]) {
  const agent = createAgent({ ...config, maxSteps: 4 });
  const events = [];
  for await (const event of agent.run(createUserMessage("run"))) events.push(event);
  await agent.stop();
  return events;
}

describe("host-owned final tool boundary", () => {
  it("removes tools appended by a later plugin filter, including native provider tools", async () => {
    const f = fixture([]);
    const execute = vi.fn();
    const provider = { type: "provider", id: "test.native", args: {}, capability: { ...read, sensitive: true } } as never;
    await run({
      model: f.model,
      tools: [tool("safe")],
      providerTools: { native_private: provider },
      plugins: [{ name: "late", enforce: "post", filterTools: (tools) => [...tools, tool("injected", execute)] }],
      toolBoundary: { filterTools: (tools) => tools.filter((tool) => tool.name === "safe") },
    });
    expect(f.requests[0].tools?.map((tool) => tool.name)).toEqual(["safe"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses a filter's projected schema and executable closure in the real SDK loop", async () => {
    const f = fixture([{ name: "mixed", args: { action: "inspect" } }]);
    const original = vi.fn(async () => "original");
    const projected = vi.fn(async () => "projected");
    await run({
      model: f.model,
      tools: [{ name: "mixed", inputSchema: z.object({ action: z.enum(["inspect", "click"]) }), execute: original }],
      toolBoundary: {
        filterTools: (tools) => tools.map((tool) => ({ ...tool, inputSchema: z.object({ action: z.literal("inspect") }).strict(), execute: projected })),
      },
    });
    expect(JSON.stringify(f.requests[0].tools)).toContain('"const":"inspect"');
    expect(projected).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();
  });

  it("checks the final arguments after plugins replace them", async () => {
    const f = fixture([{ name: "mixed", args: { action: "inspect" } }]);
    const execute = vi.fn();
    await run({
      model: f.model,
      tools: [{ name: "mixed", inputSchema: z.object({ action: z.string() }), execute }],
      plugins: [{ name: "replace", beforeToolCall: () => ({ type: "replace", args: { action: "click" } }) }],
      toolBoundary: {
        beforeToolCall: (call) => ((call.args as { action: string }).action === "inspect" ? { type: "allow" } : { type: "block", reason: "readonly" }),
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("controlled tool delegation", () => {
  it("validates mapped JSON Schema inputs and runs the target's confirmation hook", async () => {
    const f = fixture([{ name: "alias", args: {} }]);
    const execute = vi.fn(async () => "effect");
    const target: AgentTool = {
      name: "private_write",
      capability: { ...read, sensitive: true, executionKind: "service" },
      inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string", minLength: 2 } }, required: ["value"], additionalProperties: false }),
      execute,
    };
    const outcomes: unknown[] = [];
    const alias: AgentTool = {
      ...tool("alias"),
      execute: async (_args, context) => {
        await expect(context.invokeTool(target.name, { value: 3 })).rejects.toThrow("tool_input_invalid");
        await expect(context.invokeTool(target.name, { value: "ok", extra: true })).rejects.toThrow("tool_input_invalid");
        outcomes.push(await context.invokeTool(target.name, { value: "ok" }));
        return "done";
      },
    };
    await run({
      model: f.model,
      tools: [target, alias],
      plugins: [
        {
          name: "confirmation",
          beforeToolCall: (call) => (call.toolName === target.name ? { type: "block", reason: "confirmation_required" } : { type: "allow" }),
        },
      ],
    });
    expect(outcomes).toEqual([{ blocked: true, reason: "confirmation_required" }]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("cannot delegate to a tool absent from the final catalog or recursively call itself", async () => {
    const f = fixture([{ name: "alias", args: {} }]);
    const hidden = tool("private");
    const alias: AgentTool = {
      ...tool("alias"),
      execute: async (_args, context) => {
        await expect(context.invokeTool("private", {})).rejects.toThrow("tool_delegate_denied");
        await expect(context.invokeTool("alias", {})).rejects.toThrow("tool_delegation_cycle");
        return "done";
      },
    };
    await run({ model: f.model, tools: [alias, hidden], toolBoundary: { filterTools: (tools) => tools.filter((tool) => tool.name !== "private") } });
    expect(hidden.execute).not.toHaveBeenCalled();
  });

  it("executes an allowed target without blocking the parent's serial execution slot", async () => {
    const f = fixture([{ name: "alias", args: {} }]);
    const target = tool("target");
    const alias: AgentTool = { ...tool("alias"), execute: (_args, context) => context.invokeTool("target", {}) };
    const seen: string[] = [];
    const hooks: AgentPlugin = {
      name: "audit",
      beforeToolCall: (call) => {
        seen.push(call.toolName);
      },
    };
    await run({ model: f.model, tools: [alias, target], plugins: [hooks] });
    expect(target.execute).toHaveBeenCalledOnce();
    expect(seen).toEqual(["alias", "target"]);
  });
});

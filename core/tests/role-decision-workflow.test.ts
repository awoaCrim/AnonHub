import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  AgentRequestProjection,
  createAgent,
  createAgentChannel,
  createMemoryStorage,
  createStateManager,
  createUserMessage,
  type PrepareStepContext,
} from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { Conversation } from "../src/conversations/index.js";
import { createMessage } from "../src/messages/index.js";
import { ContextWorkspace } from "../src/runtimes/context-workspace.js";
import { createModelInputPlugin } from "../src/runtimes/model-input.js";
import { createPostHistoryPlugin } from "../src/runtimes/prompt.js";
import { defaultMessageRecord, h } from "./helpers/index.js";

function context(projection?: AgentRequestProjection): PrepareStepContext {
  return {
    runtime: { id: "self-style-reminder-unit" },
    channel: createAgentChannel(),
    state: createStateManager({ storage: createMemoryStorage() }),
    turnId: "turn",
    stepNumber: 0,
    ...(projection ? { projection } : {}),
  };
}

function model() {
  return {
    specificationVersion: "v3" as const,
    provider: "synthetic",
    modelId: "synthetic",
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  };
}

const workflowHeading = "【回复前提醒；这是运行规则，不是新增聊天内容】";
const selfCheckHeading = "【答复前自检】";
describe("request-only post-history guidance", () => {
  it("appends the factual self-check with mandatory source-free provenance without changing original objects", async () => {
    const plugin = createPostHistoryPlugin();
    const projection = new AgentRequestProjection();
    const messages: ModelMessage[] = [
      { role: "system", content: "SYSTEM_AND_PERSONA" },
      { role: "user", content: "REAL_CURRENT" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "signed-call",
            toolName: "lookup",
            input: {},
            providerOptions: { google: { thoughtSignature: "synthetic-signature" } },
          },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "signed-call", toolName: "lookup", output: { type: "text", value: "REAL_TOOL_RESULT" } }],
      },
    ];
    const before = structuredClone(messages);
    const prepared = await plugin.prepareStep!(messages, context(projection));
    expect(plugin.enforce).toBe("post");
    expect(prepared).toHaveLength(messages.length + 1);
    expect(prepared!.slice(0, -1)).toEqual(before);
    messages.forEach((message, index) => expect(prepared![index]).toBe(message));
    expect(messages).toEqual(before);
    const reminder = prepared!.at(-1)!;
    expect(reminder.role).toBe("user");
    expect(typeof reminder.content).toBe("string");
    expect(String(reminder.content)).toContain(selfCheckHeading);
    expect(String(reminder.content)).not.toContain(workflowHeading);
    expect(projection.origin(reminder)).toEqual({ kind: "mandatory", sourceEntryIds: [] });
    expect(JSON.stringify(reminder)).not.toMatch(/sourceEntryIds|timestamp|thoughtSignature|functionCall/);
  });

  it("reuses only its own object across steps and retains genuine identical speech", async () => {
    const plugin = createPostHistoryPlugin();
    const initial = await plugin.prepareStep!([], context());
    const owned = initial![0]!;
    const genuine: ModelMessage = structuredClone(owned);
    const tail: ModelMessage = { role: "user", content: "NEXT_REAL_INPUT" };
    const source = [owned, genuine, owned, tail];
    const prepared = await plugin.prepareStep!(source, { ...context(), stepNumber: 1 });
    expect(source).toEqual([owned, genuine, owned, tail]);
    expect(prepared).toEqual([genuine, tail, owned]);
    expect(prepared![0]).toBe(genuine);
    expect(prepared!.at(-1)).toBe(owned);
    const again = await plugin.prepareStep!(prepared!, { ...context(), stepNumber: 2 });
    expect(again).toEqual(prepared);
    expect(again!.filter((message) => message === owned)).toHaveLength(1);
    const other = await createPostHistoryPlugin().prepareStep!([], context());
    expect(other![0]).not.toBe(owned);
    expect(other![0]).toEqual(owned);
  });

  it("keeps guard rebuilds reminder-free before any sending attempt", async () => {
    const projection = new AgentRequestProjection();
    const storage = createMemoryStorage();
    const fake = model();
    const captured: Array<readonly ModelMessage[]> = [];
    const agent = createAgent({
      id: "self-style-rebuild",
      plugins: [createPostHistoryPlugin()],
      model: fake as never,
      storage,
      requestProjection: projection,
      maxRetries: 0,
      beforeModelRequest: async (request) => {
        const first = await request.rebuildMessages();
        const second = await request.rebuildMessages();
        const owned = request.messages.at(-1)!;
        expect(first).toEqual(request.messages);
        expect(second).toEqual(first);
        expect(first.at(-1)).toEqual(owned);
        expect(second).toEqual(request.messages);
        expect(JSON.stringify(second)).not.toContain(workflowHeading);
        captured.push(second);
        throw new Error("captured before any provider transport");
      },
    });
    try {
      await agent.init();
      for await (const _event of agent.run(createUserMessage("REAL_CURRENT"))) {
        // Consume the intentionally blocked turn.
      }
      expect(captured).toHaveLength(1);
      expect(fake.doStream).not.toHaveBeenCalled();
      const stored = JSON.stringify(await storage.read());
      expect(stored).toContain("REAL_CURRENT");
      expect(stored).not.toContain(workflowHeading);
    } finally {
      await agent.stop();
    }
  });

  it("keeps the admitted Core input marked through actual SDK tool steps and guard rebuilds", async () => {
    const storage = createMemoryStorage();
    const fake = model();
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    fake.doStream.mockImplementation(async (options: LanguageModelV3CallOptions) => {
      const toolName = prompts.length === 0 ? "lookup" : "finish";
      prompts.push(options.prompt);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "tool-call", toolCallId: `guard-call-${prompts.length}`, toolName, input: "{}" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 } },
            });
            controller.close();
          },
        }),
      };
    });
    const current = createMessage(defaultMessageRecord({ messageId: "guard-current", parts: partsFromElements([h.text("GUARD_CURRENT")]) }));
    const other = createMessage(
      defaultMessageRecord({ messageId: "guard-unscoped", user: { id: "other" }, parts: partsFromElements([h.text("UNSCOPED_NOT_CURRENT")]) }),
    );
    let appended = false;
    const rebuilt: Array<readonly ModelMessage[]> = [];
    const agent = createAgent({
      model: fake as never,
      storage,
      plugins: [createModelInputPlugin(), createPostHistoryPlugin()],
      tools: [
        { name: "lookup", inputSchema: z.object({}), execute: async () => ({ value: "GUARD_LOOKUP_RESULT" }) },
        { name: "finish", inputSchema: z.object({}), terminal: true, execute: async () => ({ ok: true }) },
      ],
      requireTerminalTool: true,
      maxRetries: 0,
      beforeModelRequest: async (request) => {
        if (!appended) {
          appended = true;
          await agent.append(other);
        }
        const first = await request.rebuildMessages();
        const second = await request.rebuildMessages();
        expect(second).toEqual(first);
        rebuilt.push(second);
        return second;
      },
    });
    try {
      const events = await Array.fromAsync(agent.run(current));
      expect(events.some((event) => event.type === "turn.failed")).toBe(false);
      expect(prompts).toHaveLength(2);
      expect(rebuilt).toHaveLength(2);
      for (const prompt of prompts) {
        const text = prompt
          .flatMap((message) =>
            typeof message.content === "string" ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text),
          )
          .join("\n");
        expect([...text.matchAll(/\[CURRENT_MESSAGE\]\n([\s\S]*?)\n\[\/CURRENT_MESSAGE\]/g)].map((match) => match[1])).toEqual(["GUARD_CURRENT"]);
        expect(text).toContain('id="guard-current"');
        expect(text).toContain("UNSCOPED_NOT_CURRENT");
        expect(text).not.toContain(workflowHeading);
      }
      expect(JSON.stringify(prompts[1])).toContain("GUARD_LOOKUP_RESULT");
      const stored = JSON.stringify(await storage.read());
      expect(stored).not.toContain(workflowHeading);
      expect(stored).not.toContain("activeInputs");
    } finally {
      await agent.stop();
    }
  });

  it("counts the fixed reminder before provisional Magic admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-self-style-budget-"));
    const conversation = new Conversation(root);
    const projection = new AgentRequestProjection();
    const fake = model();
    await conversation.init();
    const workspace = new ContextWorkspace(conversation, projection, {
      config: {},
      // Caps the fixed 8192 output reserve at 128 so the 2000-token window stays usable.
      modelLimit: { context: 2000, output: 128 },
      model: fake as never,
    });
    try {
      workspace.capture([]);
      const current: ModelMessage = { role: "user", content: "x".repeat(2700) };
      projection.register(current, { kind: "live", sourceEntryIds: [] });
      const request = {
        model: fake as never,
        system: "SYSTEM",
        messages: [current],
        tools: {},
        currentMessageIds: [],
        projection,
        historyMode: "conversation" as const,
        turnId: "budget-turn",
        stepNumber: 0,
        signal: new AbortController().signal,
        rebuildMessages: async () => [current],
      };
      await expect(workspace.guard(request)).resolves.toEqual([current]);
      const messages = await createPostHistoryPlugin().prepareStep!([current], context(projection));
      await expect(workspace.guard({ ...request, messages: messages!, rebuildMessages: async () => messages! })).resolves.toEqual(messages);
      expect(fake.doGenerate).not.toHaveBeenCalled();
      expect(fake.doStream).not.toHaveBeenCalled();
      expect(await conversation.storage.read()).toEqual([]);
      expect(await conversation.contextRegions()).toEqual([]);
    } finally {
      workspace.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it.each([undefined, "保持角色口吻"])("sends immediately with a request-only self-check and optional card note: %s", async (note) => {
  const plugin = createPostHistoryPlugin(note);
  const ctx = context(new AgentRequestProjection());
  expect(plugin.beforeToolCall).toBeUndefined();
  const prepared = await plugin.prepareStep!([], ctx);
  expect(JSON.stringify(prepared)).not.toContain(workflowHeading);
  expect(JSON.stringify(prepared).split(selfCheckHeading)).toHaveLength(2);
  expect(ctx.projection!.origin(prepared!.at(-1)!)).toEqual({ kind: "mandatory", sourceEntryIds: [] });
  expect(await plugin.prepareStep!(prepared!, ctx)).toEqual(prepared);
  if (note) {
    expect(JSON.stringify(prepared)).toContain(note);
    expect(await plugin.prepareStep!(prepared!, ctx)).toHaveLength(1);
  } else expect(JSON.stringify(prepared)).not.toContain("character_post_history");
  expect(plugin.beforeToolCall).toBeUndefined();
});

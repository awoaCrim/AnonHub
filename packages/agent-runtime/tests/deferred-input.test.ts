import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { jsonSchema } from "ai";
import { expect, it } from "vitest";

import { createAgent, type Agent } from "../src/agent.js";
import { createCustomMessage, createUserMessage } from "../src/message.js";
import { createMemoryStorage } from "../src/storage.js";

function toolLoopModel(requests: LanguageModelV3CallOptions[], toolSteps = 1): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "synthetic",
    modelId: "no-network",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("unused");
    },
    async doStream(options) {
      requests.push(structuredClone(options));
      const call = requests.length;
      const useTool = call <= toolSteps;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (useTool) controller.enqueue({ type: "tool-call", toolCallId: `lookup-${call}`, toolName: "lookup", input: "{}" });
            else {
              controller.enqueue({ type: "text-start", id: "answer" });
              controller.enqueue({ type: "text-delta", id: "answer", delta: "done" });
              controller.enqueue({ type: "text-end", id: "answer" });
            }
            controller.enqueue({
              type: "finish",
              finishReason: { unified: useTool ? "tool-calls" : "stop", raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: useTool ? 0 : 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

it.each([false, true])("keeps an appended deferred input out of the active turn (deferred append: %s)", async (deferred) => {
  const requests: LanguageModelV3CallOptions[] = [];
  const turns: string[] = [];
  const followup = createUserMessage("QUEUED_FOLLOWUP");
  const projections: string[] = [];
  let agent: Agent;
  agent = createAgent({
    model: toolLoopModel(requests),
    tools: [
      {
        name: "lookup",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        async execute() {
          await agent.append(followup, { deferred });
          agent.send(followup, { ifBusy: "defer" });
          return { ok: true };
        },
      },
    ],
    plugins: [
      {
        name: "projection",
        transformEntries(entries) {
          projections.push(JSON.stringify(entries));
          return entries;
        },
      },
    ],
    async beforeModelRequest(context) {
      turns.push(context.turnId);
      const rebuilt = JSON.stringify(await context.rebuildMessages());
      if (turns.length <= 2) expect(rebuilt).not.toContain(followup.content);
    },
  });

  await Array.fromAsync(agent.run(createUserMessage("LONG_TASK")));
  await agent.wait();

  expect(requests).toHaveLength(3);
  expect(turns[0]).toBe(turns[1]);
  expect(turns[2]).not.toBe(turns[1]);
  expect(JSON.stringify(requests[1].prompt)).not.toContain(followup.content);
  expect(JSON.stringify(requests[2].prompt)).toContain(followup.content);
  expect(projections.slice(0, -1).every((entries) => !entries.includes(followup.content))).toBe(true);
  expect((await agent.storage.read()).filter((entry) => entry.type === "message" && entry.data.id === followup.id)).toHaveLength(1);
});

it.each(["join", "defer"] as const)("hides a reserved input before scheduling and admits it once via %s", async (ifBusy) => {
  const requests: LanguageModelV3CallOptions[] = [];
  const turns: string[] = [];
  const followup = createUserMessage("RESERVED_INPUT");
  let toolCalls = 0;
  let agent: Agent;
  agent = createAgent({
    model: toolLoopModel(requests, 2),
    tools: [
      {
        name: "lookup",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        async execute() {
          if (++toolCalls === 1) await agent.append(followup, { deferred: true });
          else agent.send(followup, { ifBusy });
          return { ok: true };
        },
      },
    ],
    beforeModelRequest(context) {
      turns.push(context.turnId);
    },
  });

  await Array.fromAsync(agent.run(createUserMessage("LONG_TASK")));
  await agent.wait();

  expect(JSON.stringify(requests[1].prompt)).not.toContain(followup.content);
  expect(requests).toHaveLength(ifBusy === "join" ? 3 : 4);
  expect(new Set(turns).size).toBe(ifBusy === "join" ? 1 : 2);
  expect(JSON.stringify(requests[2].prompt)).toContain(ifBusy === "join" ? followup.content : "LONG_TASK");
  if (ifBusy === "defer") expect(JSON.stringify(requests[2].prompt)).not.toContain(followup.content);
  expect(JSON.stringify(requests.at(-1)!.prompt)).toContain(followup.content);
  expect((await agent.storage.read()).filter((entry) => entry.type === "message" && entry.data.id === followup.id)).toHaveLength(1);
});

it.each(["join", "defer"] as const)("admits all batch context with its selected input via %s", async (ifBusy) => {
  const requests: LanguageModelV3CallOptions[] = [];
  const first = createCustomMessage("test.input", { text: "BATCH_CONTEXT" });
  const selected = createCustomMessage("test.input", { text: "BATCH_SELECTED" });
  const activeInputs: string[][] = [];
  let agent: Agent;
  agent = createAgent({
    model: toolLoopModel(requests),
    tools: [
      {
        name: "lookup",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        async execute() {
          await agent.append(first, { deferred: true });
          await agent.append(selected, { deferred: true });
          agent.send(selected, { ifBusy, contextMessages: [first] });
          return { ok: true };
        },
      },
    ],
    plugins: [
      {
        name: "capture-inputs",
        toModelMessages(message, context) {
          activeInputs.push((context.activeInputs ?? context.current).map((input) => input.id));
          return [{ role: "user", content: (message as typeof selected).data.text }];
        },
      },
    ],
  });

  await Array.fromAsync(agent.run(createUserMessage("LONG_TASK")));
  await agent.wait();

  expect(requests).toHaveLength(ifBusy === "join" ? 2 : 3);
  if (ifBusy === "defer") {
    expect(JSON.stringify(requests[1].prompt)).not.toContain(first.data.text);
    expect(JSON.stringify(requests[1].prompt)).not.toContain(selected.data.text);
  }
  const finalPrompt = JSON.stringify(requests.at(-1)!.prompt);
  expect(finalPrompt).toContain(first.data.text);
  expect(finalPrompt).toContain(selected.data.text);
  expect(activeInputs.at(-1)).toEqual([selected.id]);
  const stored = (await agent.storage.read()).filter((entry) => entry.type === "message");
  expect(stored.filter((entry) => entry.data.id === first.id)).toHaveLength(1);
  expect(stored.filter((entry) => entry.data.id === selected.id)).toHaveLength(1);
});

it("releases an untriggered reserved input as an observation without a second turn", async () => {
  const requests: LanguageModelV3CallOptions[] = [];
  const observation = createUserMessage("OBSERVATION_ONLY");
  const turns = new Set<string>();
  let agent: Agent;
  agent = createAgent({
    model: toolLoopModel(requests),
    tools: [
      {
        name: "lookup",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        async execute() {
          await agent.append(observation, { deferred: true });
          agent.observe(observation);
          return { ok: true };
        },
      },
    ],
    beforeModelRequest(context) {
      turns.add(context.turnId);
    },
  });
  await Array.fromAsync(agent.run(createUserMessage("LONG_TASK")));
  await agent.wait();

  expect(requests).toHaveLength(2);
  expect(turns.size).toBe(1);
  expect(JSON.stringify(requests[1].prompt)).toContain(observation.content);
});

it("keeps later queued batches hidden with transformed entries and cloning storage", async () => {
  const requests: LanguageModelV3CallOptions[] = [];
  const first = createUserMessage("FIRST_QUEUED_INPUT");
  const context = createUserMessage("FIRST_BATCH_CONTEXT");
  const later = createUserMessage("LATER_QUEUED_INPUT");
  const baseStorage = createMemoryStorage();
  let agent: Agent;
  agent = createAgent({
    model: toolLoopModel(requests),
    storage: { ...baseStorage, read: async () => structuredClone(await baseStorage.read()) },
    plugins: [
      {
        name: "transform-input",
        onAppend(entries) {
          return entries.map((entry) => ({ ...entry, id: `transformed-${entry.id}` }));
        },
      },
    ],
    tools: [
      {
        name: "lookup",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        async execute() {
          for (const input of [context, first, later]) await agent.append(input, { deferred: true });
          agent.send(first, { ifBusy: "defer", contextMessages: [context] });
          agent.send(later, { ifBusy: "defer" });
          return { ok: true };
        },
      },
    ],
  });
  await Array.fromAsync(agent.run(createUserMessage("LONG_TASK")));
  await agent.wait();

  expect(requests).toHaveLength(4);
  expect(JSON.stringify(requests[1].prompt)).not.toMatch(/FIRST_QUEUED_INPUT|FIRST_BATCH_CONTEXT|LATER_QUEUED_INPUT/);
  expect(JSON.stringify(requests[2].prompt)).toContain(first.content);
  expect(JSON.stringify(requests[2].prompt)).toContain(context.content);
  expect(JSON.stringify(requests[2].prompt)).not.toContain(later.content);
  expect(JSON.stringify(requests[3].prompt)).toContain(later.content);
  const stored = await agent.storage.read();
  for (const input of [context, first, later]) {
    expect(stored.filter((entry) => entry.type === "message" && entry.data.id === input.id)).toHaveLength(1);
  }
});

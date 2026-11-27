import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAssistantMessage,
  createCustomMessage,
  createJsonlStorage,
  createMessageEntry,
  createToolMessage,
  createUserMessage,
  jsonSchema,
  type AgentMessage,
  type AgentTool,
} from "@yesimbot/agent-runtime";
import { partsFromElements } from "@yesimbot/contracts/parts";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import { createModelInputPlugin } from "../src/runtimes/model-input.js";
import { inheritedTaskContext, workerTaskContext } from "../src/tasks/context.js";
import { Tasks } from "../src/tasks/manager.js";
import { captureTaskSource } from "../src/tasks/source.js";
import { extractToolAccessActorIds } from "../src/tool-access.js";
import { toolActors } from "../src/tool-policy.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const scope = { type: "direct" as const, platform: "onebot", selfId: "bot", channelId: "channel", userId: "owner" };
const attachmentId = "a".repeat(32),
  quotedId = "b".repeat(32);
const element = (type: string, attrs: Record<string, unknown>, children: unknown[] = []) => ({ type, attrs, children });
const parentMessage = () =>
  createCustomMessage("yesimbot.message", {
    platform: scope.platform,
    selfId: scope.selfId,
    channel: { id: scope.channelId, type: 1 },
    user: { id: "owner" },
    messageId: "native-id",
    parts: partsFromElements([
      element("text", { content: "PARENT_CHAT_INSTRUCTION" }),
      element("img", { id: attachmentId, src: "SECRET_URL", unrelated: "PARENT_ATTR_INSTRUCTION" }),
    ]),
    quote: {
      messageId: "quote-id",
      parts: partsFromElements([element("text", { content: "PARENT_QUOTE_INSTRUCTION" }), element("file", { id: quotedId, name: "input.txt" })]),
    },
  } as never);
const parentEvent = () =>
  createCustomMessage("yesimbot.event", {
    eventType: "schedule.due",
    platform: scope.platform,
    selfId: scope.selfId,
    channel: { id: scope.channelId, type: 1 },
    text: "PARENT_SCHEDULE_INSTRUCTION: search news, update schedule, send message",
    schedule: { id: "schedule-id", title: "PARENT_SCHEDULE_TITLE" },
  } as never);

it("keeps source identity and attachment references without carrying parent chat or quote instructions", () => {
  const raw = parentMessage();
  raw.data.parts[1]!.source = "PRIVATE_RAW_ELEMENT_SOURCE";
  const projected = workerTaskContext([raw]);
  expect(captureTaskSource(scope, [raw])).toEqual(captureTaskSource(scope, projected));
  expect(toolActors(projected, "onebot")).toEqual([{ platform: "onebot", userId: "owner" }]);
  expect(extractToolAccessActorIds(projected)).toEqual(["owner"]);
  expect(projected[0]).toMatchObject({
    id: raw.id,
    timestamp: raw.timestamp,
    data: { messageId: "native-id", parts: partsFromElements([element("img", { id: attachmentId }), element("file", { id: quotedId, name: "input.txt" })]) },
  });
  expect(JSON.stringify(projected)).not.toMatch(/PARENT_|SECRET_URL|PRIVATE_RAW_ELEMENT_SOURCE/);
  expect(JSON.stringify(raw)).toContain("PARENT_CHAT_INSTRUCTION");
});

it("keeps event source metadata without introducing a current runtime event or an actor grant", () => {
  const projected = workerTaskContext([parentEvent()]);
  expect(projected).toHaveLength(1);
  expect(projected[0]).toMatchObject({ role: "user", content: expect.stringContaining("schedule-id") });
  expect(JSON.stringify(projected)).not.toMatch(/PARENT_|yesimbot.event|current runtime event/);
  expect(captureTaskSource(scope, projected)).toBeUndefined();
  expect(toolActors(projected, "onebot")).toEqual([]);
});

it("passes delegated context as current-turn authorization carriers while the model sees only the delegated scope", async () => {
  const path = await mkdtemp(join(tmpdir(), "yib-task-context-"));
  directories.push(path);
  const prompts: string[] = [];
  let requests = 0;
  const execute = vi.fn(async (_input: unknown, context: { messages: readonly AgentMessage[] }) => {
    expect(toolActors(context.messages, "onebot")).toEqual([{ platform: "onebot", userId: "owner" }]);
    expect(extractToolAccessActorIds(context.messages)).toEqual(["owner"]);
    return { ok: true };
  });
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const first = ++requests === 1;
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "step-" + requests,
            toolName: first ? "computer_exec" : "task_report",
            input: JSON.stringify(first ? {} : { status: "succeeded", result: "Rendered delegated HTML" }),
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } },
        ]),
      };
    },
  });
  const prepare = vi.fn(async () => ({
    config: {
      model,
      plugins: [createModelInputPlugin()],
      tools: [{ name: "computer_exec", inputSchema: jsonSchema({ type: "object", properties: {} }), execute }],
    },
  }));
  const manager = new Tasks(path, { prepare, notify: async () => "delivered", diagnostic: vi.fn(), changed() {} });
  await manager.start();
  try {
    const create = (manager.plugin({ scope, channel: "channel", session: "session.jsonl" }).tools as AgentTool[]).find((tool) => tool.name === "task_create")!;
    const created = await create.execute({ kind: "computer", timeLimitMinutes: 30, instruction: "Only render provided HTML" }, {
      turnId: "turn",
      toolCallId: "delegate",
      messages: [parentMessage()],
    } as never);
    await vi.waitFor(async () => expect((await manager.store.get(created.id))?.notification).toBe("delivered"));
    expect((await manager.store.get(created.id))?.source).toMatchObject({ actorIds: ["owner"], messageIds: ["native-id"] });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(prompts.join("\n")).toContain("Only render provided HTML");
    expect(prompts.join("\n")).toContain("asset://" + attachmentId);
    expect(prompts.join("\n")).not.toMatch(/PARENT_CHAT_INSTRUCTION|PARENT_QUOTE_INSTRUCTION/);

    const eventTask = await create.execute({ kind: "computer", timeLimitMinutes: 30, instruction: "Only render second HTML" }, {
      turnId: "event-turn",
      toolCallId: "delegate",
      messages: [parentEvent()],
    } as never);
    await vi.waitFor(async () => expect((await manager.store.get(eventTask.id))?.notification).toBe("delivered"));
    expect((await manager.store.get(eventTask.id))?.source).toBeUndefined();
    expect(prompts.join("\n")).toContain("Only render second HTML");
    expect(prompts.join("\n")).not.toMatch(/PARENT_SCHEDULE_|current runtime event/);
  } finally {
    await manager.stop();
  }
});

it("scopes parent carriers in a legacy waiting task before formatting its resumed history without rewriting the journal or granting actors", async () => {
  const path = await mkdtemp(join(tmpdir(), "yib-task-legacy-context-"));
  directories.push(path);
  const prompts: string[] = [];
  let requests = 0;
  const inspect = vi.fn(async (_input: unknown, execution: { messages: readonly AgentMessage[] }) => {
    expect(toolActors(execution.messages, "onebot")).toEqual([]);
    expect(extractToolAccessActorIds(execution.messages)).toEqual([]);
    return { text: "NEW_OBSERVATION_EVIDENCE" };
  });
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const step = ++requests;
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "resume-step-" + step,
            toolName: step === 1 ? "read" : "task_report",
            input: JSON.stringify(step === 1 ? {} : { status: "succeeded", result: "Resumed only unfinished work" }),
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } },
        ]),
      };
    },
  });
  const diagnostic = vi.fn();
  const manager = new Tasks(path, {
    prepare: async (record) => {
      expect(record.source).toBeUndefined();
      return {
        config: {
          model,
          plugins: [
            {
              name: "legacy-projection-order-check",
              enforce: "pre",
              transformMessages: (messages) => {
                expect(JSON.stringify(messages)).not.toMatch(/PARENT_CHAT_INSTRUCTION|PARENT_QUOTE_INSTRUCTION|PARENT_SCHEDULE_/);
                return messages;
              },
            },
            createModelInputPlugin(),
          ],
          tools: [{ name: "read", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: inspect }],
        },
      };
    },
    notify: async () => "delivered",
    diagnostic,
    changed() {},
  });
  const { record } = await manager.store.create({
    channel: "channel",
    session: "s.jsonl",
    key: "legacy-task",
    kind: "content",
    instruction: "LEGACY_DELEGATED_INSTRUCTION",
  });
  await manager.store.update(record.id, (row) => {
    row.status = "waiting";
    row.result = "LEGACY_WAITING_REPORT";
  });
  const journalPath = join(path, record.id + ".jsonl");
  const storage = createJsonlStorage(journalPath);
  await storage.append(
    ...[
      parentMessage(),
      parentEvent(),
      createUserMessage("LEGACY_DELEGATED_INSTRUCTION"),
      createAssistantMessage([
        { type: "tool-call", toolCallId: "legacy-completed", toolName: "computer_exec", input: { command: "LEGACY_COMPLETED_OPERATION" } },
      ]),
      createToolMessage([
        {
          type: "tool-result",
          toolCallId: "legacy-completed",
          toolName: "computer_exec",
          output: { type: "json", value: { status: "succeeded", output: { text: "LEGACY_EXECUTION_EVIDENCE" } } },
        },
      ]),
      createAssistantMessage([
        { type: "tool-call", toolCallId: "legacy-report", toolName: "task_report", input: { status: "waiting", result: "LEGACY_WAITING_REPORT" } },
      ]),
      createToolMessage([{ type: "tool-result", toolCallId: "legacy-report", toolName: "task_report", output: { type: "json", value: { ok: true } } }]),
    ].map((message) => createMessageEntry(message)),
  );
  const originalJournal = await readFile(journalPath, "utf8");
  expect(originalJournal).toContain("PARENT_SCHEDULE_INSTRUCTION");
  await manager.start();
  try {
    await manager.update(record.id, "RESUME_ONLY_UNFINISHED_PART", "channel");
    await vi.waitFor(async () => expect((await manager.store.get(record.id))?.notification).toBe("delivered"));
    expect((await manager.store.get(record.id))?.status).toBe("succeeded");
    expect((await manager.store.get(record.id))?.source).toBeUndefined();
    expect(requests).toBe(2);
    expect(inspect).toHaveBeenCalledTimes(1);
    const prompt = prompts.join("\n");
    for (const text of [
      "LEGACY_DELEGATED_INSTRUCTION",
      "LEGACY_COMPLETED_OPERATION",
      "LEGACY_EXECUTION_EVIDENCE",
      "LEGACY_WAITING_REPORT",
      "RESUME_ONLY_UNFINISHED_PART",
      "NEW_OBSERVATION_EVIDENCE",
    ])
      expect(prompt).toContain(text);
    expect(prompt).toContain("asset://" + attachmentId);
    expect(prompt).not.toMatch(/PARENT_CHAT_INSTRUCTION|PARENT_QUOTE_INSTRUCTION|PARENT_SCHEDULE_|current runtime event/);
    const resumedJournal = await readFile(journalPath, "utf8");
    expect(resumedJournal.startsWith(originalJournal)).toBe(true);
    expect(resumedJournal).toContain("PARENT_SCHEDULE_INSTRUCTION");
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    await manager.stop();
  }
});

it("turns the parent model input into a bounded read-only transcript that keeps the newest part", () => {
  const messages = [
    { role: "system", content: "SYSTEM_PROMPT_SECRET" },
    { role: "user", content: "OLDEST " + "x".repeat(400) },
    {
      role: "assistant",
      content: [
        { type: "text", text: "我先写文件" },
        { type: "tool-call", toolCallId: "c1", toolName: "writeFile", input: { path: "report.html" } },
      ],
    },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "writeFile", output: { type: "json", value: { ok: true } } }] },
    {
      role: "user",
      content: [
        { type: "text", text: "NEWEST 看看这张" },
        { type: "image", image: new Uint8Array([1, 2, 3]) },
      ],
    },
  ] as never;
  const full = inheritedTaskContext(messages)!;
  const text = (full as { content: string }).content;
  expect(text).toMatch(/^以下是委派这项任务时主对话的上下文/);
  expect(text).not.toContain("SYSTEM_PROMPT_SECRET");
  expect(text).toContain('调用 writeFile：{"path":"report.html"}');
  expect(text).toContain('writeFile 返回：{"ok":true}');
  expect(text).toContain("NEWEST 看看这张\n[图片]");
  expect(text.indexOf("OLDEST")).toBeLessThan(text.indexOf("NEWEST"));
  expect(text).not.toContain("更早的内容已省略");
  // Over the limit the oldest blocks go first, and the omission is said.
  const bounded = (inheritedTaskContext(messages, 600) as { content: string }).content;
  expect(bounded).toContain("NEWEST");
  expect(bounded).not.toContain("OLDEST");
  expect(bounded).toContain("（更早的内容已省略）");
  expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(600);
  expect(inheritedTaskContext([])).toBeUndefined();
  expect(inheritedTaskContext([{ role: "system", content: "only system" }] as never)).toBeUndefined();
});

it("gives a worker the conversation of the turn that delegated it, before the delegated scope, and not to a task of a later turn", async () => {
  const path = await mkdtemp(join(tmpdir(), "yib-task-inherit-"));
  directories.push(path);
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "report-" + prompts.length,
            toolName: "task_report",
            input: JSON.stringify({ status: "succeeded", result: "done" }),
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } },
        ]),
      };
    },
  });
  const manager = new Tasks(path, {
    prepare: async () => ({ config: { model, plugins: [createModelInputPlugin()], tools: [] } }),
    notify: async () => "delivered",
    diagnostic: vi.fn(),
    changed() {},
  });
  await manager.start();
  try {
    const plugin = manager.plugin({ scope, channel: "channel", session: "session.jsonl" });
    const create = (plugin.tools as AgentTool[]).find((tool) => tool.name === "task_create")!;
    const parent = [
      { role: "user", content: "群友：把今天的日报做成图片 PARENT_CONTEXT_MARK" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "w1", toolName: "writeFile", input: { path: "report.html" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "w1", toolName: "writeFile", output: { type: "json", value: { ok: true } } }] },
    ];
    await plugin.prepareStep!(parent as never, { turnId: "turn", stepNumber: 0 } as never);
    const created = await create.execute({ kind: "content", timeLimitMinutes: 30, instruction: "Render report.html" }, {
      turnId: "turn",
      toolCallId: "delegate",
      messages: [parentMessage()],
    } as never);
    await vi.waitFor(async () => expect((await manager.store.get(created.id))?.notification).toBe("delivered"));
    const first = prompts[0]!;
    expect(first).toContain("以下是委派这项任务时主对话的上下文");
    expect(first).toContain("PARENT_CONTEXT_MARK");
    expect(first).toContain("调用 writeFile");
    expect(first.indexOf("PARENT_CONTEXT_MARK")).toBeLessThan(first.indexOf("Render report.html"));
    // The source carriers stay stripped to identities and attachments.
    expect(first).not.toContain("PARENT_CHAT_INSTRUCTION");

    // A task created in a later turn does not inherit an earlier request.
    const later = await create.execute({ kind: "content", timeLimitMinutes: 30, instruction: "Second task" }, {
      turnId: "later",
      toolCallId: "delegate",
      messages: [],
    } as never);
    await vi.waitFor(async () => expect((await manager.store.get(later.id))?.notification).toBe("delivered"));
    const second = prompts.find((prompt) => prompt.includes("Second task"))!;
    expect(second).not.toContain("PARENT_CONTEXT_MARK");
  } finally {
    await manager.stop();
  }
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import { asSchema } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { afterEach, expect, it, vi } from "vitest";

import type { ChannelContext } from "../src/channels/index.js";
import { YesImBotCore } from "../src/core.js";
import { Tasks, type TaskHost } from "../src/tasks/manager.js";
import { TaskStore, type TaskRecord } from "../src/tasks/store.js";
import { runtimeToolBoundary } from "../src/tasks/tool-execution.js";
import { TestEvents, testAccount } from "./helpers/index.js";

// User, 2026-11-20: 「超时/步数超了仅提醒主bot（主bot可以结束/延长/sterr等），不强制结束。步数非必要，超时时长时必要的」.
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "yesimbot-task-time-"));
  directories.push(path);
  return path;
}

const origin = { channel: "channel-a", session: "first.jsonl" };
const execution = (toolCallId: string) => ({ turnId: "turn", toolCallId, messages: [] }) as never;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const toolStep = (toolName: string, input: unknown, id: string) => ({
  stream: convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
  ] as never),
});

it("needs a time limit for every delegation, within its bounds", async () => {
  const path = await directory();
  const manager = new Tasks(path, {
    prepare: vi.fn(async () => {
      throw new Error("not run in this test");
    }),
    notify: vi.fn(async () => "delivered" as const),
    diagnostic: vi.fn(),
    changed: vi.fn(),
  });
  await manager.start();
  try {
    const create = (manager.plugin(origin).tools as AgentTool[]).find((tool) => tool.name === "task_create")!;
    expect(((await asSchema(create.inputSchema).jsonSchema) as { required: string[] }).required).toContain("timeLimitMinutes");
    expect(await create.execute({ kind: "content", instruction: "整理资料" }, execution("none"))).toMatchObject({
      ok: false,
      executionStatus: "not_started",
      error: { code: "task_time_limit_required" },
    });
    for (const [index, timeLimitMinutes] of [3, 12.5, 481, "30"].entries())
      expect(await create.execute({ kind: "content", instruction: "整理资料", timeLimitMinutes }, execution(`bad-${index}`))).toMatchObject({
        ok: false,
        error: { code: "task_time_limit_invalid" },
      });
    expect(await manager.store.list()).toEqual([]);
    const created = await create.execute({ kind: "content", instruction: "整理资料", timeLimitMinutes: 45 }, execution("ok"));
    expect(created).toMatchObject({ kind: "content", timeLimitMinutes: 45 });
    expect(await manager.store.get((created as TaskRecord).id)).toMatchObject({ timeLimitMinutes: 45 });
  } finally {
    await manager.stop();
  }
});

it("refuses a stored time limit out of bounds", async () => {
  const path = await directory();
  const row = { id: "11111111-1111-4111-8111-111111111111", channel: "c", session: "s", key: "k", kind: "content", instruction: "x", status: "succeeded" };
  await writeFile(join(path, "tasks.json"), JSON.stringify([{ ...row, createdAt: 0, updatedAt: 0, timeLimitMinutes: 1 }]));
  await expect(new TaskStore(path).load()).rejects.toThrow("task_store_invalid");
});

it("tells the main conversation once per limit while the task keeps running, and lets it give more time", async () => {
  const path = await directory();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let looks = 0;
  const probe: AgentTool = {
    name: "probe",
    executionKind: "read",
    description: "look at the server",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    execute: async () => {
      // The second look takes long, like a slow download.
      if (++looks > 1) await released;
      return { status: "succeeded", output: { text: "still syncing" } };
    },
  };
  let requests = 0;
  const model = new MockLanguageModelV3({
    doStream: async () =>
      ++requests <= 2 ? toolStep("probe", {}, `look-${requests}`) : toolStep("task_report", { status: "succeeded", result: "上报正常" }, "report"),
  });
  const overtime = vi.fn();
  const notify = vi.fn(async () => "delivered" as const);
  const manager = new Tasks(path, { prepare: async () => ({ config: { model, tools: [probe] } }), notify, diagnostic: vi.fn(), changed: vi.fn(), overtime });
  await manager.start();
  try {
    const task = await manager.create(origin, "computer", "检查服务器上报", "key", [], { timeLimitMinutes: 5 });
    await vi.waitFor(() => expect(looks).toBe(2));
    const running = (await manager.store.get(task.id))!;
    expect(running).toMatchObject({ status: "running", timeLimitMinutes: 5 });
    const due = running.deadlineAt!;
    expect(due).toBeGreaterThan(Date.now() + 4 * 60_000);

    expect(await manager.checkOvertime(due - 1)).toBe(0);
    expect(await manager.checkOvertime(due)).toBe(1);
    await vi.waitFor(() => expect(overtime).toHaveBeenCalledTimes(1));
    expect(overtime.mock.calls[0]?.[0]).toMatchObject({ id: task.id, status: "running" });
    expect(overtime.mock.calls[0]?.[1]).toContain("一共调用了 1 次工具（probe ×1）");
    // Told once for this limit; the next notice comes one more limit later.
    expect(await manager.checkOvertime(due)).toBe(0);
    expect((await manager.store.get(task.id))!.deadlineAt).toBe(due + 5 * 60_000);
    expect(await manager.checkOvertime(due + 5 * 60_000)).toBe(1);
    await vi.waitFor(() => expect(overtime).toHaveBeenCalledTimes(2));

    // More time counts from the later of now and the current limit.
    const extend = (manager.plugin(origin).tools as AgentTool[]).find((tool) => tool.name === "task_control")!;
    expect(await extend.execute({ id: task.id, action: "extend", minutes: 30 }, execution("extend"))).toMatchObject({
      id: task.id,
      deadlineAt: due + 40 * 60_000,
    });
    expect(await extend.execute({ id: task.id, action: "extend", minutes: 3 }, execution("short"))).toMatchObject({
      ok: false,
      error: { code: "task_time_limit_invalid" },
    });
    expect(await extend.execute({ id: task.id, action: "extend" }, execution("missing"))).toMatchObject({
      status: "rejected",
      code: "invalid_task_input",
      changed: false,
    });
    await expect(manager.extend(task.id, 30, "channel-b")).rejects.toThrow("task_not_found");
    expect(await manager.checkOvertime(due + 39 * 60_000)).toBe(0);

    // None of it stopped the task: it goes on and reports.
    expect((await manager.store.get(task.id))!.status).toBe("running");
    release();
    await vi.waitFor(async () =>
      expect(await manager.store.get(task.id)).toMatchObject({ status: "succeeded", result: "上报正常", notification: "delivered" }),
    );
    await expect(manager.extend(task.id, 30)).rejects.toMatchObject({ code: "task_not_running" });
    expect(await manager.checkOvertime(due + 24 * 60 * 60_000)).toBe(0);
    expect(overtime).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await manager.stop();
  }
});

it("offers the main conversation task_control, and no worker", async () => {
  const path = await directory();
  const manager = new Tasks(path, { prepare: vi.fn(), notify: vi.fn(), diagnostic: vi.fn(), changed: vi.fn() });
  const tools = manager.plugin(origin).tools as AgentTool[];
  expect(tools.find((tool) => tool.name === "task_control")?.capability).toMatchObject({ executionKind: "communication" });
  const main = (await runtimeToolBoundary({ platform: "onebot", kind: "group" }, "main").filterTools!(tools, {} as never))!;
  expect(main.map((tool) => tool.name)).toContain("task_control");
  const worker = (await runtimeToolBoundary({ platform: "onebot", kind: "group" }, "computer").filterTools!(tools, {} as never))!;
  expect(worker.map((tool) => tool.name)).not.toContain("task_control");
});

it("tells the main conversation how to handle the time limit", async () => {
  const path = await directory();
  const manager = new Tasks(path, { prepare: vi.fn(), notify: vi.fn(), diagnostic: vi.fn(), changed: vi.fn() });
  const prompt = String(await manager.plugin(origin).appendSystemPrompt?.({} as never));
  expect(prompt).toContain("timeLimitMinutes");
  expect(prompt).toContain("任务不会因为超时或步数被停下");
  for (const word of ["task_control", "extend", "update", "cancel"]) expect(prompt).toContain(word);
  expect(prompt).toContain("超时提醒只给你看，不需要转告用户");
});

it("posts an overtime notice that is neither a user request nor a result, and only to the conversation that delegated", async () => {
  const path = await directory();
  await writeFile(join(path, "models.json"), "{}");
  const scope: ChannelContext = { type: "direct", platform: "test", channelId: "channel", selfId: "bot", userId: "user" };
  const service = new YesImBotCore({
    baseDir: path,
    config: { basePath: path, chatModel: "test:model" },
    events: new TestEvents(),
    account: () => testAccount(scope.platform, scope.selfId),
  });
  const internal = service as unknown as { channels: { storedContext: unknown; resolve: unknown }; messenger: { postAndReport: unknown } };
  let session = "session";
  internal.channels.storedContext = vi.fn(async () => scope);
  internal.channels.resolve = vi.fn(async () => ({ conversation: { currentSessionId: () => session } }));
  const postAndReport = vi.fn(async (_event: Record<string, unknown>, _options: unknown) => ({ kind: "run", outcome: { delivered: true } }));
  internal.messenger.postAndReport = postAndReport;
  const host = (service.tasks as unknown as { host: TaskHost }).host;
  const record: TaskRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    channel: "channel",
    session: "session.jsonl",
    key: "overtime",
    kind: "computer",
    instruction: `检查雨云服务器上的 komari 上报${"，再核对一遍".repeat(30)}TAIL_MARK`,
    status: "running",
    timeLimitMinutes: 30,
    createdAt: 0,
    updatedAt: 0,
  };
  try {
    await host.overtime!(record, "它到现在一共调用了 3 次工具（computer_exec ×3）");
    const [event, options] = postAndReport.mock.calls[0]!;
    expect(event).toMatchObject({ eventType: "task.overtime", task: { id: record.id, status: "running" }, channel: { id: "channel" }, user: { id: "user" } });
    const text = String(event.text);
    expect(text).toContain("已经超过预计的 30 分钟，还在运行");
    expect(text).toContain("不是新的用户请求，也不是任务结果");
    expect(text).toContain("computer_exec ×3");
    expect(text).toContain("检查雨云服务器上的 komari 上报");
    expect(text).not.toContain("TAIL_MARK");
    for (const word of ["task_control", "extend", "update", "cancel"]) expect(text).toContain(word);
    expect(text).toContain("不需要告诉用户");
    expect(event.historyNote).toBe(`后台任务 ${record.id} 超过了预计的 30 分钟，当时还在运行。`);
    expect(options).toEqual({ trigger: true, ifBusy: "defer", historyMode: "event" });
    // A conversation that has moved on to a new session hears nothing.
    session = "newer";
    await host.overtime!(record, "");
    expect(postAndReport).toHaveBeenCalledTimes(1);
  } finally {
    await service.tasks.stop();
  }
});

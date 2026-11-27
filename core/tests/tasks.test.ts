import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@yesimbot/agent-runtime";
import { afterEach, expect, it, vi } from "vitest";

import { TaskStore, type TaskRecord } from "../src/tasks/store.js";
import { executionAllowed, executionKind } from "../src/tasks/tool-execution.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "yib-tasks-"));
  dirs.push(path);
  return { path, store: new TaskStore(path) };
}
const input = { key: "turn:call", channel: "channel-a", session: "first.jsonl", kind: "computer" as const, instruction: "检查签到状态" };
it("persists task records on the Windows file-flush path", async () => {
  const { path, store } = await fixture();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const { record } = await store.create(input);
    await store.update(record.id, (row) => {
      row.status = "waiting";
    });
    expect(await new TaskStore(path).get(record.id)).toMatchObject({ status: "waiting", instruction: input.instruction });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
it("deduplicates concurrent creates within the origin only", async () => {
  const { store } = await fixture();
  const result = await Promise.all([store.create(input), store.create(input), store.create({ ...input, channel: "channel-b" })]);
  expect(result[0].record.id).toBe(result[1].record.id);
  expect(result.filter((r) => r.created)).toHaveLength(2);
});
it("does not replay unfinished effects or claimed notifications after restart", async () => {
  const { store, path } = await fixture();
  const { record } = await store.create(input);
  await store.update(record.id, (row) => {
    row.status = "running";
    row.notification = "claimed";
  });
  const reopened = new TaskStore(path);
  const task = await reopened.get(record.id);
  expect(task?.status).toBe("unknown");
  expect(task?.notification).toBe("unknown");
});
it("does not expose mutable store objects to callers", async () => {
  const { store } = await fixture();
  const { record } = await store.create(input);
  record.instruction = "tampered";
  expect((await store.get(record.id))?.instruction).toBe(input.instruction);
});
const tool = (name: string, executionKind?: AgentTool["executionKind"]) => ({ name, executionKind, execute: vi.fn() }) as unknown as AgentTool;
it("allows direct verification but denies unrestricted computer tools to the main agent", () => {
  for (const name of [
    "read",
    "search",
    "search_web",
    "search_images",
    "gmail",
    "google_drive",
    // Like Muse, simple single-step work is done directly: files, rendering, services.
    "writeFile",
    "render_html",
    "gmail_send",
    "remember",
  ])
    expect(executionAllowed(tool(name), "main")).toBe(true);
  // The main agent is not read-only on the computer: simple operations are done directly.
  for (const name of ["computer_exec", "computer_ui", "computer_browser", "computer_switch"]) expect(executionAllowed(tool(name), "main")).toBe(true);
  expect(executionKind(tool("computer_exec", "read"))).toBe("computer");
});
it("workers cannot talk to users or recursively spawn work", () => {
  for (const role of ["computer", "content", "service"] as const)
    for (const name of ["send_message", "reply_owner", "task_create"]) expect(executionAllowed(tool(name), role)).toBe(false);
  expect(executionAllowed(tool("computer_exec"), "computer")).toBe(true);
  expect(executionAllowed(tool("computer_exec"), "service")).toBe(false);
});

it("runs the worker independently, reports once, and keeps execution tools out of the main bot", async () => {
  const { Tasks } = await import("../src/tasks/manager.js");
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test");
  const { path } = await fixture();
  const seen: string[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      for (const tool of options.tools ?? []) seen.push(tool.name);
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "report-1", toolName: "task_report", input: JSON.stringify({ status: "waiting", result: "请提供目标文件名" }) },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
  const notify = vi.fn(async () => "delivered" as const),
    diagnostic = vi.fn();
  const manager = new Tasks(path, { prepare: async () => ({ config: { model, tools: [] } }), notify, diagnostic, changed: () => {} });
  await manager.start();
  const task = await manager.create({ channel: "channel-a", session: "first.jsonl" }, "computer", "inspect", "key");
  await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
  expect((await manager.store.get(task.id))?.status).toBe("waiting");
  expect(notify).toHaveBeenCalledTimes(1);
  expect(seen).toContain("task_report");
  expect(seen).not.toContain("send_message");
  expect(diagnostic).not.toHaveBeenCalled();
  await manager.cancel(task.id);
  await manager.stop();
});

it("recovers only never-handed-off results after restart without replaying execution", async () => {
  const { Tasks } = await import("../src/tasks/manager.js");
  const { path, store } = await fixture();
  const pending = (await store.create(input)).record;
  const claimed = (await store.create({ ...input, key: "claimed" })).record;
  await store.update(pending.id, (row) => {
    row.status = "succeeded";
    row.notification = "pending";
    row.result = "finished";
  });
  await store.update(claimed.id, (row) => {
    row.status = "succeeded";
    row.notification = "claimed";
    row.result = "finished";
  });
  const notify = vi.fn(async (_record: TaskRecord) => "delivered" as const),
    prepare = vi.fn();
  const manager = new Tasks(path, { prepare, notify, diagnostic: vi.fn(), changed: vi.fn() });
  await manager.start();
  await vi.waitFor(async () => expect((await manager.store.get(pending.id))?.notification).toBe("delivered"));
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]?.[0]).toMatchObject({ id: pending.id, result: "finished" });
  expect((await manager.store.get(claimed.id))?.notification).toBe("unknown");
  expect(prepare).not.toHaveBeenCalled();
  await manager.stop();
});

it("bounds the actual worker provider continuation after a huge command result", async () => {
  const { Tasks } = await import("../src/tasks/manager.js");
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test");
  const { jsonSchema } = await import("@yesimbot/agent-runtime");
  const { path } = await fixture();
  let requests = 0;
  const execute = vi.fn(async () => ({ status: "succeeded", output: { exitCode: 0, stdout: "长JSONL记录".repeat(60000) } }));
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      requests++;
      if (requests === 2) {
        const request = JSON.stringify(options.prompt);
        expect(Buffer.byteLength(request)).toBeLessThan(45000);
        expect(request).toContain("fullOutputSaved");
        expect(request).toContain("read_tool_output");
      }
      const name = requests === 1 ? "computer_exec" : "task_report";
      const input = requests === 1 ? {} : { status: "succeeded", result: "checked bounded output" };
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-" + requests, toolName: name, input: JSON.stringify(input) },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
  const diagnostic = vi.fn();
  const manager = new Tasks(path, {
    prepare: async () => ({ config: { model, tools: [{ name: "computer_exec", inputSchema: jsonSchema({ type: "object", properties: {} }), execute }] } }),
    notify: async () => "delivered",
    diagnostic,
    changed() {},
  });
  await manager.start();
  try {
    const task = await manager.create({ channel: "a", session: "s" }, "computer", "inspect", "bounded");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    expect((await manager.store.get(task.id))?.status).toBe("succeeded");
    expect(requests).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(diagnostic).not.toHaveBeenCalled();
  } finally {
    await manager.stop();
  }
});

it("marks over-budget context waiting without sending a provider request or replaying tools", async () => {
  const { Tasks } = await import("../src/tasks/manager.js");
  const { MockLanguageModelV3 } = await import("ai/test");
  const { path } = await fixture();
  const stream = vi.fn();
  const model = new MockLanguageModelV3({ doStream: stream });
  const manager = new Tasks(path, {
    prepare: async () => ({ modelLimit: { context: 16000, output: 2000 }, config: { model } }),
    notify: async () => "delivered",
    diagnostic() {},
    changed() {},
  });
  await manager.start();
  try {
    const task = await manager.create({ channel: "a", session: "s" }, "computer", "inspect " + "x".repeat(200000), "huge");
    await vi.waitFor(async () => expect((await manager.store.get(task.id))?.notification).toBe("delivered"));
    expect((await manager.store.get(task.id))?.status).toBe("waiting");
    expect((await manager.store.get(task.id))?.result).toContain("上下文预算");
    expect(stream).not.toHaveBeenCalled();
  } finally {
    await manager.stop();
  }
});

it("persists human handoffs, requires explicit matching acknowledgement, and resumes only once", async () => {
  const { Tasks } = await import("../src/tasks/manager.js");
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test");
  const { path } = await fixture();
  let step = 0;
  const deviceId = "11111111-1111-4111-8111-111111111111";
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "report-" + ++step,
          toolName: "task_report",
          input: JSON.stringify(
            step === 1
              ? { status: "waiting", result: "等待用户完成登录", handoff: "请在电脑上完成登录，然后交还电脑。" }
              : { status: "succeeded", result: "已核实登录并继续剩余工作" },
          ),
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
      ]),
    }),
  });
  const canResume = vi.fn(async () => false);
  // The worker switched computers before asking for help: the handoff names the one it is on now.
  const prepare = vi.fn(async () => ({ deviceId: "99999999-9999-4999-8999-999999999999", currentDeviceId: () => deviceId, config: { model } }));
  const host = { prepare, canResumeHandoff: canResume, notify: async () => "delivered" as const, diagnostic: vi.fn(), changed() {} };
  const first = new Tasks(path, host);
  await first.start();
  const created = await first.create({ channel: "channel-a", session: "first.jsonl" }, "computer", "检查登录", "handoff");
  await vi.waitFor(async () => expect((await first.store.get(created.id))?.status).toBe("waiting"));
  const pending = (await first.store.get(created.id))!.handoff!;
  expect(pending).toMatchObject({ state: "pending", deviceId });
  await first.stop();
  const resumed = new Tasks(path, host);
  await resumed.start();
  expect((await resumed.store.get(created.id))?.handoff).toEqual(pending);
  expect(prepare).toHaveBeenCalledTimes(1);
  await resumed.update(created.id, "登录的是原来那个账号", "channel-a");
  expect((await resumed.store.get(created.id))?.status).toBe("waiting");
  expect(prepare).toHaveBeenCalledTimes(1);
  await expect(resumed.resolveHandoff(created.id, pending.id, "", "another-channel")).rejects.toThrow("task_not_found");
  await expect(resumed.resolveHandoff(created.id, "22222222-2222-4222-8222-222222222222")).rejects.toThrow("task_handoff_stale");
  await expect(resumed.resolveHandoff(created.id, pending.id)).rejects.toThrow("task_handoff_not_ready");
  canResume.mockResolvedValue(true);
  const attempts = await Promise.allSettled([resumed.resolveHandoff(created.id, pending.id), resumed.resolveHandoff(created.id, pending.id)]);
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await vi.waitFor(async () => expect((await resumed.store.get(created.id))?.status).toBe("succeeded"));
  expect(prepare).toHaveBeenCalledTimes(2);
  expect((await resumed.store.get(created.id))?.handoff?.state).toBe("resolved");
  expect(host.diagnostic).not.toHaveBeenCalled();
  await resumed.stop();
});

it("cancelling a waiting handoff prevents stale completion from resuming it", async () => {
  const { Tasks } = await import("../src/tasks/manager.js");
  const { path, store } = await fixture();
  const task = (await store.create(input)).record;
  const id = "11111111-1111-4111-8111-111111111111";
  await store.update(task.id, (row) => {
    row.status = "waiting";
    row.handoff = { id, state: "pending", instruction: "请处理", requestedAt: Date.now() };
  });
  const prepare = vi.fn();
  const manager = new Tasks(path, { prepare, notify: async () => "delivered", diagnostic() {}, changed() {} });
  await manager.start();
  await manager.cancel(task.id);
  await expect(manager.resolveHandoff(task.id, id)).rejects.toThrow("task_handoff_stale");
  expect((await manager.store.get(task.id))?.handoff?.state).toBe("cancelled");
  expect(prepare).not.toHaveBeenCalled();
  await manager.stop();
});

it("carries on unfinished work from a task result turn, closes the paused task it continues, and stops a long chain", async () => {
  const { Tasks } = await import("../src/tasks/manager.js");
  const { MAX_TASK_CONTINUATIONS } = await import("../src/tasks/limits.js");
  const { createCustomMessage } = await import("@yesimbot/agent-runtime");
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test");
  const { path } = await fixture();
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "report", toolName: "task_report", input: JSON.stringify({ status: "succeeded", result: "done" }) },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        },
      ]),
    }),
  });
  const manager = new Tasks(path, {
    prepare: async () => ({ config: { model, tools: [] } }),
    notify: async () => "delivered" as const,
    diagnostic: vi.fn(),
    changed: () => {},
  });
  await manager.start();
  try {
    const origin = { channel: "channel-a", session: "first.jsonl" };
    const create = (manager.plugin(origin).tools as AgentTool[]).find((tool) => tool.name === "task_create")!;
    const resultOf = (id: string) =>
      createCustomMessage("yesimbot.event", {
        eventType: "task.result",
        platform: "web",
        selfId: "bot",
        channel: { id: "owner", type: 1 },
        task: { id, status: "waiting" },
        text: "result",
      } as never);
    // A task paused by the internal budget, as the store keeps it.
    const { record: paused } = await manager.store.create({ ...input, key: "paused", channel: "channel-a" });
    await manager.store.update(paused.id, (row) => {
      row.status = "waiting";
      row.pauseReason = "context_budget";
    });
    // In the turn that received its result, a new task carries on its work.
    const next = (await create.execute({ kind: "content", timeLimitMinutes: 30, instruction: "接着做剩余步骤" }, {
      turnId: "result-1",
      toolCallId: "c",
      messages: [resultOf(paused.id)],
    } as never)) as TaskRecord;
    expect(next.continues).toEqual({ taskId: paused.id, depth: 1 });
    expect((await manager.store.get(paused.id))?.continuedBy).toBe(next.id);
    // A user's own request starts a new chain.
    const fresh = (await create.execute({ kind: "content", timeLimitMinutes: 30, instruction: "新的请求" }, {
      turnId: "user",
      toolCallId: "c",
      messages: [],
    } as never)) as TaskRecord;
    expect(fresh.continues).toBeUndefined();
    // A chain longer than the limit stops and reports instead of looping.
    let previous = next;
    for (let depth = 2; depth <= MAX_TASK_CONTINUATIONS; depth++) {
      previous = (await create.execute({ kind: "content", timeLimitMinutes: 30, instruction: `续做 ${depth}` }, {
        turnId: `result-${depth}`,
        toolCallId: "c",
        messages: [resultOf(previous.id)],
      } as never)) as TaskRecord;
      expect(previous.continues?.depth).toBe(depth);
    }
    const refused = (await create.execute({ kind: "content", timeLimitMinutes: 30, instruction: "再续做" }, {
      turnId: "result-last",
      toolCallId: "c",
      messages: [resultOf(previous.id)],
    } as never)) as { ok: boolean; executionStatus: string; error: { code: string; message: string } };
    expect(refused).toMatchObject({ ok: false, executionStatus: "not_started", error: { code: "task_continuation_limit" } });
    expect(refused.error.message).toContain("向用户说明");
    // Every worker has finished and its result notice is written, so no store write outlives the test.
    await vi.waitFor(async () =>
      expect(
        (await manager.store.list()).filter((task) => task.id !== paused.id).every((task) => task.status === "succeeded" && task.notification === "delivered"),
      ).toBe(true),
    );
  } finally {
    await manager.stop();
  }
});

it("rejects malformed continuation links when loading the store", async () => {
  const { path } = await fixture();
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    key: "k",
    channel: "c",
    session: "s",
    kind: "content",
    instruction: "i",
    status: "succeeded",
    createdAt: 1,
    updatedAt: 1,
  };
  for (const bad of [{ continues: { taskId: "x", depth: 1 } }, { continues: { taskId: row.id, depth: 0 } }, { continuedBy: "nope" }]) {
    await writeFile(join(path, "tasks.json"), JSON.stringify([{ ...row, ...bad }]));
    await expect(new TaskStore(path).load()).rejects.toThrow("task_store_invalid");
  }
  await writeFile(join(path, "tasks.json"), JSON.stringify([{ ...row, continues: { taskId: row.id, depth: 2 }, continuedBy: row.id }]));
  await expect(new TaskStore(path).load()).resolves.toBeUndefined();
});

// User, 2026-11-26: 「后台任务，允许归档，归档后webui上看不到了，但是bot仍然可以通过命令查询」.
it("archives finished tasks only, keeps them for task_status, and brings back a task that starts again", async () => {
  const { path, store } = await fixture();
  const { taskOverview } = await import("../src/tasks/manager.js");
  const done = (await store.create({ ...input, key: "done" })).record;
  const open = (await store.create({ ...input, key: "open" })).record;
  await store.update(done.id, (row) => {
    row.status = "succeeded";
  });
  expect(await store.archive([done.id, open.id, "00000000-0000-4000-8000-000000000000"], true)).toEqual([done.id]);
  expect(await store.archive([done.id], true)).toEqual([]);
  expect((await new TaskStore(path).get(done.id))?.archivedAt).toEqual(expect.any(Number));
  expect((await store.get(open.id))?.archivedAt).toBeUndefined();
  expect(taskOverview(await store.list()).tasks.map((row) => row.id)).toEqual(expect.arrayContaining([done.id, open.id]));
  expect(await store.archive([done.id], false)).toEqual([done.id]);
  expect((await store.get(done.id))?.archivedAt).toBeUndefined();
  // A paused task another one carries on counts as finished; told to go on itself, it shows again.
  await store.update(open.id, (row) => {
    row.status = "waiting";
    row.continuedBy = done.id;
  });
  expect(await store.archive([open.id], true)).toEqual([open.id]);
  await store.update(open.id, (row) => {
    row.status = "queued";
    delete row.continuedBy;
  });
  expect((await store.get(open.id))?.archivedAt).toBeUndefined();
  await writeFile(join(path, "tasks.json"), JSON.stringify([{ ...(await store.get(done.id)), archivedAt: "yesterday" }]));
  await expect(new TaskStore(path).load()).rejects.toThrow("task_store_invalid");
});

it("task_status without an id lists short rows: every open task, the newest finished ones, full detail by id", async () => {
  const { taskOverview, TASK_OVERVIEW_FINISHED } = await import("../src/tasks/manager.js");
  const long = "很长的说明".repeat(4000);
  const row = (id: number, status: TaskRecord["status"], extra: Partial<TaskRecord> = {}): TaskRecord => ({
    ...input,
    key: `k${id}`,
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    instruction: long,
    status,
    createdAt: 1000 - id,
    updatedAt: 1000 - id,
    result: long,
    ...extra,
  });
  const handoff = { id: "11111111-1111-4111-8111-111111111111", state: "pending" as const, instruction: "请登录", requestedAt: 1 };
  const rows = [
    row(1, "running", { progress: long }),
    row(2, "waiting", { handoff }),
    row(3, "waiting", { pauseReason: "context_budget", continuedBy: row(1, "running").id }),
    ...Array.from({ length: 14 }, (_, i) => row(10 + i, "succeeded")),
  ];
  const overview = taskOverview(rows);
  expect(overview.tasks.slice(0, 2).map((task) => task.status)).toEqual(["running", "waiting"]);
  expect(overview.tasks).toHaveLength(2 + TASK_OVERVIEW_FINISHED);
  // A paused task another task carries on counts as finished.
  expect(overview.tasks[2]).toMatchObject({ status: "waiting", continuedBy: rows[0]!.id, pauseReason: "context_budget" });
  expect(overview.olderFinished).toBe(15 - TASK_OVERVIEW_FINISHED);
  expect(overview.tasks[1]!.handoff).toEqual({ id: handoff.id, state: "pending" });
  expect(Array.from(overview.tasks[0]!.instruction).length).toBe(101);
  expect(overview.tasks[0]!.progress!.endsWith("…")).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(overview), "utf8")).toBeLessThan(12_000);
  expect(overview.note).toContain("带上任务 id");
  expect(taskOverview([])).toEqual({ tasks: [], note: overview.note });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { Tasks } from "../../../core/src/tasks/manager.js";
import { TaskStore, type TaskStatus } from "../../../core/src/tasks/store.js";
import { installTasks } from "../src/webui/tasks.js";
import { TopicRegistry } from "../src/webui/topics.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(status: TaskStatus = "unknown") {
  const directory = await mkdtemp(join(tmpdir(), "yib-webui-task-update-"));
  directories.push(directory);
  const prepare = vi.fn(async () => {
    throw new Error("an update request must not execute a task");
  });
  const notify = vi.fn(async () => "delivered" as const);
  const tasks = new Tasks(directory, { prepare, notify, diagnostic: vi.fn(), changed: vi.fn() });
  const { record } = await tasks.store.create({ key: "heartbeat", channel: "web:owner", session: "today", kind: "service", instruction: "创建心跳计划" });
  const original = await tasks.store.update(record.id, (task) => {
    task.status = status;
    task.result = "创建请求已提交，但没有收到最终回执。";
    task.artifacts = ["saved-result.txt"];
    task.notification = "unknown";
  });
  const routes = new Map<string, (http: unknown) => unknown>();
  const current = { session: { role: "owner" } as { role: string } | undefined, sameOrigin: true };
  const sessionFromCookie = vi.fn(() => current.session);
  const ctx = {
    yesimbot: { tasks },
    on: vi.fn(),
    // Core is handed over the way Koishi does once it is up.
    inject: vi.fn((_deps: unknown, callback: (scope: unknown) => void) => callback({ yesimbot: { tasks }, on: vi.fn() })),
    server: {
      get: (path: string, handler: (http: unknown) => unknown) => routes.set("GET " + path, handler),
      post: (path: string, handler: (http: unknown) => unknown) => routes.set("POST " + path, handler),
    },
  };
  installTasks(ctx as never, { sessionFromCookie, sameOrigin: () => current.sameOrigin } as never, new TopicRegistry());
  const cancel = vi.spyOn(tasks, "cancel");
  async function request(changes: Record<string, unknown> = {}) {
    const http = {
      status: 200,
      body: undefined as unknown,
      set: vi.fn(),
      get: (name: string) => (name === "content-type" ? "application/json" : ""),
      request: { body: { id: original.id, action: "cancel", ...changes } },
    };
    await routes.get("POST /yesimbot/api/v1/tasks/update")!(http);
    return http;
  }

  async function steps(query: Record<string, unknown>) {
    const http = { status: 200, body: undefined as unknown, set: vi.fn(), get: () => "", query };
    await routes.get("GET /yesimbot/api/v1/tasks/steps")!(http);
    return http;
  }
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    const http = {
      status: 200,
      body: undefined as unknown,
      set: vi.fn(),
      get: (name: string) => (name === "content-type" ? "application/json" : ""),
      request: { body },
    };
    await routes.get(`${method} ${path}`)!(http);
    return http;
  }
  return { tasks, original, current, sessionFromCookie, cancel, request, steps, call, prepare, notify, directory };
}

// User, 2026-11-20: 「任何任务都不在需要我核实，让主bot核实就行了」: an interrupted task has no reminder to close.
it("no longer closes reminders: dismiss is refused and the record stays as it was", async () => {
  const h = await fixture();
  const response = await h.request({ action: "dismiss" });
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ message: "task_update_failed" });
  expect(await new TaskStore(h.directory).get(h.original.id)).toEqual(h.original);
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.notify).not.toHaveBeenCalled();
});

it("cancels a running task and returns the record", async () => {
  const h = await fixture("running");
  const response = await h.request();
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ id: h.original.id, status: "cancelled" });
  expect(await new TaskStore(h.directory).get(h.original.id)).toMatchObject({ status: "cancelled" });
  expect(h.cancel).toHaveBeenCalledWith(h.original.id);
});

it.each(["anonymous", "member", "foreign-origin"] as const)("requires a same-origin authenticated owner (%s)", async (state) => {
  const h = await fixture("running");
  if (state === "anonymous") h.current.session = undefined;
  else if (state === "member") h.current.session = { role: "member" };
  else h.current.sameOrigin = false;
  const response = await h.request();
  expect(response.status).toBe(state === "anonymous" ? 401 : 403);
  expect(h.cancel).not.toHaveBeenCalled();
  expect(await h.tasks.store.get(h.original.id)).toEqual(h.original);
});

it("rechecks the authenticated session after reading the request", async () => {
  const h = await fixture("running");
  h.sessionFromCookie.mockReturnValueOnce(h.current.session).mockReturnValueOnce(h.current.session).mockReturnValueOnce(undefined);
  const response = await h.request();
  expect(response.status).toBe(401);
  expect(response.body).toEqual({ message: "login_required" });
  expect(h.cancel).not.toHaveBeenCalled();
});

it.each([
  { id: "not-a-task-id" },
  { action: "retry" },
  { dismissedAt: 1 },
  { status: "succeeded" },
  { channel: "another-channel" },
  { tenant: "another-tenant" },
])("rejects forged or unrelated fields: %j", async (changes) => {
  const h = await fixture("running");
  const response = await h.request(changes);
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ message: "task_update_failed" });
  expect(h.cancel).not.toHaveBeenCalled();
  expect(await h.tasks.store.get(h.original.id)).toEqual(h.original);
});

it("uses only the authenticated instance and hides unexpected internal errors", async () => {
  const h = await fixture("running");
  const other = await fixture("running");
  const response = await h.request({ id: other.original.id });
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ message: "task_not_found" });
  expect(await other.tasks.store.get(other.original.id)).toEqual(other.original);
  h.cancel.mockRejectedValueOnce(new Error("private task journal location"));
  expect((await h.request()).body).toEqual({ message: "task_update_failed" });
});

// User, 2026-11-26: 「后台任务，允许归档，归档后webui上看不到了，但是bot仍然可以通过命令查询」.
it("archives finished tasks out of the console's list and brings them back", async () => {
  const h = await fixture("succeeded");
  const archive = (body: unknown) => h.call("POST", "/yesimbot/api/v1/tasks/archive", body);
  const listed = async () => ((await h.call("GET", "/yesimbot/api/v1/tasks")).body as { items: { id: string }[] }).items.map((task) => task.id);
  expect(await listed()).toEqual([h.original.id]);
  expect((await archive({ ids: [h.original.id], archived: true })).body).toEqual({ ids: [h.original.id] });
  expect(await listed()).toEqual([]);
  // The bot's own tools read the store, which keeps it.
  expect((await h.tasks.store.get(h.original.id))?.archivedAt).toEqual(expect.any(Number));
  expect((await archive({ ids: [h.original.id], archived: false })).body).toEqual({ ids: [h.original.id] });
  expect(await listed()).toEqual([h.original.id]);
  for (const bad of [
    { ids: [h.original.id] },
    { ids: [], archived: true },
    { ids: ["nope"], archived: true },
    { ids: [h.original.id], archived: true, channel: "x" },
  ]) {
    const response = await archive(bad);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: "invalid_task_request" });
  }
  h.current.session = { role: "member" };
  expect((await archive({ ids: [h.original.id], archived: true })).status).toBe(403);
  expect((await h.tasks.store.get(h.original.id))?.archivedAt).toBeUndefined();
});

it("leaves an unfinished task in the list when asked to archive it", async () => {
  const h = await fixture("running");
  expect((await h.call("POST", "/yesimbot/api/v1/tasks/archive", { ids: [h.original.id], archived: true })).body).toEqual({ ids: [] });
  expect((await h.tasks.store.get(h.original.id))?.archivedAt).toBeUndefined();
});

// User, 2026-11-20: 「我点开这个后台任务不就是为了看进度吗？至少我得知道，执行了哪些命令，正在执行什么命令吧？」
it("lists a task's steps from a given one on, for the owner only", async () => {
  const h = await fixture("succeeded");
  const message = (role: string, content: unknown[]) => JSON.stringify({ type: "message", data: { id: role, timestamp: 1000, role, content } });
  await writeFile(
    join(h.directory, h.original.id + ".jsonl"),
    [
      message("assistant", [
        { type: "tool-call", toolCallId: "a", toolName: "computer_exec", input: { command: "uname -a" } },
        { type: "tool-call", toolCallId: "b", toolName: "computer_exec", input: { command: "uptime" } },
      ]),
      message("tool", [
        { type: "tool-result", toolCallId: "a", toolName: "computer_exec", output: { type: "json", value: { status: "succeeded", output: { exitCode: 0 } } } },
        { type: "tool-result", toolCallId: "b", toolName: "computer_exec", output: { type: "json", value: { status: "succeeded", output: { exitCode: 0 } } } },
      ]),
    ].join("\n") + "\n",
  );
  expect((await h.steps({ id: h.original.id })).body).toMatchObject({
    total: 2,
    steps: [{ id: "a", input: { command: "uname -a" }, status: "ok" }, { id: "b" }],
  });
  expect((await h.steps({ id: h.original.id, from: "1" })).body).toMatchObject({ total: 2, steps: [{ id: "b", input: { command: "uptime" } }] });
  expect((await h.steps({ id: "../etc" })).status).toBe(400);
  expect((await h.steps({ id: h.original.id, from: "-1" })).status).toBe(400);
  expect((await h.steps({ id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
  h.current.session = { role: "member" };
  expect((await h.steps({ id: h.original.id })).body).not.toHaveProperty("steps");
});

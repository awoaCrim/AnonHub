import { expect, it, vi } from "vitest";

import type { AdminHttpContext } from "../src/admin-auth";
import type { ScheduleRunsSnapshot, SchedulesSnapshot } from "../src/shared/schedules";
import { installSchedules, SCHEDULES_PATH } from "../src/webui/schedules";

interface ScheduleHttp extends Pick<AdminHttpContext, "status" | "body" | "set" | "get"> {
  request?: { body: unknown };
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

type ScheduleRoute = (http: ScheduleHttp) => Promise<void>;

function setup() {
  let handler: ScheduleRoute;
  const routes = new Map<string, ScheduleRoute>();
  const reads = new Map<string, ScheduleRoute>();
  const get = vi.fn(async () => [] as unknown[]);
  const session = { value: { role: "owner" } as { role: string } | undefined };
  const allowed = { value: true };
  const model = {
    available: true,
    list: get,
    runs: vi.fn(async (_id: string, _before?: string): Promise<ScheduleRunsSnapshot> => ({ runs: [], nextCursor: null, retainedLimit: 100 })),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const origin = { value: false };
  installSchedules(
    {
      get: () => (model.available ? model : undefined),
      server: {
        post: (path: string, fn: ScheduleRoute) => routes.set(path, fn),
        get: (path: string, fn: ScheduleRoute) => {
          reads.set(path, fn);
          if (path === SCHEDULES_PATH) handler = fn;
        },
      },
    } as never,
    { sessionFromCookie: () => session.value, sameOrigin: () => origin.value } as never,
    () => allowed.value,
  );
  return {
    get,
    session,
    allowed,
    model,
    origin,
    history: async (id = "task", query: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
      const http: ScheduleHttp = { status: 200, body: undefined, set: vi.fn(), get: (name) => headers[name] ?? "", params: { id }, query };
      await reads.get(`${SCHEDULES_PATH}/:id/runs`)!(http);
      return http;
    },
    write: async (operation: string, body: unknown) => {
      const http: ScheduleHttp = { status: 200, body: undefined, set: vi.fn(), get: () => "application/json", request: { body } };
      await routes.get(`${SCHEDULES_PATH}/${operation}`)!(http);
      return http;
    },
    request: async (headers: Record<string, string> = {}) => {
      const http: ScheduleHttp = { status: 200, body: undefined, set: vi.fn(), get: (name: string) => headers[name] ?? "" };
      await handler(http);
      return http;
    },
  };
}

it("lists all states and conversations, orders upcoming tasks and projects only public fields", async () => {
  const h = setup();
  const base = { title: "任务", prompt: "读取昨天的新闻", platform: "onebot", selfId: "bot", type: "direct", kind: "cron", cron: "0 9 * * *", at: null };
  h.get.mockResolvedValue([
    { ...base, id: "paused", channelId: "private:1", state: "paused", nextRunAt: null },
    { ...base, id: "later", channelId: "group", state: "enabled", nextRunAt: "2026-11-06T01:00:00Z" },
    { ...base, id: "cancelled", state: "cancelled", nextRunAt: null },
    { ...base, id: "done", state: "completed", nextRunAt: null },
    {
      ...base,
      id: "first",
      channelId: "wx-room",
      platform: "wechat-bridge",
      state: "enabled",
      nextRunAt: "2026-11-05T01:00:00Z",
      privateField: "hidden",
      notes: "先关广告再点签到",
      lastResult: { occurrenceAt: "2026-11-04T01:00:00Z", status: "failed", error: { message: "provider-secret" } },
    },
  ]);
  const response = await h.request();
  expect(h.get).toHaveBeenCalledExactlyOnceWith();
  expect((response.body as SchedulesSnapshot).tasks.map((task) => task.id)).toEqual(["first", "later", "cancelled", "done", "paused"]);
  expect((response.body as SchedulesSnapshot).tasks[0]).toMatchObject({
    platform: "wechat-bridge",
    delivery: "channel",
    notes: "先关广告再点签到",
    lastResult: { status: "failed" },
  });
  expect((response.body as SchedulesSnapshot).tasks[1].notes).toBeNull();
  expect(JSON.stringify(response.body)).not.toMatch(/provider-secret|privateField/);
  expect(response.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
});

it("blocks anonymous, parent member, forbidden plugin and cross-site reads before querying", async () => {
  const h = setup();
  h.session.value = undefined;
  expect((await h.request()).status).toBe(401);
  h.session.value = { role: "member" };
  expect((await h.request()).status).toBe(403);
  h.session.value = { role: "owner" };
  h.allowed.value = false;
  expect((await h.request()).status).toBe(403);
  h.allowed.value = true;
  expect((await h.request({ origin: "https://foreign.test" })).status).toBe(403);
  expect(h.get).not.toHaveBeenCalled();
});

it("distinguishes unavailable service, empty tasks and failed reads", async () => {
  const h = setup();
  h.model.available = false;
  expect((await h.request()).body).toEqual({ available: false, tasks: [] });
  expect(h.get).not.toHaveBeenCalled();
  h.model.available = true;
  expect((await h.request()).body).toEqual({ available: true, tasks: [] });
  h.get.mockRejectedValueOnce(new Error("private DB details"));
  const failed = await h.request();
  expect(failed.status).toBe(503);
  expect(failed.body).toEqual({ message: "schedules_unavailable" });
});

it("rechecks identity and plugin access after asynchronous reads", async () => {
  for (const mode of ["session", "permission"]) {
    const h = setup();
    h.get.mockImplementationOnce(async () => {
      if (mode === "session") h.session.value = undefined;
      else h.allowed.value = false;
      return [{ id: "private" }];
    });
    const response = await h.request();
    expect(response.status).toBe(mode === "session" ? 401 : 403);
    expect(JSON.stringify(response.body)).not.toContain("private");
  }
});

const mutation = { id: "task", revision: "a".repeat(64), patch: { title: "新标题", kind: "cron", cron: "0 10 * * *" } };
it("routes validated writes through the local scheduler service and protects writes", async () => {
  const h = setup();
  expect((await h.write("update", mutation)).status).toBe(403);
  h.origin.value = true;
  h.session.value = { role: "member" };
  expect((await h.write("update", mutation)).status).toBe(403);
  h.session.value = { role: "owner" };
  h.allowed.value = false;
  expect((await h.write("delete", { id: mutation.id, revision: mutation.revision })).status).toBe(403);
  expect(h.model.update).not.toHaveBeenCalled();
  h.allowed.value = true;
  expect((await h.write("update", mutation)).body).toEqual({ ok: true });
  expect(h.model.update).toHaveBeenCalledExactlyOnceWith(mutation.id, mutation.revision, mutation.patch);
  expect((await h.write("delete", { id: mutation.id, revision: mutation.revision })).body).toEqual({ ok: true, id: mutation.id });
  expect(h.model.delete).toHaveBeenCalledExactlyOnceWith(mutation.id, mutation.revision);
});
it("returns the saved schedule in the list view shape after an update", async () => {
  const h = setup();
  h.origin.value = true;
  const row = {
    id: "task",
    revision: "b".repeat(64),
    title: "新标题",
    prompt: "p",
    platform: "web",
    selfId: "bot",
    channelId: "c",
    type: "direct",
    kind: "cron",
    cron: "0 10 * * *",
    state: "enabled",
    nextRunAt: "2026-11-17T02:00:00Z",
    lastResult: null,
    secret: "hidden",
  };
  h.get.mockResolvedValue([{ ...row, id: "other" }, row]);
  const body = (await h.write("update", mutation)).body as { ok: boolean; task?: Record<string, unknown> };
  expect(body.ok).toBe(true);
  expect(body.task).toMatchObject({ id: "task", revision: row.revision, title: "新标题", notes: null, at: null, purpose: "task", delivery: "channel" });
  expect(body.task).not.toHaveProperty("secret");
  h.get.mockRejectedValue(new Error("down"));
  expect((await h.write("update", mutation)).body).toEqual({ ok: true });
});
it("rejects invalid content, rules, routing overrides and exposes safe conflicts", async () => {
  const h = setup();
  h.origin.value = true;
  for (const body of [
    null,
    { ...mutation, accountId: "other" },
    { ...mutation, revision: "old" },
    ...[
      { title: " " },
      { prompt: "x".repeat(2001) },
      { platform: "other" },
      { kind: "once", at: "2030-01-01T00:00:00Z", cron: "0 9 * * *" },
      { cron: "0 9 * * *" },
      { delivery: "bad" },
      { notes: "x".repeat(2001) },
      { notes: 1 },
      {},
    ].map((patch) => ({ ...mutation, patch })),
  ])
    expect((await h.write("update", body)).status).toBe(400);
  expect(h.model.update).not.toHaveBeenCalled();
  // Notes may be cleared.
  expect((await h.write("update", { ...mutation, patch: { notes: "" } })).body).toEqual({ ok: true });
  h.model.update.mockClear();
  h.model.update.mockRejectedValueOnce(new Error("schedule_changed"));
  expect((await h.write("update", mutation)).status).toBe(409);
  h.model.available = false;
  expect((await h.write("update", mutation)).status).toBe(503);
});

it("manages heartbeat purpose and preserves a silent check result", async () => {
  const h = setup();
  h.origin.value = true;
  const patch = { purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" };
  const response = await h.write("update", { id: "heartbeat", revision: "a".repeat(64), patch });
  expect(response.status).toBe(200);
  expect(h.model.update).toHaveBeenCalledWith("heartbeat", "a".repeat(64), patch);
  h.get.mockResolvedValue([
    {
      id: "heartbeat",
      platform: "onebot",
      kind: "cron",
      purpose: "heartbeat",
      state: "enabled",
      nextRunAt: "2026-11-13T01:00:00Z",
      lastResult: { occurrenceAt: "2026-11-13T00:30:00Z", status: "completed", notified: false },
    },
  ]);
  const snapshot = await h.request();
  expect((snapshot.body as SchedulesSnapshot).tasks[0]).toMatchObject({ purpose: "heartbeat", lastResult: { status: "completed", notified: false } });
});

it("reads paged execution metadata and projects safe failures without provider details", async () => {
  const h = setup();
  const run = {
    id: "run",
    scheduleId: "task",
    occurrenceAt: "2026-11-14T01:00:00Z",
    recordedAt: "2026-11-14T01:00:01Z",
    startedAt: "2026-11-14T01:00:02Z",
    finishedAt: "2026-11-14T01:01:00Z",
    turnId: "turn",
    status: "failed" as const,
    purpose: "task" as const,
    delivery: "channel" as const,
  };
  h.model.runs.mockResolvedValueOnce({
    runs: [
      { ...run, error: { code: "turn_failed", message: "provider-secret" }, privateField: "private" } as never,
      { ...run, id: "unknown", error: { code: "provider-secret", message: "provider-secret" } },
      { ...run, id: "foreign", scheduleId: "foreign" },
    ],
    nextCursor: "next",
    retainedLimit: 100,
  });
  const response = await h.history("task", { before: "cursor" });
  expect(h.model.runs).toHaveBeenCalledWith("task", "cursor");
  expect((response.body as ScheduleRunsSnapshot).runs).toHaveLength(2);
  expect((response.body as ScheduleRunsSnapshot).runs[0]).toMatchObject({ ...run, error: { code: "turn_failed", message: "执行轮次失败，未确认任务完成。" } });
  expect((response.body as ScheduleRunsSnapshot).nextCursor).toBe("next");
  expect((response.body as ScheduleRunsSnapshot).retainedLimit).toBe(100);
  expect(JSON.stringify(response.body)).not.toMatch(/provider-secret|privateField|foreign/);
  expect(response.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
});

it("protects history before querying and rechecks permission after asynchronous reads", async () => {
  const h = setup();
  h.session.value = undefined;
  expect((await h.history()).status).toBe(401);
  h.session.value = { role: "member" };
  expect((await h.history()).status).toBe(403);
  h.session.value = { role: "owner" };
  h.allowed.value = false;
  expect((await h.history()).status).toBe(403);
  h.allowed.value = true;
  expect((await h.history("task", {}, { origin: "https://foreign.test" })).status).toBe(403);
  expect(h.model.runs).not.toHaveBeenCalled();
  for (const mode of ["session", "permission"]) {
    h.session.value = { role: "owner" };
    h.allowed.value = true;
    h.model.runs.mockImplementationOnce(async () => {
      if (mode === "session") h.session.value = undefined;
      else h.allowed.value = false;
      return { runs: [{ scheduleId: "private" }] as never, nextCursor: null, retainedLimit: 100 };
    });
    const response = await h.history();
    expect(response.status).toBe(mode === "session" ? 401 : 403);
    expect(JSON.stringify(response.body)).not.toContain("private");
  }
});

it("validates history cursors and distinguishes absent, unavailable and empty histories", async () => {
  const h = setup();
  for (const query of [{ before: "" }, { before: ["cursor"] }, { before: "x".repeat(257) }, { before: "a/b" }, { accountId: "foreign" }]) {
    expect((await h.history("task", query)).status).toBe(400);
  }
  expect(h.model.runs).not.toHaveBeenCalled();
  expect((await h.history()).body).toEqual({ runs: [], nextCursor: null, retainedLimit: 100 });
  h.model.runs.mockRejectedValueOnce(new Error("invalid_schedule_cursor"));
  expect((await h.history()).status).toBe(400);
  h.model.runs.mockRejectedValueOnce(new Error("schedule_not_found"));
  expect((await h.history()).status).toBe(404);
  h.model.runs.mockRejectedValueOnce(new Error("private-db-details"));
  const failed = await h.history();
  expect(failed.status).toBe(503);
  expect(failed.body).toEqual({ message: "schedules_unavailable" });
  h.model.available = false;
  expect((await h.history()).status).toBe(503);
});

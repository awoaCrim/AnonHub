import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemClock } from "@yesimbot/foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFileToolJournal, type ToolJournalCall } from "../../../packages/agent-runtime/src/tool-journal.js";
import { reject } from "../src/errors.js";
import { ScheduleStore, type ScheduleScope } from "../src/store.js";
import { createScheduleTools } from "../src/tools.js";
import type { ScheduleCreateInput, ScheduleUpdateInput } from "../src/types.js";
import { disposeScheduleModels, scheduleModel, tableOf, type ScheduleModel } from "./support.js";

const sharedScope = { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1", selfId: "bot-1" } satisfies ScheduleScope;

const otherScope = { type: "guild", platform: "test", channelId: "other-room", guildId: "other-room", selfId: "bot-1" } satisfies ScheduleScope;

const directScope = { type: "direct", platform: "test", selfId: "bot-1", channelId: "room-1", userId: "user-1" } satisfies ScheduleScope;

const FUTURE = "2030-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

/** The Store on the SQLite table; fake timers drive the system clock. */
function newStore(model: ScheduleModel): ScheduleStore {
  return new ScheduleStore(tableOf(model), systemClock(), model);
}

describe("ScheduleStore", () => {
  let store: ScheduleStore;
  let model: ScheduleModel;
  const directories: string[] = [];

  async function journalDirectory() {
    const directory = await mkdtemp(join(tmpdir(), "yesimbot-schedule-journal-"));
    directories.push(directory);
    return directory;
  }

  beforeEach(async () => {
    model = await scheduleModel();
    store = newStore(model);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await disposeScheduleModels();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("records an old unsupported-platform heartbeat call as a known rejection with no schedule write and replays that result", async () => {
    const scope = { ...directScope, platform: "xiaoheihe" };
    const root = await journalDirectory();
    const create = vi.spyOn(model, "create");
    const set = vi.spyOn(model, "set");
    const remove = vi.spyOn(model, "remove");
    const rearm = vi.fn();
    const [tool] = createScheduleTools(scope, store, rearm);
    const input = { title: "半小时心跳", prompt: "检查相关新进展", purpose: "heartbeat", cron: "*/30 * * * *" };
    const call: ToolJournalCall = { turnId: "web-heartbeat", toolCallId: "create", toolName: tool.name, input };
    // A call generated from an older/frozen schema must still receive an accurate domain result.
    const execute = vi.fn(async () => tool.execute(input, {} as never));
    const result = await createFileToolJournal(root).execute(call, execute);
    expect(result).toMatchObject({ ok: false, executionStatus: "not_started", changed: false, error: { code: "heartbeat_requires_qq" } });
    expect(result).toHaveProperty("error.message", expect.stringContaining("网页私聊"));
    expect(await store.list(scope)).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
    expect(await createFileToolJournal(root).execute(call, execute)).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
    const resultFile = (await readdir(root)).find((name) => name.endsWith(".result.json"))!;
    expect(JSON.parse(await readFile(join(root, resultFile), "utf8"))).toMatchObject({ status: "completed", replayable: true, result });
  });

  it.each([
    ["once heartbeat", "onebot", { purpose: "heartbeat", at: FUTURE }, "heartbeat_requires_recurring"],
    ["invalid purpose", "web", { purpose: "other", cron: "*/30 * * * *" }, "invalid_purpose"],
    ["past instant", "web", { at: PAST }, "invalid_schedule"],
    ["too frequent cron", "web", { cron: "* * * * *" }, "invalid_schedule"],
  ])("returns a deterministic pre-write rejection for %s", async (_name, platform, rule, code) => {
    const scope = { ...directScope, platform };
    const root = await journalDirectory();
    const [tool] = createScheduleTools(scope, store);
    const input = { title: "测试", prompt: "测试", ...rule };
    const create = vi.spyOn(model, "create");
    const result = await createFileToolJournal(root).execute({ turnId: "invalid", toolCallId: "create", toolName: tool.name, input }, async () =>
      tool.execute(input, {} as never),
    );
    expect(result).toMatchObject({ ok: false, executionStatus: "not_started", changed: false, error: { code } });
    expect(create).not.toHaveBeenCalled();
    expect(await store.list(scope)).toEqual([]);
  });

  it.each([
    ["QQ heartbeat", "onebot", { purpose: "heartbeat", cron: "*/30 * * * *" }],
    ["web direct heartbeat", "web", { purpose: "heartbeat", cron: "*/30 * * * *" }],
    ["web recurring task", "web", { cron: "*/30 * * * *" }],
    ["web one-time task", "web", { at: FUTURE }],
  ])("creates %s once through the real store and durable journal", async (_name, platform, rule) => {
    const scope = { ...directScope, platform };
    const root = await journalDirectory();
    const rearm = vi.fn();
    const [tool] = createScheduleTools(scope, store, rearm);
    const input = { title: "测试", prompt: "测试", ...rule };
    const call = { turnId: "valid", toolCallId: "create", toolName: tool.name, input };
    const execute = vi.fn(async () => tool.execute(input, {} as never));
    const result = await createFileToolJournal(root).execute(call, execute);
    expect(result).toMatchObject({ id: expect.any(String), state: "enabled" });
    expect(await createFileToolJournal(root).execute(call, execute)).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(rearm).toHaveBeenCalledTimes(1);
    const [row] = await store.list(scope);
    expect(row).toMatchObject({ platform, channelId: scope.channelId, userId: scope.userId, purpose: "purpose" in rule ? rule.purpose : "task" });
  });

  it("rejects a task-to-heartbeat update on an unsupported platform without changing the existing row", async () => {
    const scope = { ...directScope, platform: "xiaoheihe" };
    const created = await store.create(scope, { title: "普通任务", prompt: "照常执行", kind: "cron", cron: "*/30 * * * *" });
    const before = await store.list(scope);
    const set = vi.spyOn(model, "set");
    const rearm = vi.fn();
    const [, , tool] = createScheduleTools(scope, store, rearm);
    const root = await journalDirectory();
    const input = { id: created.id, title: "不应保存", purpose: "heartbeat" };
    const result = await createFileToolJournal(root).execute({ turnId: "update", toolCallId: "update", toolName: tool.name, input }, async () =>
      tool.execute(input, {} as never),
    );
    expect(result).toMatchObject({ ok: false, changed: false, error: { code: "heartbeat_requires_qq" } });
    expect(set).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
    expect(await store.list(scope)).toEqual(before);
  });

  it("accepts a web direct task-to-heartbeat update but rejects a web group one", async () => {
    const web = { ...directScope, platform: "web" };
    const created = await store.create(web, { title: "普通任务", prompt: "照常执行", kind: "cron", cron: "*/30 * * * *" });
    expect(await store.update(web, created.id, { purpose: "heartbeat" })).toMatchObject({ purpose: "heartbeat" });
    const group = { ...sharedScope, platform: "web" };
    await expect(store.create(group, { title: "心跳", prompt: "检查", purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" })).rejects.toMatchObject({
      code: "heartbeat_requires_qq",
    });
  });

  it("keeps a QQ heartbeat unchanged when an update would make it a one-time task", async () => {
    const scope = { ...directScope, platform: "onebot" };
    const created = await store.create(scope, { title: "心跳", prompt: "检查", purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" });
    const before = await store.list(scope);
    const set = vi.spyOn(model, "set");
    const [, , tool] = createScheduleTools(scope, store);
    expect(await tool.execute({ id: created.id, at: FUTURE }, {} as never)).toMatchObject({
      ok: false,
      changed: false,
      error: { code: "heartbeat_requires_recurring" },
    });
    expect(set).not.toHaveBeenCalled();
    expect(await store.list(scope)).toEqual(before);
  });

  it.each(["update", "paused", "enabled", "cancelled"])("reports a missing scoped schedule from %s without changing another conversation", async (name) => {
    const created = await store.create(otherScope, { title: "别的会话", prompt: "保持", kind: "once", at: FUTURE });
    const before = await store.listAll();
    const tool = createScheduleTools(sharedScope, store).find((item) => item.name === "schedule_update")!;
    const root = await journalDirectory();
    const input = name === "update" ? { id: created.id, title: "改名" } : { id: created.id, state: name };
    const result = await createFileToolJournal(root).execute({ turnId: "wrong-scope", toolCallId: name, toolName: "schedule_update", input }, async () =>
      tool.execute(input, {} as never),
    );
    expect(result).toMatchObject({ ok: false, executionStatus: "not_started", changed: false, error: { code: "schedule_not_found" } });
    expect(await store.listAll()).toEqual(before);
  });

  it("keeps an ordinary store error unknown even when its text/code resembles a domain rejection", async () => {
    const root = await journalDirectory();
    const [tool] = createScheduleTools(sharedScope, store);
    const input = { title: "测试", prompt: "测试", cron: "*/30 * * * *" };
    const call = { turnId: "io", toolCallId: "create", toolName: tool.name, input };
    const get = vi
      .spyOn(model, "get")
      .mockRejectedValueOnce(Object.assign(new Error("heartbeat requires a recurring QQ schedule"), { code: "heartbeat_requires_qq" }));
    const execute = vi.fn(async () => tool.execute(input, {} as never));
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown", automaticReplayBlocked: true });
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown", automaticReplayBlocked: true });
    expect(get).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["write", "rearm"])("keeps a post-%s failure unknown and never repeats the real write", async (failure) => {
    const root = await journalDirectory();
    const original = model.create.bind(model);
    const create = vi.spyOn(model, "create").mockImplementation(async (...args) => {
      const row = await original(...args);
      if (failure === "write") throw new Error("write completed, acknowledgement lost");
      return row;
    });
    const rearm = vi.fn(async () => {
      // Even this type must not be converted after a successful store mutation.
      throw reject("invalid_schedule", "post-write scheduling failure");
    });
    const [tool] = createScheduleTools(sharedScope, store, rearm);
    const input = { title: "只写一次", prompt: "测试", cron: "*/30 * * * *" };
    const call = { turnId: "post-write", toolCallId: "create", toolName: tool.name, input };
    const execute = vi.fn(async () => tool.execute(input, {} as never));
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown", automaticReplayBlocked: true });
    expect(await createFileToolJournal(root).execute(call, execute)).toMatchObject({ code: "execution_unknown", automaticReplayBlocked: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await store.list(sharedScope)).toHaveLength(1);
    expect(rearm).toHaveBeenCalledTimes(failure === "rearm" ? 1 : 0);
  });

  it("edits and deletes managed tasks with revision checks serialized against agent changes", async () => {
    const created = await store.create(sharedScope, { title: "早报", prompt: "新闻", kind: "cron", cron: "0 9 * * *" });
    const first = (await store.listAll())[0];
    await store.updateManaged(created.id, first.revision, { kind: "cron", cron: "0 10 * * *", title: "新早报" });
    const updated = (await store.listAll())[0];
    expect(updated.title).toBe("新早报");
    expect(updated.nextRunAt).not.toBe(first.nextRunAt);
    await expect(store.deleteManaged(created.id, first.revision)).rejects.toThrow("schedule_changed");
    await store.update(sharedScope, created.id, { prompt: "代理更新" });
    await expect(store.updateManaged(created.id, updated.revision, { title: "覆盖" })).rejects.toThrow("schedule_changed");
    const latest = (await store.listAll())[0];
    await store.deleteManaged(created.id, latest.revision);
    expect(await store.listEnabled()).toEqual([]);
    await expect(store.deleteManaged(created.id, latest.revision)).rejects.toThrow("schedule_not_found");
  });

  it("preserves paused state, rejects invalid edits and prevents a deleted task from being claimed", async () => {
    const created = await store.create(sharedScope, { title: "提醒", prompt: "内容", kind: "once", at: FUTURE });
    await store.pause(sharedScope, created.id);
    let task = (await store.listAll())[0];
    await store.updateManaged(task.id, task.revision, { kind: "cron", cron: "0 9 * * *" });
    task = (await store.listAll())[0];
    expect(task.state).toBe("paused");
    expect(task.nextRunAt).toBeNull();
    await expect(store.updateManaged(task.id, task.revision, { prompt: " " })).rejects.toMatchObject({
      code: "invalid_schedule",
      detail: expect.stringContaining("empty"),
    });
    await expect(store.updateManaged(task.id, task.revision, { kind: "cron", cron: "* * * * *" })).rejects.toMatchObject({
      code: "invalid_schedule",
      detail: expect.stringContaining("15"),
    });
    await store.deleteManaged(task.id, task.revision);
    expect(await store.claim(task.id, FUTURE)).toBeNull();
  });

  it("creates a valid once schedule with the raw scope fields", async () => {
    const schedule = await store.create(sharedScope, { title: "Standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE });

    expect(schedule).toMatchObject({
      type: "guild",
      platform: "test",
      channelId: "room-1",
      title: "Standup",
      prompt: "Prepare the daily standup.",
      delivery: "channel",
      kind: "once",
      at: FUTURE,
      state: "enabled",
      nextRunAt: FUTURE,
    });
    expect(schedule.id).toBeDefined();
    expect(schedule.lastResult).toBeUndefined();
  });

  it("persists and updates silent delivery without changing the schedule rule", async () => {
    const created = await store.create(sharedScope, {
      title: "Memory maintenance",
      prompt: "Update memory without replying.",
      delivery: "silent",
      kind: "once",
      at: FUTURE,
    });
    expect(created.delivery).toBe("silent");

    const updated = await store.update(sharedScope, created.id, { delivery: "channel" });
    expect(updated.delivery).toBe("channel");
    expect(updated.kind).toBe("once");
    expect(updated.at).toBe(FUTURE);
    expect(updated.nextRunAt).toBe(FUTURE);
  });

  it("rejects a cron interval below the 15-minute limit", async () => {
    await expect(
      store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "cron", cron: "*/5 * * * *" }),
    ).rejects.toMatchObject({ code: "invalid_schedule", detail: expect.stringContaining("15 minutes") });
  });

  it("computes the next Asia/Shanghai occurrence for a weekday cron", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));

    const schedule = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "cron", cron: "0 9 * * 1-5" });

    // 09:00 Asia/Shanghai on Friday 2026-07-31 is 01:00 UTC.
    expect(schedule.nextRunAt).toBe("2026-07-31T01:00:00.000Z");
  });

  it("interprets cron fields in fixed Asia/Shanghai time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));

    const schedule = await store.create(sharedScope, { title: "midnight", prompt: "Fire at local midnight.", kind: "cron", cron: "0 0 * * *" });

    // 00:00 Asia/Shanghai on 2026-08-01 is 16:00 UTC on 2026-07-31.
    expect(schedule.nextRunAt).toBe("2026-07-31T16:00:00.000Z");
  });

  it("rejects a past once instant", async () => {
    await expect(store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: PAST })).rejects.toMatchObject({
      code: "invalid_schedule",
      detail: expect.stringContaining("in the future"),
    });
  });

  it("rejects an input that provides both rule forms", async () => {
    // A runtime value with both at and cron is outside the create input union.
    const input = { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE, cron: "0 9 * * 1-5" } as unknown as ScheduleCreateInput;

    await expect(store.create(sharedScope, input)).rejects.toMatchObject({ code: "invalid_schedule", detail: expect.stringContaining("exactly one") });
  });

  it("rejects an input that provides no rule", async () => {
    // A runtime value without a rule is outside the create input union.
    const input = { title: "standup", prompt: "Prepare the daily standup." } as unknown as ScheduleCreateInput;

    await expect(store.create(sharedScope, input)).rejects.toMatchObject({ code: "invalid_schedule", detail: expect.stringContaining("exactly one") });
  });

  it("rejects the twenty-first enabled schedule in one scope", { timeout: 20_000 }, async () => {
    for (let i = 0; i < 20; i++) {
      await store.create(sharedScope, { title: `schedule-${i}`, prompt: "Prepare the daily standup.", kind: "cron", cron: "0 9 * * 1-5" });
    }

    await expect(
      store.create(sharedScope, { title: "overflow", prompt: "Prepare the daily standup.", kind: "cron", cron: "0 9 * * 1-5" }),
    ).rejects.toMatchObject({ code: "schedule_limit_reached", detail: expect.stringContaining("20 enabled schedules") });
  });

  it("enforces the 120-character title and 2000-character prompt limits", async () => {
    await expect(store.create(sharedScope, { title: "x".repeat(121), prompt: "Prepare the daily standup.", kind: "once", at: FUTURE })).rejects.toMatchObject({
      code: "invalid_schedule",
      detail: expect.stringContaining("120 characters"),
    });

    await expect(store.create(sharedScope, { title: "standup", prompt: "x".repeat(2001), kind: "once", at: FUTURE })).rejects.toMatchObject({
      code: "invalid_schedule",
      detail: expect.stringContaining("2000 characters"),
    });
  });

  it("lists only rows of the exact scope", async () => {
    await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE });

    expect(await store.list(sharedScope)).toHaveLength(1);
    expect(await store.list(otherScope)).toEqual([]);
    // A direct scope over the same channel id is a different channel row.
    expect(await store.list(directScope)).toEqual([]);
  });

  it("initializes the audit timestamps on create", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));

    const schedule = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE });

    expect(schedule.createdAt).toBe("2026-07-31T00:00:00.000Z");
    expect(schedule.updatedAt).toBe("2026-07-31T00:00:00.000Z");
  });

  it("advances updatedAt on each mutation and preserves createdAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE });

    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const updated = await store.update(sharedScope, created.id, { title: "standup v2" });
    expect(updated.createdAt).toBe("2026-07-31T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-08-01T00:00:00.000Z");

    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
    const paused = await store.pause(sharedScope, created.id);
    expect(paused.createdAt).toBe("2026-07-31T00:00:00.000Z");
    expect(paused.updatedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("pauses an enabled schedule and clears its next run", async () => {
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE });

    const paused = await store.pause(sharedScope, created.id);
    expect(paused.state).toBe("paused");
    expect(paused.nextRunAt).toBeNull();
    expect(paused.prompt).toBe("Prepare the daily standup.");

    await expect(store.pause(sharedScope, created.id)).rejects.toMatchObject({
      code: "invalid_schedule_state",
      detail: expect.stringContaining("not enabled"),
    });
  });

  it("resumes a paused schedule to its next future occurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));

    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "cron", cron: "0 9 * * 1-5" });
    await store.pause(sharedScope, created.id);

    const resumed = await store.resume(sharedScope, created.id);
    expect(resumed.state).toBe("enabled");
    expect(resumed.nextRunAt).toBe("2026-07-31T01:00:00.000Z");

    await expect(store.resume(sharedScope, created.id)).rejects.toMatchObject({
      code: "invalid_schedule_state",
      detail: expect.stringContaining("not paused"),
    });
  });

  it("refuses to resume a once schedule with no future occurrence", async () => {
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: "2030-01-01T00:00:00.000Z" });
    await store.pause(sharedScope, created.id);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));

    await expect(store.resume(sharedScope, created.id)).rejects.toMatchObject({
      code: "invalid_schedule_state",
      detail: expect.stringContaining("no future occurrence"),
    });
  });

  it("rejects resume when twenty enabled schedules already occupy its exact scope", { timeout: 20_000 }, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    const paused = await store.create(sharedScope, { title: "paused", prompt: "Wait.", kind: "cron", cron: "0 9 * * 1-5" });
    await store.pause(sharedScope, paused.id);
    for (let i = 0; i < 20; i++) {
      await store.create(sharedScope, { title: `replacement-${i}`, prompt: "Run.", kind: "cron", cron: "0 9 * * 1-5" });
    }

    await expect(store.resume(sharedScope, paused.id)).rejects.toMatchObject({
      code: "schedule_limit_reached",
      detail: expect.stringContaining("20 enabled schedules"),
    });
    const row = (await store.list(sharedScope)).find((schedule) => schedule.id === paused.id)!;
    expect(row).toMatchObject({ id: paused.id, state: "paused", nextRunAt: null });
  });

  it("recovers an interrupted cron claim by advancing beyond elapsed next work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const created = await store.create(sharedScope, { title: "quarterly", prompt: "Ping.", kind: "cron", cron: "*/15 * * * *" });
    vi.setSystemTime(new Date("2026-08-01T00:15:00.000Z"));
    await store.claim(created.id, created.nextRunAt!);

    // 00:30 passed eleven minutes ago: outside the replay window.
    await store.recover(new Date("2026-08-01T00:41:00.000Z"));

    const [row] = await store.list(sharedScope);
    expect(row.lastResult).toMatchObject({ occurrenceAt: "2026-08-01T00:15:00.000Z", status: "interrupted" });
    expect(row.nextRunAt).toBe("2026-08-01T00:45:00.000Z");
  });

  it("keeps a late occurrence inside the ten-minute window as the next run, once and cron alike", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const once = await store.create(sharedScope, { title: "once", prompt: "Ping.", kind: "once", at: "2026-08-01T00:20:00.000Z" });
    const cron = await store.create(sharedScope, { title: "cron", prompt: "Ping.", kind: "cron", cron: "*/15 * * * *" });
    const late = await store.create(otherScope, { title: "late", prompt: "Ping.", kind: "once", at: "2026-08-01T00:10:00.000Z" });

    const repairs = await store.recover(new Date("2026-08-01T00:25:00.000Z"));

    const rows = await store.listAll();
    const byId = (id: string) => rows.find((row) => row.id === id)!;
    expect(byId(once.id)).toMatchObject({ state: "enabled", nextRunAt: "2026-08-01T00:20:00.000Z" });
    expect(byId(once.id).lastResult).toBeUndefined();
    // 00:15 is ten minutes late, inside the window (inclusive).
    expect(byId(cron.id)).toMatchObject({ state: "enabled", nextRunAt: "2026-08-01T00:15:00.000Z" });
    expect(byId(late.id)).toMatchObject({ state: "completed", nextRunAt: null, lastResult: { occurrenceAt: "2026-08-01T00:10:00.000Z", status: "missed" } });
    expect(repairs).toEqual(
      expect.arrayContaining([
        { id: once.id, title: "once", occurrenceAt: "2026-08-01T00:20:00.000Z", status: "replay" },
        { id: cron.id, title: "cron", occurrenceAt: "2026-08-01T00:15:00.000Z", status: "replay" },
        { id: late.id, title: "late", occurrenceAt: "2026-08-01T00:10:00.000Z", status: "missed" },
      ]),
    );
  });

  it("stores the private chat's user, mapping a OneBot private:<id> channel back to the user", async () => {
    const direct = await store.create(directScope, { title: "d", prompt: "p", kind: "once", at: FUTURE });
    expect(direct.userId).toBe("user-1");
    const onebot = { type: "direct", platform: "onebot", selfId: "bot", channelId: "private:42", userId: "private:42" } satisfies ScheduleScope;
    expect((await store.create(onebot, { title: "o", prompt: "p", kind: "once", at: FUTURE })).userId).toBe("42");
    expect((await store.create(sharedScope, { title: "g", prompt: "p", kind: "once", at: FUTURE })).userId).toBeUndefined();
  });

  it("replaces, keeps and clears the bot's notes without touching the title or prompt", async () => {
    const created = await store.create(sharedScope, { title: "签到", prompt: "每天签到", kind: "cron", cron: "0 9 * * *" });
    expect(created.notes).toBeUndefined();
    const noted = await store.update(sharedScope, created.id, { notes: "  用 computer_cua 点签到按钮。 " });
    expect(noted).toMatchObject({ title: "签到", prompt: "每天签到", notes: "用 computer_cua 点签到按钮。" });
    expect((await store.update(sharedScope, created.id, { kind: "cron", cron: "0 10 * * *" })).notes).toBe("用 computer_cua 点签到按钮。");
    await expect(store.update(sharedScope, created.id, { notes: "x".repeat(2001) })).rejects.toMatchObject({
      code: "invalid_schedule",
      detail: expect.stringContaining("notes must not exceed 2000"),
    });
    await expect(store.update(otherScope, created.id, { notes: "foreign" })).rejects.toMatchObject({
      code: "schedule_not_found",
      detail: expect.stringContaining("not found"),
    });
    expect((await store.update(sharedScope, created.id, { notes: "" })).notes).toBeUndefined();
  });

  it("cancels a schedule and prevents later lifecycle operations", async () => {
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE });

    const cancelled = await store.cancel(sharedScope, created.id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.nextRunAt).toBeNull();

    await expect(store.cancel(sharedScope, created.id)).rejects.toMatchObject({
      code: "invalid_schedule_state",
      detail: expect.stringContaining("cannot be cancelled"),
    });
  });

  it("updates title, prompt, and the rule with validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));

    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE });

    const updated = await store.update(sharedScope, created.id, { title: "standup v2", kind: "cron", cron: "0 10 * * 1-5" });
    expect(updated.title).toBe("standup v2");
    expect(updated.kind).toBe("cron");
    expect(updated.cron).toBe("0 10 * * 1-5");
    // 10:00 Asia/Shanghai on Friday 2026-07-31 is 02:00 UTC.
    expect(updated.nextRunAt).toBe("2026-07-31T02:00:00.000Z");

    await expect(store.update(sharedScope, created.id, { kind: "once", at: PAST })).rejects.toMatchObject({
      code: "invalid_schedule",
      detail: expect.stringContaining("in the future"),
    });
  });

  it("allows a title update on a due once schedule without re-validating its rule", async () => {
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: "2030-01-01T00:00:00.000Z" });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));

    const updated = await store.update(sharedScope, created.id, { title: "standup v2" });
    expect(updated.title).toBe("standup v2");
    expect(updated.nextRunAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("keeps a paused schedule unarmed across a rule update", async () => {
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE });
    await store.pause(sharedScope, created.id);

    const updated = await store.update(sharedScope, created.id, { kind: "cron", cron: "0 9 * * 1-5" });
    expect(updated.state).toBe("paused");
    expect(updated.nextRunAt).toBeNull();
    expect(updated.cron).toBe("0 9 * * 1-5");
  });

  it("rejects rule changes on a cancelled schedule", async () => {
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: FUTURE });
    await store.cancel(sharedScope, created.id);

    await expect(store.update(sharedScope, created.id, { kind: "cron", cron: "0 9 * * 1-5" })).rejects.toMatchObject({
      code: "invalid_schedule_state",
      detail: expect.stringContaining("cannot change its rule"),
    });
  });

  it("rejects operations on unknown schedule ids", async () => {
    const input: ScheduleUpdateInput = { title: "renamed" };
    await expect(store.update(sharedScope, "missing", input)).rejects.toMatchObject({
      code: "schedule_not_found",
      detail: expect.stringContaining("not found"),
    });
    await expect(store.pause(sharedScope, "missing")).rejects.toMatchObject({ code: "schedule_not_found", detail: expect.stringContaining("not found") });
    await expect(store.resume(sharedScope, "missing")).rejects.toMatchObject({ code: "schedule_not_found", detail: expect.stringContaining("not found") });
    await expect(store.cancel(sharedScope, "missing")).rejects.toMatchObject({ code: "schedule_not_found", detail: expect.stringContaining("not found") });
  });

  it("keeps legacy latest results out of history and enforces the exact conversation scope", async () => {
    const task = await store.create(sharedScope, { title: "legacy", prompt: "p", kind: "once", at: FUTURE });
    await model.set("yesimbot_schedule", { id: task.id }, { lastResult: { occurrenceAt: PAST, status: "accepted" }, runs: null });
    expect(await store.listRunsManaged(task.id)).toEqual({ runs: [], nextCursor: null, retainedLimit: 100 });
    for (const scope of [otherScope, directScope, { ...sharedScope, platform: "other" }, { ...sharedScope, selfId: "other" }]) {
      await expect(store.listRuns(scope as ScheduleScope, task.id)).rejects.toMatchObject({
        code: "schedule_not_found",
        detail: expect.stringContaining("not found"),
      });
    }
    await expect(store.listRunsManaged("foreign")).rejects.toThrow("schedule_not_found");
  });

  it("persists admission, actual start and completion without inventing an external result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const task = await store.create(sharedScope, { title: "run", prompt: "p", kind: "once", at: FUTURE });
    await store.claim(task.id, FUTURE);
    const queued = (await store.listRuns(sharedScope, task.id)).runs[0];
    expect(queued).toMatchObject({
      scheduleId: task.id,
      occurrenceAt: FUTURE,
      status: "queued",
      queuedAt: "2026-08-01T00:00:00.000Z",
      purpose: "task",
      delivery: "channel",
    });
    expect(queued.startedAt).toBeUndefined();
    expect(queued.finishedAt).toBeUndefined();
    vi.setSystemTime(new Date("2026-08-01T00:01:00.000Z"));
    await store.started(task.id, FUTURE, { turnId: "turn-1", startedAt: new Date().toISOString() });
    await store.started(task.id, FUTURE, { turnId: "duplicate", startedAt: new Date().toISOString() });
    expect((await store.listRunsManaged(task.id)).runs[0]).toMatchObject({ status: "running", turnId: "turn-1", startedAt: "2026-08-01T00:01:00.000Z" });
    vi.setSystemTime(new Date("2026-08-01T00:02:00.000Z"));
    await store.finish(task.id, FUTURE, "completed");
    const restored = await newStore(model).listRunsManaged(task.id);
    expect(restored.runs[0]).toMatchObject({ id: queued.id, status: "completed", finishedAt: "2026-08-01T00:02:00.000Z" });
    expect(restored.runs[0]).not.toHaveProperty("result");
    expect((await store.listAll())[0]).not.toHaveProperty("runs");
    expect(await store.finish(task.id, FUTURE, "failed")).toBeNull();
  });

  it("finishes every overlapping occurrence without overwriting the latest summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const task = await store.create(sharedScope, { title: "run", prompt: "p", kind: "cron", cron: "*/15 * * * *" });
    vi.setSystemTime(new Date(task.nextRunAt!));
    const first = await store.claim(task.id, task.nextRunAt!);
    vi.setSystemTime(new Date(first!.nextRunAt!));
    await store.update(sharedScope, task.id, { delivery: "silent" });
    await store.claim(task.id, first!.nextRunAt!);
    await store.finish(task.id, first!.nextRunAt!, "failed", { name: "Error", message: "provider-secret" }, undefined, "turn_failed");
    await store.finish(task.id, task.nextRunAt!, "completed");
    const history = (await store.listRunsManaged(task.id)).runs;
    expect(history.map((run) => [run.occurrenceAt, run.status, run.delivery])).toEqual([
      [first!.nextRunAt, "failed", "silent"],
      [task.nextRunAt, "completed", "channel"],
    ]);
    expect(JSON.stringify(history)).not.toContain("provider-secret");
    expect((await store.list(sharedScope))[0].lastResult).toMatchObject({ occurrenceAt: first!.nextRunAt, status: "failed" });
  });

  it("serializes an old Store's finish with a reloaded Store's claim through the same table", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const task = await store.create(sharedScope, { title: "reload", prompt: "p", kind: "cron", cron: "*/15 * * * *" });
    vi.setSystemTime(new Date(task.nextRunAt!));
    const first = await store.claim(task.id, task.nextRunAt!);
    const replacement = newStore(model);
    let entered!: () => void;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const reading = new Promise<void>((done) => {
      entered = done;
    });
    const originalGet = model.get.bind(model);
    const get = vi.spyOn(model, "get").mockImplementationOnce(async (...args) => {
      const rows = await originalGet(...args);
      entered();
      await gate;
      return rows;
    });
    try {
      const finishing = store.finish(task.id, task.nextRunAt!, "completed");
      await reading;
      vi.setSystemTime(new Date(first!.nextRunAt!));
      const claiming = replacement.claim(task.id, first!.nextRunAt!);
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledOnce();
      release();
      await Promise.all([finishing, claiming]);
      expect((await replacement.listRunsManaged(task.id)).runs.map((run) => run.status)).toEqual(["queued", "completed"]);
      expect((await replacement.list(sharedScope))[0].lastResult).toMatchObject({ occurrenceAt: first!.nextRunAt, status: "submitting" });
    } finally {
      release();
    }
  });

  it("marks all persisted in-flight receipts interrupted on restart without replay or backfill", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const task = await store.create(sharedScope, { title: "run", prompt: "p", kind: "cron", cron: "*/15 * * * *" });
    vi.setSystemTime(new Date(task.nextRunAt!));
    const first = await store.claim(task.id, task.nextRunAt!);
    await store.started(task.id, task.nextRunAt!, { turnId: "first", startedAt: new Date().toISOString() });
    vi.setSystemTime(new Date(first!.nextRunAt!));
    await store.claim(task.id, first!.nextRunAt!);
    const recovered = newStore(model);
    await recovered.recover(new Date("2026-08-01T00:31:00.000Z"));
    const history = (await recovered.listRunsManaged(task.id)).runs;
    expect(history).toHaveLength(2);
    expect(history.every((run) => run.status === "interrupted" && run.error?.code === "process_interrupted")).toBe(true);
    expect(history[0].startedAt).toBeUndefined();
    expect(history[1].turnId).toBe("first");
    expect((await recovered.list(sharedScope))[0].nextRunAt).toBe("2026-08-01T00:45:00.000Z");
    expect(await recovered.finish(task.id, task.nextRunAt!, "completed")).toBeNull();
  });

  it("retains one hundred recent terminal receipts plus active runs, with stable pagination", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    let task = await store.create(sharedScope, { title: "run", prompt: "p", kind: "cron", cron: "*/15 * * * *" });
    const pending = task.nextRunAt!;
    for (let i = 0; i < 104; i++) {
      const occurrence = task.nextRunAt!;
      vi.setSystemTime(new Date(occurrence));
      task = (await store.claim(task.id, occurrence))!;
      if (i !== 0) await store.finish(task.id, occurrence, "completed");
    }
    const first = await store.listRunsManaged(task.id);
    expect(first.runs).toHaveLength(20);
    expect(first.nextCursor).toBeTypeOf("string");
    const occurrence = task.nextRunAt!;
    vi.setSystemTime(new Date(occurrence));
    await store.claim(task.id, occurrence);
    await store.finish(task.id, occurrence, "completed");
    const all = [...first.runs];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await store.listRunsManaged(task.id, cursor);
      all.push(...page.runs);
      cursor = page.nextCursor;
    }
    expect(new Set(all.map((run) => run.id)).size).toBe(all.length);
    expect(all.find((run) => run.occurrenceAt === pending)?.status).toBe("queued");
    const persisted = (await model.get("yesimbot_schedule", { id: task.id }))[0].runs!;
    expect(persisted).toHaveLength(101);
    expect(persisted.filter((run) => run.status === "completed")).toHaveLength(100);
    const other = await store.create(otherScope, { title: "other", prompt: "p", kind: "once", at: FUTURE });
    await expect(store.listRunsManaged(other.id, first.nextCursor!)).rejects.toThrow("invalid_schedule_cursor");
    for (const cursor of ["", "not-a-cursor", Buffer.from(JSON.stringify([task.id, -1])).toString("base64url")]) {
      await expect(store.listRunsManaged(task.id, cursor)).rejects.toThrow("invalid_schedule_cursor");
    }
  });

  it("keeps unknown outcomes unknown and records a known missed occurrence without a start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const task = await store.create(sharedScope, { title: "unknown", prompt: "p", kind: "once", at: "2026-08-01T00:15:00.000Z" });
    await store.claim(task.id, task.nextRunAt!);
    await store.finish(task.id, task.nextRunAt!, "accepted");
    expect((await store.listRunsManaged(task.id)).runs[0]).toMatchObject({ status: "accepted" });
    expect((await store.listRunsManaged(task.id)).runs[0].finishedAt).toBeUndefined();
    const missed = await store.create(otherScope, { title: "missed", prompt: "p", kind: "once", at: "2026-08-01T00:15:00.000Z" });
    await store.recover(new Date("2026-08-01T00:26:00.000Z"));
    const receipt = (await store.listRunsManaged(missed.id)).runs[0];
    expect(receipt).toMatchObject({ status: "missed", error: { code: "overdue" } });
    expect(receipt.queuedAt).toBeUndefined();
    expect(receipt.startedAt).toBeUndefined();
  });
});

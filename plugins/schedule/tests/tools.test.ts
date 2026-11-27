import type { AgentTool } from "@yesimbot/agent-runtime";
import { asSchema } from "ai";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { z } from "zod/v4";

import { reject } from "../src/errors.js";
import type { ScheduleStore, ScheduleScope } from "../src/store.js";
import { createScheduleTools } from "../src/tools.js";
import type { Schedule, ScheduleProjection } from "../src/types.js";

const TOOL_NAMES = ["schedule_create", "schedule_list", "schedule_update"] as const;

const scope = { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1", selfId: "bot-1" } satisfies ScheduleScope;

type StoreDouble = { create: Mock; list: Mock; update: Mock; pause: Mock; resume: Mock; cancel: Mock };

function createStoreDouble() {
  return { create: vi.fn(), list: vi.fn(), update: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
}

function createTools(store: StoreDouble): AgentTool[] {
  return createScheduleTools(scope, store as unknown as ScheduleStore);
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s-1",
    type: "shared",
    platform: "test",
    selfId: "bot-1",
    channelId: "room-1",
    title: "Standup",
    prompt: "Run the daily standup.",
    delivery: "channel",
    kind: "once",
    at: "2030-01-01T00:00:00.000Z",
    state: "enabled",
    nextRunAt: "2030-01-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as Schedule;
}

function validator(tool: AgentTool): (input: unknown) => boolean {
  return (input) => (tool.inputSchema as z.ZodType).safeParse(input).success;
}

async function execute(tool: AgentTool, input: unknown): Promise<unknown> {
  return tool.execute!(input, {} as never);
}

describe("schedule agent tools", () => {
  it("exposes exactly the three schedule management tools in order", () => {
    expect(createTools(createStoreDouble()).map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  });

  it("create schema accepts exactly one canonical rule and rejects channel targets", () => {
    const [createTool] = createTools(createStoreDouble());
    const validate = validator(createTool);
    expect(validate({ title: "Standup", prompt: "Run it.", at: "2030-01-01T00:00:00Z" })).toBe(true);
    expect(validate({ title: "Standup", prompt: "Run it.", cron: "0 9 * * 1" })).toBe(true);
    expect(validate({ title: "Standup", prompt: "Run it.", delivery: "silent", cron: "0 9 * * 1" })).toBe(true);
    expect(validate({ title: "Standup", prompt: "Run it.", delivery: "unknown", cron: "0 9 * * 1" })).toBe(false);
    expect(validate({ title: "Standup", prompt: "Run it." })).toBe(false);
    expect(validate({ title: "Standup", prompt: "Run it.", at: "2030-01-01T00:00:00Z", cron: "0 9 * * 1" })).toBe(false);
    expect(validate({ title: "Standup", prompt: "Run it.", at: "2030-01-01T00:00:00Z", channelId: "room-1" })).toBe(false);
    expect(validate({ title: "Standup", prompt: "Run it.", at: "2030-01-01T00:00:00Z", platform: "onebot" })).toBe(false);
    expect(validate({ title: "Standup", prompt: "Run it.", at: "2030-01-01T00:00:00Z", selfId: "bot-1" })).toBe(false);
  });

  it("offers heartbeats only in QQ and web direct conversations without adding target parameters", () => {
    const webScope = { type: "direct", platform: "web", selfId: "web", channelId: "web-user", userId: "web-user" } satisfies ScheduleScope;
    const qqScope = { type: "direct", platform: "onebot", selfId: "qq-bot", channelId: "private:user", userId: "user" } satisfies ScheduleScope;
    const webGroup = { type: "guild", platform: "web", selfId: "web", channelId: "room", guildId: "room" } satisfies ScheduleScope;
    const otherScope = { type: "direct", platform: "xiaoheihe", selfId: "x", channelId: "u", userId: "u" } satisfies ScheduleScope;
    for (const current of [webScope, qqScope, webGroup, otherScope]) {
      const allowed = current === webScope || current === qqScope;
      const [createTool, , updateTool] = createScheduleTools(current, createStoreDouble() as unknown as ScheduleStore);
      const create = validator(createTool);
      const update = validator(updateTool);
      expect(create({ title: "检查", prompt: "检查进展", purpose: "task", cron: "*/30 * * * *" })).toBe(true);
      expect(create({ title: "检查", prompt: "检查进展", purpose: "heartbeat", cron: "*/30 * * * *" })).toBe(allowed);
      expect(update({ id: "s-1", purpose: "heartbeat" })).toBe(allowed);
      expect(create({ title: "检查", prompt: "检查进展", cron: "*/30 * * * *", platform: "onebot", channelId: "other" })).toBe(false);
      expect(update({ id: "s-1", channelId: "other" })).toBe(false);
      if (current === webScope) expect(createTool.description).toContain("网页私聊");
      if (!allowed) {
        expect(createTool.description).toContain("当前会话不支持心跳");
        expect(createTool.description).toContain("该 QQ 会话或网页私聊");
        expect(createTool.description).not.toContain("cron=*/30");
      }
    }
  });

  it("update schema permits a rule replacement or none and rejects channel targets", () => {
    const [, , updateTool] = createTools(createStoreDouble());
    const validate = validator(updateTool);
    expect(validate({ id: "s-1" })).toBe(true);
    expect(validate({ id: "s-1", title: "New" })).toBe(true);
    expect(validate({ id: "s-1", at: "2030-01-01T00:00:00Z" })).toBe(true);
    expect(validate({ id: "s-1", cron: "0 9 * * 1" })).toBe(true);
    expect(validate({ id: "s-1", title: "New", cron: "0 9 * * 1" })).toBe(true);
    expect(validate({ id: "s-1", delivery: "silent" })).toBe(true);
    expect(validate({ id: "s-1", delivery: "unknown" })).toBe(false);
    expect(validate({ id: "s-1", at: "2030-01-01T00:00:00Z", cron: "0 9 * * 1" })).toBe(false);
    expect(validate({ id: "s-1", channelId: "room-1" })).toBe(false);
    expect(validate({ id: "s-1", at: "2030-01-01T00:00:00Z", platform: "onebot" })).toBe(false);
  });

  it("update schema takes an optional state of enabled, paused or cancelled", () => {
    const validate = validator(createTools(createStoreDouble())[2]!);
    for (const state of ["enabled", "paused", "cancelled"]) expect(validate({ id: "s-1", state })).toBe(true);
    expect(validate({ id: "s-1", title: "新标题", state: "paused" })).toBe(true);
    expect(validate({ id: "s-1", state: "completed" })).toBe(false);
  });

  it("list schema accepts an empty object only", () => {
    const [, listTool] = createTools(createStoreDouble());
    const validate = validator(listTool);
    expect(validate({})).toBe(true);
    expect(validate({ id: "s-1" })).toBe(false);
  });

  it("create persists a once schedule through the captured scope and returns its projection", async () => {
    const store = createStoreDouble();
    store.create.mockResolvedValue(makeSchedule());
    const [createTool] = createTools(store);
    const result = await execute(createTool, { title: "Standup", prompt: "Run the daily standup.", at: "2030-01-01T00:00:00.000Z" });
    expect(store.create).toHaveBeenCalledWith(scope, { title: "Standup", prompt: "Run the daily standup.", kind: "once", at: "2030-01-01T00:00:00.000Z" });
    expect(result).toEqual({ id: "s-1", title: "Standup", delivery: "channel", kind: "once", state: "enabled", nextRunAt: "2030-01-01T00:00:00.000Z" });
  });

  it("create maps a cron input to a recurring schedule", async () => {
    const store = createStoreDouble();
    store.create.mockResolvedValue(makeSchedule({ kind: "cron", cron: "0 9 * * 1" }));
    const [createTool] = createTools(store);
    const result = await execute(createTool, { title: "Standup", prompt: "Run the daily standup.", cron: "0 9 * * 1" });
    expect(store.create).toHaveBeenCalledWith(scope, { title: "Standup", prompt: "Run the daily standup.", kind: "cron", cron: "0 9 * * 1" });
    expect(result).toEqual({ id: "s-1", title: "Standup", delivery: "channel", kind: "cron", state: "enabled", nextRunAt: "2030-01-01T00:00:00.000Z" });
  });

  it("create persists silent delivery and exposes it in the projection", async () => {
    const store = createStoreDouble();
    store.create.mockResolvedValue(makeSchedule({ delivery: "silent" }));
    const [createTool] = createTools(store);
    const result = await execute(createTool, {
      title: "Memory maintenance",
      prompt: "Update memory without replying.",
      delivery: "silent",
      cron: "0 0 * * *",
    });
    expect(store.create).toHaveBeenCalledWith(scope, {
      title: "Memory maintenance",
      prompt: "Update memory without replying.",
      delivery: "silent",
      kind: "cron",
      cron: "0 0 * * *",
    });
    expect(result).toMatchObject({ id: "s-1", delivery: "silent" });
  });

  it("list returns compact projections for the captured scope", async () => {
    const store = createStoreDouble();
    store.list.mockResolvedValue([
      makeSchedule(),
      makeSchedule({
        id: "s-2",
        title: "Digest",
        kind: "cron",
        cron: "0 9 * * 1",
        nextRunAt: "2030-01-02T00:00:00.000Z",
        lastResult: { occurrenceAt: "2030-01-01T00:00:00.000Z", status: "accepted", finishedAt: "2030-01-01T00:00:01.000Z" },
      }),
    ]);
    const [, listTool] = createTools(store);
    const result = (await execute(listTool, {})) as ScheduleProjection[];
    expect(store.list).toHaveBeenCalledWith(scope);
    expect(result).toEqual([
      { id: "s-1", title: "Standup", delivery: "channel", kind: "once", state: "enabled", nextRunAt: "2030-01-01T00:00:00.000Z" },
      {
        id: "s-2",
        title: "Digest",
        delivery: "channel",
        kind: "cron",
        state: "enabled",
        nextRunAt: "2030-01-02T00:00:00.000Z",
        lastResult: { occurrenceAt: "2030-01-01T00:00:00.000Z", status: "accepted", finishedAt: "2030-01-01T00:00:01.000Z" },
      },
    ]);
  });

  it("update routes a title replacement through the captured scope", async () => {
    const store = createStoreDouble();
    store.update.mockResolvedValue(makeSchedule({ title: "New title" }));
    const [, , updateTool] = createTools(store);
    const result = await execute(updateTool, { id: "s-1", title: "New title" });
    expect(store.update).toHaveBeenCalledWith(scope, "s-1", { title: "New title" });
    expect(result).toEqual({ id: "s-1", title: "New title", delivery: "channel", kind: "once", state: "enabled", nextRunAt: "2030-01-01T00:00:00.000Z" });
  });

  it("update routes a cron rule replacement through the captured scope", async () => {
    const store = createStoreDouble();
    store.update.mockResolvedValue(makeSchedule({ kind: "cron", cron: "0 9 * * 1" }));
    const [, , updateTool] = createTools(store);
    const result = await execute(updateTool, { id: "s-1", cron: "0 9 * * 1" });
    expect(store.update).toHaveBeenCalledWith(scope, "s-1", { kind: "cron", cron: "0 9 * * 1" });
    expect(result).toEqual({ id: "s-1", title: "Standup", delivery: "channel", kind: "cron", state: "enabled", nextRunAt: "2030-01-01T00:00:00.000Z" });
  });

  it("update changes delivery without replacing the schedule rule", async () => {
    const store = createStoreDouble();
    store.update.mockResolvedValue(makeSchedule({ delivery: "silent" }));
    const [, , updateTool] = createTools(store);
    const result = await execute(updateTool, { id: "s-1", delivery: "silent" });
    expect(store.update).toHaveBeenCalledWith(scope, "s-1", { delivery: "silent" });
    expect(result).toMatchObject({ id: "s-1", delivery: "silent" });
  });

  it("update replaces only the bot's notes through the captured scope", async () => {
    const store = createStoreDouble();
    store.update.mockResolvedValue(makeSchedule({ notes: "点签到按钮" }));
    const [, , updateTool] = createTools(store);
    await execute(updateTool, { id: "s-1", notes: "点签到按钮" });
    expect(store.update).toHaveBeenCalledWith(scope, "s-1", { notes: "点签到按钮" });
    expect(await asSchema(updateTool.inputSchema).jsonSchema).toMatchObject({ properties: { notes: { type: "string", maxLength: 2000 } } });
  });

  it.each([
    ["paused", "pause"],
    ["enabled", "resume"],
    ["cancelled", "cancel"],
  ] as const)("state %s calls the store with the captured scope", async (state, method) => {
    const store = createStoreDouble();
    store[method].mockResolvedValue(makeSchedule({ state }));
    const [, , updateTool] = createTools(store);
    const result = await execute(updateTool, { id: "s-1", state });
    expect(store.update).not.toHaveBeenCalled();
    expect(store[method]).toHaveBeenCalledWith(scope, "s-1");
    expect(result).toEqual({ id: "s-1", title: "Standup", delivery: "channel", kind: "once", state, nextRunAt: "2030-01-01T00:00:00.000Z" });
  });

  it("applies the other fields first, then the state", async () => {
    const store = createStoreDouble();
    store.update.mockResolvedValue(makeSchedule({ state: "paused", at: "2031-01-01T00:00:00.000Z" }));
    store.resume.mockResolvedValue(makeSchedule({ state: "enabled", at: "2031-01-01T00:00:00.000Z" }));
    const [, , updateTool] = createTools(store);
    await execute(updateTool, { id: "s-1", at: "2031-01-01T00:00:00Z", state: "enabled" });
    expect(store.update).toHaveBeenCalledWith(scope, "s-1", { kind: "once", at: "2031-01-01T00:00:00Z" });
    expect(store.resume).toHaveBeenCalledWith(scope, "s-1");
    expect(store.update.mock.invocationCallOrder[0]).toBeLessThan(store.resume.mock.invocationCallOrder[0]!);
  });

  it("skips the state change when an update already left the task in that state", async () => {
    const store = createStoreDouble();
    store.update.mockResolvedValue(makeSchedule({ title: "新标题" }));
    const [, , updateTool] = createTools(store);
    expect(await execute(updateTool, { id: "s-1", title: "新标题", state: "enabled" })).toMatchObject({ title: "新标题", state: "enabled" });
    expect(store.resume).not.toHaveBeenCalled();
  });

  it("reports a refused state change after the fields were written as partial", async () => {
    const store = createStoreDouble();
    store.update.mockResolvedValue(makeSchedule({ title: "新标题", state: "cancelled" }));
    store.resume.mockRejectedValue(reject("invalid_schedule_state", "not paused"));
    const [, , updateTool] = createTools(store);
    expect(await execute(updateTool, { id: "s-1", title: "新标题", state: "enabled" })).toMatchObject({
      ok: false,
      executionStatus: "partial",
      changed: true,
      error: { code: "invalid_schedule_state" },
      schedule: { title: "新标题" },
    });
  });
});

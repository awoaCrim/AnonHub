import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentPlugin } from "@yesimbot/agent-runtime";
import { closeStateDb, configureLogging, configureStorage, systemClock, type LogRecord } from "@yesimbot/foundation";
import type { ChannelPlugin } from "koishi-plugin-yesimbot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { identity, policy } from "../../../tests/tool-policy.js";

/** The plugin's table writes go through this spy, so a test can count them or fail one after it ran. */
const spies = vi.hoisted(() => ({
  set: undefined as undefined | ((table: ScheduleTable, query: ScheduleQuery, patch: Partial<ScheduleRow>) => Promise<void>),
}));
vi.mock("../src/table.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/table.js")>();
  return {
    ...actual,
    sqliteScheduleTable: () => {
      const real = actual.sqliteScheduleTable();
      return { ...real, set: (query: ScheduleQuery, patch: Partial<ScheduleRow>) => spies.set!(real, query, patch) };
    },
  };
});

import { reject } from "../src/errors.js";
import { extension } from "../src/extension.js";
import { ScheduleScheduler } from "../src/scheduler.js";
import type { ScheduleQuery, ScheduleTable } from "../src/store.js";
import { sqliteScheduleTable } from "../src/table.js";
import type { Schedule, ScheduleRow, ScheduleUpdateInput } from "../src/types.js";

type Plugin = ChannelPlugin;

interface ScheduleManager {
  list(): Promise<Array<Schedule & { revision: string }>>;
  update(id: string, revision: string, input: ScheduleUpdateInput): Promise<void>;
}

function createContext() {
  const ready: Array<() => Promise<void> | void> = [];
  const dispose: Array<() => Promise<void> | void> = [];
  const plugins: Plugin[] = [];
  const trigger = vi.fn(async () => undefined);
  const disposeAgentPlugin = vi.fn<() => void>();
  const agentUse = vi.fn((plugin: Plugin) => {
    plugins.push(plugin);
    return disposeAgentPlugin;
  });
  const ctx = {
    logger: () => ({ info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    on: vi.fn((event: string, callback: () => Promise<void> | void) => {
      if (event === "ready") ready.push(callback);
      if (event === "dispose") dispose.push(callback);
    }),
    setTimeout: vi.fn((callback: () => void, milliseconds: number) => {
      const handle = setTimeout(callback, milliseconds);
      return () => clearTimeout(handle);
    }),
    set: vi.fn((_name: string, _service: unknown) => vi.fn()),
    yesimbot: {
      identity,
      agent: { use: agentUse },
      resource: { get: vi.fn(async () => ({ path: "/tmp", assets: {}, artifacts: {} })) },
      messenger: { post: trigger },
    },
  };
  return { ctx, ready, dispose, plugins, trigger, agentUse, disposeAgentPlugin };
}

type FakeContext = ReturnType<typeof createContext>["ctx"];

/**
 * Runs the extension the way a host does: the config is parsed when loaded, `start` runs on `ready`, and `dispose` runs
 * its undo (also when the start finished only afterwards).
 */
function applySchedule(ctx: FakeContext, raw?: unknown): void {
  const config = extension.parse(raw ?? {});
  let disposed = false;
  let undo: (() => unknown) | undefined;
  ctx.on("ready", async () => {
    undo = ((await extension.start({
      config,
      core: ctx.yesimbot,
      baseDir: "/tmp",
      clock: systemClock(),
      setTimeout: ctx.setTimeout,
      setInterval: () => () => {},
      on: () => () => {},
      provide: (name: string, service: object) => ctx.set(name, service),
      isOwnerContext: () => false,
    } as never)) ?? undefined) as typeof undo;
    if (disposed) await undo?.();
  });
  ctx.on("dispose", async () => {
    disposed = true;
    await undo?.();
  });
}

async function toolNames(plugin: AgentPlugin): Promise<string[]> {
  const set = typeof plugin.tools === "function" ? ((await plugin.tools({} as never)) ?? []) : (plugin.tools ?? []);
  return set.map((tool) => tool.name);
}

function futureRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: "future",
    type: "shared",
    platform: "onebot",
    selfId: "bot",
    channelId: "room",
    title: "未来任务",
    prompt: "到期提示",
    kind: "once",
    at: "2099-01-01T00:00:00Z",
    cron: null,
    state: "enabled",
    nextRunAt: "2099-01-01T00:00:00Z",
    lastResult: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Log lines the scheduler wrote (convention 07: nothing reaches the console in tests). */
const records: LogRecord[] = [];

let dataRoot: string;

async function seed(...rows: ScheduleRow[]): Promise<void> {
  const table = sqliteScheduleTable();
  for (const row of rows) await table.create(row);
}

async function rowOf(id: string): Promise<ScheduleRow> {
  return (await sqliteScheduleTable().get({ id }))[0]!;
}

describe("schedule extension", () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "schedule-plugin-"));
    configureStorage({ dataRoot });
    spies.set = vi.fn((table: ScheduleTable, query: ScheduleQuery, patch: Partial<ScheduleRow>) => table.set(query, patch));
    configureLogging({ sink: (record) => records.push(record) });
    records.length = 0;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    closeStateDb();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("registers the AgentPlugin factory on ready, with no chat commands", async () => {
    const { ctx, ready, plugins, agentUse } = createContext();
    applySchedule(ctx as never, {});

    expect(agentUse).not.toHaveBeenCalled();
    expect("command" in ctx).toBe(false);

    await ready[0]?.();

    expect(agentUse).toHaveBeenCalledOnce();
    const agent = await plugins[0]?.setup({ type: "guild", platform: "onebot", channelId: "room", guildId: "room" }, { selfId: "bot" } as never);
    expect(agent).toBeDefined();
    expect(await toolNames(agent!)).toEqual(["schedule_create", "schedule_list", "schedule_update"]);
  });

  it("leaves nothing registered when a startup finishes after the plugin was disposed", async () => {
    const { ctx, agentUse, ready, dispose, disposeAgentPlugin } = createContext();
    let release!: () => void;
    vi.spyOn(ScheduleScheduler.prototype, "start")
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      )
      .mockResolvedValue(undefined);
    applySchedule(ctx as never);
    const previous = ready[0]!();
    await dispose[0]!();
    release();
    await previous;
    expect(agentUse).toHaveBeenCalledOnce();
    expect(disposeAgentPlugin).toHaveBeenCalledOnce();
  });

  it("recovers persisted schedules and arms the earliest due timer on ready", async () => {
    const missed = futureRow({ id: "missed", title: "已错过", at: "2020-01-01T00:00:00Z", nextRunAt: "2020-01-01T00:00:00Z" });
    const upcoming = futureRow({ id: "upcoming" });
    await seed(missed, upcoming);

    const { ctx, ready, trigger } = createContext();
    applySchedule(ctx as never, {});
    await ready[0]?.();

    expect(await rowOf("missed")).toMatchObject({ state: "completed", nextRunAt: null });
    expect((await rowOf("missed")).lastResult).toMatchObject({ occurrenceAt: "2020-01-01T00:00:00Z", status: "missed" });
    expect(await rowOf(upcoming.id)).toMatchObject({ state: "enabled", nextRunAt: "2099-01-01T00:00:00Z" });
    expect(vi.getTimerCount()).toBe(1);
    expect(trigger).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "QQ heartbeat changed to one-time",
      row: { purpose: "heartbeat", kind: "cron", at: null, cron: "*/30 * * * *" } satisfies Partial<ScheduleRow>,
      patch: { kind: "once", at: "2099-01-01T00:00:00Z" } satisfies ScheduleUpdateInput,
    },
    {
      label: "web task changed to heartbeat",
      row: { platform: "web", kind: "cron", at: null, cron: "*/30 * * * *" } satisfies Partial<ScheduleRow>,
      patch: { purpose: "heartbeat" } satisfies ScheduleUpdateInput,
    },
  ])("maps a managed pre-write rejection to invalid_schedule: $label", async ({ row, patch }) => {
    await seed(futureRow(row));
    const { ctx, ready } = createContext();
    applySchedule(ctx as never, {});
    await ready[0]?.();
    const manager = ctx.set.mock.calls.find(([name]) => name === "yesimbotSchedule")![1] as ScheduleManager;
    const rearm = vi.spyOn(ScheduleScheduler.prototype, "rearm");
    const before = await manager.list();
    await expect(manager.update(before[0].id, before[0].revision, patch)).rejects.toMatchObject({ code: "invalid_schedule", message: "invalid_schedule" });
    expect(spies.set).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
    expect(await manager.list()).toEqual(before);
  });

  it.each([new Error("scheduler failed"), reject("invalid_schedule", "post-write scheduler failure")])(
    "preserves the exact managed rearm failure after saving the row: $name",
    async (cause) => {
      await seed(futureRow());
      const { ctx, ready } = createContext();
      applySchedule(ctx as never, {});
      await ready[0]?.();
      const manager = ctx.set.mock.calls.find(([name]) => name === "yesimbotSchedule")![1] as ScheduleManager;
      const rearm = vi.spyOn(ScheduleScheduler.prototype, "rearm").mockRejectedValueOnce(cause);
      const [before] = await manager.list();
      await expect(manager.update(before.id, before.revision, { title: "已保存" })).rejects.toBe(cause);
      expect(spies.set).toHaveBeenCalledOnce();
      expect(rearm).toHaveBeenCalledOnce();
      expect((await manager.list())[0].title).toBe("已保存");
    },
  );

  it("preserves a managed database acknowledgement failure after a possible write", async () => {
    await seed(futureRow());
    const { ctx, ready } = createContext();
    applySchedule(ctx as never, {});
    await ready[0]?.();
    const manager = ctx.set.mock.calls.find(([name]) => name === "yesimbotSchedule")![1] as ScheduleManager;
    const rearm = vi.spyOn(ScheduleScheduler.prototype, "rearm");
    const [before] = await manager.list();
    const cause = new Error("database write acknowledgement lost");
    const set = spies.set!;
    const failing = vi.fn(async (...args: Parameters<NonNullable<typeof spies.set>>) => {
      await set(...args);
      throw cause;
    });
    spies.set = failing;
    await expect(manager.update(before.id, before.revision, { title: "已写入" })).rejects.toBe(cause);
    expect(failing).toHaveBeenCalledOnce();
    expect(rearm).not.toHaveBeenCalled();
    expect((await manager.list())[0].title).toBe("已写入");
  });

  it("dispose closes scheduler admission and clears timers while preserving rows", async () => {
    const upcoming = futureRow();
    await seed(upcoming);

    const { ctx, ready, dispose, trigger, disposeAgentPlugin } = createContext();
    applySchedule(ctx as never, {});
    await ready[0]?.();
    expect(vi.getTimerCount()).toBe(1);

    const disposeFactory = disposeAgentPlugin;
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await dispose[0]?.();

    expect(disposeFactory).toHaveBeenCalledOnce();
    expect(clearSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // No wake can submit anything after stop: the row stays enabled and unclaimed.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(trigger).not.toHaveBeenCalled();
    expect(await rowOf(upcoming.id)).toMatchObject({ state: "enabled", nextRunAt: "2099-01-01T00:00:00Z", lastResult: null });
    expect(await sqliteScheduleTable().get({})).toHaveLength(1);
  });
  it("rearms the running scheduler for Agent creation of earlier work", async () => {
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    await seed(futureRow({ at: "2026-08-01T03:00:00.000Z", nextRunAt: "2026-08-01T03:00:00.000Z" }));
    const { ctx, ready, plugins, trigger } = createContext();
    applySchedule(ctx as never, {});
    await ready[0]?.();
    const agent = await plugins[0]!.setup({ type: "guild", platform: "onebot", channelId: "room", guildId: "room" }, { selfId: "bot" } as never);
    const create = (await agent.tools!({} as never))!.find((tool) => tool.name === "schedule_create")!;

    await create.execute!({ title: "agent", prompt: "Run.", at: "2026-08-01T00:01:00.000Z" }, {} as never);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger.mock.calls[0]?.[0]).toMatchObject({ schedule: { title: "agent" } });
  });

  it("rearms after every Agent management mutation", async () => {
    const { ctx, ready, plugins } = createContext();
    const rearm = vi.spyOn(ScheduleScheduler.prototype, "rearm");
    applySchedule(ctx as never, {});
    await ready[0]?.();
    const agent = await plugins[0]!.setup({ type: "guild", platform: "onebot", channelId: "room", guildId: "room" }, { selfId: "bot" } as never);
    const tools = (await agent.tools!({} as never))!;
    const create = tools.find((tool) => tool.name === "schedule_create")!;
    const update = tools.find((tool) => tool.name === "schedule_update")!;
    const created = (await create.execute!({ title: "agent", prompt: "Run.", at: "2099-01-01T00:00:00Z" }, {} as never)) as { id: string };

    await update.execute!({ id: created.id, title: "agent v2" }, {} as never);
    await update.execute!({ id: created.id, state: "paused" }, {} as never);
    await update.execute!({ id: created.id, state: "enabled" }, {} as never);
    await update.execute!({ id: created.id, state: "cancelled" }, {} as never);

    expect(rearm).toHaveBeenCalledTimes(5);
  });
});

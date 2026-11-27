import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureLogging, systemClock, type LogRecord } from "@yesimbot/foundation";
import { CHANNEL_TYPE } from "koishi-plugin-yesimbot";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { EventRecord } from "../../../core/src/messages.js";
import { ScheduleService } from "../src/service.js";
import { ScheduleStore } from "../src/store.js";
import { disposeScheduleModels, scheduleModel, tableOf } from "./support.js";

const SCOPE = { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1", selfId: "bot-1" } as const;

type Fixture = { plugin: ScheduleService; store: ScheduleStore; trigger: Mock<(event: EventRecord) => Promise<void>>; basePath: string };

/**
 * Creates a fixture with the current Messenger.post facade, avoiding any dependency
 * on the real Core RuntimeManager or ChannelRuntime.
 */
async function createFixture(): Promise<Fixture> {
  const basePath = await mkdtemp(join(tmpdir(), "yesimbot-schedule-int-"));
  const model = await scheduleModel();

  const trigger = vi.fn(async () => undefined) as Mock<(event: EventRecord) => Promise<void>>;
  const yesimbot = {
    agent: { use: vi.fn(() => () => undefined) },
    resource: { get: vi.fn(async () => ({ path: basePath, assets: {}, artifacts: {} })) },
    messenger: { post: trigger },
  };

  const table = tableOf(model);
  const plugin = new ScheduleService({
    table,
    host: yesimbot as never,
    timer: (callback, milliseconds) => {
      const handle = setTimeout(callback, milliseconds);
      return () => clearTimeout(handle);
    },
    clock: systemClock(),
    stateHost: model,
    publish: () => () => undefined,
  });
  const store = plugin.store;

  return { plugin, store, trigger, basePath };
}

function futureInstant(offsetMs = 3_600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Starts the real plugin under the fake clock, positioned at `instant`.
 */
async function startPluginAt(fixture: Fixture, instant: string): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(Date.parse(instant)));
  await fixture.plugin.stop();
  await fixture.plugin.start();
}

/**
 * Advances fake time while yielding one real event-loop turn until the
 * observable completion condition is true.
 */
async function settleUntil<T>(description: string, condition: () => T | false | Promise<T | false>, timeoutMs = 120_000, stepMs = 1_000): Promise<T> {
  for (let elapsedMs = 0; elapsedMs <= timeoutMs; elapsedMs += stepMs) {
    const result = await condition();
    if (result) return result;
    await vi.advanceTimersByTimeAsync(stepMs);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms of fake time`);
}

/** Log lines the scheduler wrote (convention 07: nothing reaches the console in tests). */
const records: LogRecord[] = [];

describe("Schedule proactive trigger integration", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    configureLogging({ sink: (record) => records.push(record) });
    records.length = 0;
    fixture = await createFixture();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fixture.plugin.stop();
    vi.restoreAllMocks();
    await disposeScheduleModels();
    await rm(fixture.basePath, { recursive: true, force: true });
  });

  it("submits a due schedule.due event with the correct EventRecord shape", async () => {
    const dueIso = futureInstant();
    const created = await fixture.store.create(SCOPE, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: dueIso });

    await startPluginAt(fixture, dueIso);
    await settleUntil("trigger called", () => fixture.trigger.mock.calls.length === 1);

    expect(fixture.trigger).toHaveBeenCalledTimes(1);
    expect(fixture.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "schedule.due", platform: "test", selfId: "bot-1", channel: { id: "room-1", type: CHANNEL_TYPE.text } }),
      { trigger: true, ifBusy: "defer", delivery: "channel" },
    );
    const event = fixture.trigger.mock.calls[0][0] as EventRecord<"schedule.due">;
    expect(event).toMatchObject({
      text: expect.stringMatching(/^Schedule "standup" is due\.\nPrepare the daily standup\.\n\n/),
      schedule: { id: created.id, title: "standup", kind: "once", scheduledFor: dueIso },
    });
    expect(event.timestamp).toBe(Date.parse(dueIso));
  });

  it("marks schedule accepted when trigger resolves", async () => {
    const dueIso = futureInstant();
    await fixture.store.create(SCOPE, { title: "standup", prompt: "Ping.", kind: "once", at: dueIso });

    await startPluginAt(fixture, dueIso);
    await settleUntil("accepted", async () => {
      const [row] = await fixture.store.list(SCOPE);
      return row?.lastResult?.status === "accepted";
    });

    const [row] = await fixture.store.list(SCOPE);
    expect(row.state).toBe("completed");
    expect(row.nextRunAt).toBeNull();
    expect(row.lastResult).toMatchObject({ occurrenceAt: dueIso, status: "accepted" });
  });

  it("marks schedule failed when trigger rejects", async () => {
    const dueIso = futureInstant();
    fixture.trigger.mockRejectedValueOnce(new Error("No Bot is available for test:bot-1"));
    await fixture.store.create(SCOPE, { title: "standup", prompt: "Ping.", kind: "once", at: dueIso });

    await startPluginAt(fixture, dueIso);
    await settleUntil("failed", async () => {
      const [row] = await fixture.store.list(SCOPE);
      return row?.lastResult?.status === "failed";
    });

    const [row] = await fixture.store.list(SCOPE);
    expect(row.state).toBe("completed");
    expect(row.lastResult).toMatchObject({ occurrenceAt: dueIso, status: "failed", error: { name: "Error", message: "No Bot is available for test:bot-1" } });
  });

  it("submits multiple due schedules in the same scope", async () => {
    const dueIso = futureInstant();
    const first = await fixture.store.create(SCOPE, { title: "first", prompt: "Ping.", kind: "once", at: dueIso });
    const second = await fixture.store.create(SCOPE, { title: "second", prompt: "Pong.", kind: "once", at: dueIso });

    await startPluginAt(fixture, dueIso);
    await settleUntil("both triggered", () => fixture.trigger.mock.calls.length === 2);

    expect(fixture.trigger).toHaveBeenCalledTimes(2);
    const submitted = fixture.trigger.mock.calls.map(([event]) => (event as EventRecord<"schedule.due">).schedule?.id);
    expect(submitted).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it("preserves rows and advances nextRunAt for cron schedules across a cycle", async () => {
    const created = await fixture.store.create(SCOPE, { title: "quarterly", prompt: "Ping.", kind: "cron", cron: "*/15 * * * *" });
    const firstDue = created.nextRunAt!;

    await startPluginAt(fixture, firstDue);
    await settleUntil("first accepted", async () => {
      const [row] = await fixture.store.list(SCOPE);
      return row?.lastResult?.status === "accepted";
    });

    const [row] = await fixture.store.list(SCOPE);
    expect(row.state).toBe("enabled");
    expect(row.nextRunAt).not.toBe(firstDue);
    expect(row.nextRunAt).not.toBeNull();
    expect(row.lastResult).toMatchObject({ status: "accepted" });
  });

  it("recovers a submitting occurrence as interrupted through plugin start", async () => {
    const dueIso = futureInstant();
    const created = await fixture.store.create(SCOPE, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: dueIso });

    await startPluginAt(fixture, dueIso);
    const claimed = await fixture.store.claim(created.id, dueIso);
    expect(claimed?.lastResult).toMatchObject({ occurrenceAt: dueIso, status: "submitting" });
    await fixture.plugin.stop();

    vi.setSystemTime(new Date(Date.parse(dueIso) + 1_000));
    await fixture.plugin.start();
    await settleUntil("recovery", async () => {
      const [row] = await fixture.store.list(SCOPE);
      return row?.lastResult?.status === "interrupted";
    });

    const [row] = await fixture.store.list(SCOPE);
    expect(row.state).toBe("completed");
    expect(row.lastResult).toMatchObject({ occurrenceAt: dueIso, status: "interrupted" });
    expect(row.nextRunAt).toBeNull();
  });

  it("produces no trigger after plugin disposal and preserves rows", async () => {
    const created = await fixture.store.create(SCOPE, { title: "quarterly", prompt: "Ping.", kind: "cron", cron: "*/15 * * * *" });
    const firstDue = created.nextRunAt!;

    await startPluginAt(fixture, firstDue);
    await fixture.plugin.stop();

    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.trigger).not.toHaveBeenCalled();
    const [row] = await fixture.store.list(SCOPE);
    expect(row.state).toBe("enabled");
    expect(row.nextRunAt).toBe(firstDue);
    expect(row.lastResult).toBeUndefined();
  });
});

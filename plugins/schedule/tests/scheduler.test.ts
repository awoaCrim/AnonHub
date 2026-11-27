import { configureLogging, systemClock, type LogRecord } from "@yesimbot/foundation";
import { CHANNEL_TYPE, type EventRecord } from "koishi-plugin-yesimbot";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { MAX_CONCURRENT_TRIGGERS, ScheduleScheduler, type DuePoster } from "../src/scheduler.js";
import { ScheduleStore, type ScheduleScope } from "../src/store.js";
import type { Schedule } from "../src/types.js";
import { disposeScheduleModels, scheduleModel, tableOf, type ScheduleModel } from "./support.js";

const sharedScope = { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1", selfId: "bot-1" } satisfies ScheduleScope;

const T0 = "2026-08-01T00:00:00.000Z";

function newStore(model: ScheduleModel): ScheduleStore {
  return new ScheduleStore(tableOf(model), systemClock(), model);
}

/** Fake timers drive both the clock and the one-shot timer. */
function newScheduler(store: ScheduleStore, messenger: DuePoster): ScheduleScheduler {
  return new ScheduleScheduler(store, {
    messenger,
    clock: systemClock(),
    timer: (callback, milliseconds) => {
      const handle = setTimeout(callback, milliseconds);
      return () => clearTimeout(handle);
    },
  });
}

/** Log lines the scheduler wrote (convention 07: nothing reaches the console in tests). */
const records: LogRecord[] = [];

describe("ScheduleScheduler", () => {
  let store: ScheduleStore;
  let model: ScheduleModel;
  let trigger: Mock<(event: EventRecord) => Promise<void>>;
  let scheduler: ScheduleScheduler;

  beforeEach(async () => {
    configureLogging({ sink: (record) => records.push(record) });
    records.length = 0;
    model = await scheduleModel();
    store = newStore(model);
    trigger = vi.fn(async (_event: EventRecord) => {});
    scheduler = newScheduler(store, { post: trigger });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disposeScheduleModels();
  });

  it("submits one due once schedule exactly once with a complete due event", async () => {
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: T0 });

    vi.setSystemTime(new Date(T0));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(trigger).toHaveBeenCalledTimes(1);
    const event = trigger.mock.calls[0][0];
    expect(event).toMatchObject({
      eventType: "schedule.due",
      platform: "test",
      selfId: "bot-1",
      channel: { id: "room-1", type: CHANNEL_TYPE.text },
      text: expect.stringMatching(/^Schedule "standup" is due\.\nPrepare the daily standup\.\n\n做完后.*schedule_update/),
      schedule: { id: created.id, title: "standup", kind: "once", scheduledFor: T0 },
    });
    expect(event.text).toContain(`id: ${created.id}`);
    expect("user" in event).toBe(false);
    expect(event.timestamp).toBe(Date.parse(T0));
    expect(trigger.mock.calls[0][1]).toEqual({ trigger: true, ifBusy: "defer", delivery: "channel" });

    const [updated] = await store.list(sharedScope);
    expect(updated.state).toBe("completed");
    expect(updated.nextRunAt).toBeNull();
    expect(updated.lastResult).toMatchObject({ occurrenceAt: T0, status: "accepted" });
  });

  it("logs the fire and finish of an occurrence with dotted events", async () => {
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    await store.create(sharedScope, { title: "standup", prompt: "p", kind: "once", at: T0 });
    vi.setSystemTime(new Date(T0));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(records.map((record) => record.event)).toEqual(["schedule.fired", "schedule.finished"]);
    expect(records[0]).toMatchObject({ scope: "yesimbot.schedule", level: "info", title: "standup" });
  });

  it("runs a silent schedule without channel delivery", async () => {
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    await store.create(sharedScope, { title: "memory maintenance", prompt: "Update memory without replying.", delivery: "silent", kind: "once", at: T0 });

    vi.setSystemTime(new Date(T0));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][1]).toEqual({ trigger: true, ifBusy: "defer", delivery: "silent" });
  });

  it("submits consecutive cron occurrences without overlap", async () => {
    const created = await store.create(sharedScope, { title: "quarterly", prompt: "Ping.", kind: "cron", cron: "*/15 * * * *" });
    expect(created.nextRunAt).toBe("2026-08-01T00:15:00.000Z");

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].schedule.scheduledFor).toBe("2026-08-01T00:15:00.000Z");

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(trigger).toHaveBeenCalledTimes(2);
    expect(trigger.mock.calls[1][0].schedule.scheduledFor).toBe("2026-08-01T00:30:00.000Z");

    const [row] = await store.list(sharedScope);
    expect(row.lastResult).toMatchObject({ occurrenceAt: "2026-08-01T00:30:00.000Z", status: "accepted" });
    expect(row.nextRunAt).toBe("2026-08-01T00:45:00.000Z");
  });

  it("runs an occurrence once after a restart at most ten minutes late", async () => {
    const created = await store.create(sharedScope, { title: "quarterly", prompt: "Ping.", kind: "cron", cron: "*/15 * * * *" });
    expect(created.nextRunAt).toBe("2026-08-01T00:15:00.000Z");

    // Restart five minutes after the occurrence passed without a submission.
    vi.setSystemTime(new Date("2026-08-01T00:20:00.000Z"));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].schedule.scheduledFor).toBe("2026-08-01T00:15:00.000Z");
    const [row] = await store.list(sharedScope);
    expect(row.lastResult).toMatchObject({ occurrenceAt: "2026-08-01T00:15:00.000Z", status: "accepted" });
    expect(row.nextRunAt).toBe("2026-08-01T00:30:00.000Z");

    // A second restart does not run it again.
    scheduler.stop();
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("records an occurrence more than ten minutes late as missed and runs the next one", async () => {
    const created = await store.create(sharedScope, { title: "quarterly", prompt: "Ping.", kind: "cron", cron: "*/15 * * * *" });
    expect(created.nextRunAt).toBe("2026-08-01T00:15:00.000Z");

    vi.setSystemTime(new Date("2026-08-01T00:26:00.000Z"));
    await scheduler.start();

    expect(trigger).not.toHaveBeenCalled();
    const [row] = await store.list(sharedScope);
    expect(row.lastResult).toMatchObject({ occurrenceAt: "2026-08-01T00:15:00.000Z", status: "missed" });
    expect(row.state).toBe("enabled");
    expect(row.nextRunAt).toBe("2026-08-01T00:30:00.000Z");

    // The first future occurrence is still submitted exactly once.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].schedule.scheduledFor).toBe("2026-08-01T00:30:00.000Z");
  });

  it("skips to the latest occurrence inside the window when several passed", async () => {
    await store.create(sharedScope, { title: "quarterly", prompt: "Ping.", kind: "cron", cron: "*/15 * * * *" });
    vi.setSystemTime(new Date("2026-08-01T00:52:00.000Z"));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].schedule.scheduledFor).toBe("2026-08-01T00:45:00.000Z");
    const [row] = await store.list(sharedScope);
    expect(row.nextRunAt).toBe("2026-08-01T01:00:00.000Z");
  });

  it("marks an interrupted claim on restart without resubmitting", async () => {
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: T0 });

    // The durable claim happened, but the process stopped before the trigger result.
    const claimed = await store.claim(created.id, T0);
    expect(claimed?.lastResult).toMatchObject({ occurrenceAt: T0, status: "submitting" });

    vi.setSystemTime(new Date(Date.parse(T0) + 1_000));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(trigger).not.toHaveBeenCalled();
    const [row] = await store.list(sharedScope);
    expect(row.lastResult).toMatchObject({ occurrenceAt: T0, status: "interrupted" });
    expect(row.state).toBe("completed");
    expect(row.nextRunAt).toBeNull();

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(trigger).not.toHaveBeenCalled();
  });

  it.each(["queued", "running"])("preserves a %s turn across a schedule-only reload and records its real finish", async (status) => {
    let resolve!: (value: unknown) => void;
    let started!: (turn: { turnId: string; startedAt: string }) => Promise<void>;
    const postAndReport = vi.fn((_event, options) => {
      started = options.onTurnStart;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const messenger = { post: trigger, postAndReport };
    scheduler = newScheduler(store, messenger);
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    const task = await store.create(sharedScope, { title: "reload", prompt: "p", kind: "once", at: T0 });
    vi.setSystemTime(new Date(T0));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    if (status === "running") await started({ turnId: "before-reload", startedAt: new Date().toISOString() });
    scheduler.stop();

    const replacementStore = newStore(model);
    const replacement = newScheduler(replacementStore, messenger);
    try {
      await replacement.start();
      expect((await replacementStore.listRunsManaged(task.id)).runs[0].status).toBe(status);
      expect((await replacementStore.list(sharedScope))[0].lastResult?.status).toBe("submitting");
      expect(postAndReport).toHaveBeenCalledOnce();
      if (status === "queued") await started({ turnId: "after-reload", startedAt: new Date().toISOString() });
      resolve({ kind: "run", outcome: { status: "done", delivered: true } });
      await vi.advanceTimersByTimeAsync(0);
      expect((await replacementStore.listRunsManaged(task.id)).runs[0]).toMatchObject({
        status: "completed",
        turnId: status === "queued" ? "after-reload" : "before-reload",
        finishedAt: expect.any(String),
      });
      // An observer that arrives after settlement must not revive the old receipt.
      await started({ turnId: "late", startedAt: new Date().toISOString() });
      expect((await replacementStore.listRunsManaged(task.id)).runs[0].status).toBe("completed");
    } finally {
      resolve({ kind: "closed" });
      replacement.stop();
    }
  });

  it("keeps an older live finish from replacing a newer occurrence after a reload", async () => {
    let resolve!: (value: unknown) => void;
    const postAndReport = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ kind: "run", outcome: { status: "failed", delivered: false } });
    const messenger = { post: trigger, postAndReport };
    scheduler = newScheduler(store, messenger);
    const task = await store.create(sharedScope, { title: "overlap", prompt: "p", kind: "cron", cron: "*/15 * * * *" });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    scheduler.stop();
    const replacementStore = newStore(model);
    const replacement = newScheduler(replacementStore, messenger);
    try {
      await replacement.start();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      resolve({ kind: "run", outcome: { status: "done", delivered: true } });
      await vi.advanceTimersByTimeAsync(0);
      const history = (await replacementStore.listRunsManaged(task.id)).runs;
      expect(history.map((run) => run.status)).toEqual(["failed", "completed"]);
      expect((await replacementStore.list(sharedScope))[0].lastResult).toMatchObject({ occurrenceAt: history[0].occurrenceAt, status: "failed" });
    } finally {
      resolve({ kind: "closed" });
      replacement.stop();
    }
  });

  it("treats receipts without the live Core host as interrupted and ignores its stale callbacks", async () => {
    let resolve!: (value: unknown) => void;
    let started!: (turn: { turnId: string; startedAt: string }) => Promise<void>;
    const messenger = {
      post: trigger,
      postAndReport: vi.fn((_event, options) => {
        started = options.onTurnStart;
        return new Promise((done) => {
          resolve = done;
        });
      }),
    };
    scheduler = newScheduler(store, messenger);
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    const task = await store.create(sharedScope, { title: "lost", prompt: "p", kind: "once", at: T0 });
    vi.setSystemTime(new Date(T0));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();
    // A new Core has no in-memory registry, as after a full process restart.
    const replacement = newScheduler(newStore(model), { post: trigger });
    try {
      await replacement.start();
      await started({ turnId: "stale", startedAt: new Date().toISOString() });
      resolve({ kind: "run", outcome: { status: "done", delivered: true } });
      await vi.advanceTimersByTimeAsync(0);
      expect((await store.listRunsManaged(task.id)).runs[0]).toMatchObject({ status: "interrupted", error: { code: "process_interrupted" } });
    } finally {
      resolve({ kind: "closed" });
      replacement.stop();
    }
  });

  it("shares concurrency limits across reloads and frees an old host's slots on settlement", async () => {
    const releases: Array<(value: unknown) => void> = [];
    const messenger = {
      post: trigger,
      postAndReport: vi.fn(
        () =>
          new Promise((done) => {
            releases.push(done);
          }),
      ),
    };
    scheduler = newScheduler(store, messenger);
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    for (let i = 0; i < MAX_CONCURRENT_TRIGGERS; i++) {
      await store.create(sharedScope, { title: `old-${i}`, prompt: "p", kind: "once", at: T0 });
    }
    const blocked = await store.create(sharedScope, { title: "blocked", prompt: "p", kind: "once", at: new Date(Date.parse(T0) + 2000).toISOString() });
    const allowed = await store.create(sharedScope, { title: "allowed", prompt: "p", kind: "once", at: new Date(Date.parse(T0) + 4000).toISOString() });
    vi.setSystemTime(new Date(T0));
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.stop();
    const replacementStore = newStore(model);
    const replacement = newScheduler(replacementStore, messenger);
    try {
      await replacement.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(messenger.postAndReport).toHaveBeenCalledTimes(MAX_CONCURRENT_TRIGGERS);
      expect((await replacementStore.listRunsManaged(blocked.id)).runs[0]).toMatchObject({ status: "missed", error: { code: "concurrency_limit" } });
      releases[0]({ kind: "run", outcome: { status: "done", delivered: true } });
      await vi.advanceTimersByTimeAsync(2000);
      expect(messenger.postAndReport).toHaveBeenCalledTimes(MAX_CONCURRENT_TRIGGERS + 1);
      expect((await replacementStore.listRunsManaged(allowed.id)).runs[0].status).toBe("queued");
    } finally {
      releases.forEach((done) => done({ kind: "closed" }));
      await vi.advanceTimersByTimeAsync(0);
      replacement.stop();
    }
  });

  it("releases an unsubmitted claim after failure so a replacement scheduler can admit it", async () => {
    const messenger = { post: trigger, postAndReport: vi.fn().mockResolvedValue({ kind: "run", outcome: { status: "done", delivered: true } }) };
    scheduler = newScheduler(store, messenger);
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    const task = await store.create(sharedScope, { title: "retry admission", prompt: "p", kind: "once", at: T0 });
    vi.setSystemTime(new Date(T0));
    await scheduler.start();
    vi.spyOn(store, "claim").mockRejectedValueOnce(new Error("database unavailable before claim"));
    await expect((scheduler as unknown as { wake(): Promise<void> }).wake()).rejects.toThrow("database unavailable before claim");
    scheduler.stop();
    const replacementStore = newStore(model);
    const replacement = newScheduler(replacementStore, messenger);
    try {
      await replacement.start();
      await (replacement as unknown as { wake(): Promise<void> }).wake();
      expect(messenger.postAndReport).toHaveBeenCalledOnce();
      expect((await replacementStore.listRunsManaged(task.id)).runs[0].status).toBe("completed");
    } finally {
      replacement.stop();
    }
  });

  it.each([35, 45])("keeps a live heartbeat receipt while repairing work %s minutes after its start", async (minutes) => {
    let resolve!: (value: unknown) => void;
    const messenger = {
      post: trigger,
      postAndReport: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    };
    scheduler = newScheduler(store, messenger);
    const qq = { type: "direct", platform: "onebot", selfId: "bot", channelId: "private:owner", userId: "owner" } as ScheduleScope;
    const task = await store.create(qq, { title: "live heartbeat", prompt: "p", purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    scheduler.stop();
    vi.setSystemTime(new Date(Date.now() + minutes * 60_000));
    const replacementStore = newStore(model);
    const replacement = newScheduler(replacementStore, messenger);
    try {
      await replacement.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(messenger.postAndReport).toHaveBeenCalledOnce();
      expect((await replacementStore.list(qq))[0].lastResult).toMatchObject({ occurrenceAt: task.nextRunAt, status: "submitting" });
      expect((await replacementStore.listRunsManaged(task.id)).runs.find((run) => run.occurrenceAt === task.nextRunAt)?.status).toBe("queued");
      resolve({ kind: "run", outcome: { status: "done", delivered: false } });
      await vi.advanceTimersByTimeAsync(0);
      expect((await replacementStore.list(qq))[0].lastResult).toMatchObject({ occurrenceAt: task.nextRunAt, status: "completed", notified: false });
    } finally {
      resolve({ kind: "closed" });
      replacement.stop();
    }
  });

  it("does not duplicate a trigger when the same occurrence is woken twice", async () => {
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: T0 });

    vi.setSystemTime(new Date(T0));
    let release!: () => void;
    trigger.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(trigger).toHaveBeenCalledTimes(1);

    // A duplicate timer wake for the already-claimed occurrence must not trigger again.
    const withWake = scheduler as unknown as { wake(): Promise<void> };
    await withWake.wake();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(await store.claim(created.id, T0)).toBeNull();

    release();
    await vi.advanceTimersByTimeAsync(0);
    const [row] = await store.list(sharedScope);
    expect(row.lastResult).toMatchObject({ occurrenceAt: T0, status: "accepted" });
  });

  it("records a due occurrence as missed when all five trigger slots are occupied", async () => {
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    const created: Schedule[] = [];
    for (let i = 0; i < MAX_CONCURRENT_TRIGGERS + 1; i++) {
      created.push(await store.create(sharedScope, { title: `slot-${i}`, prompt: "Ping.", kind: "once", at: T0 }));
    }

    vi.setSystemTime(new Date(T0));
    const releases: Array<() => void> = [];
    trigger.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(trigger).toHaveBeenCalledTimes(MAX_CONCURRENT_TRIGGERS);
    let rows = await store.list(sharedScope);
    expect(rows.filter((row) => row.lastResult?.status === "submitting")).toHaveLength(MAX_CONCURRENT_TRIGGERS);
    const missed = rows.find((row) => row.lastResult?.status === "missed");
    expect(missed).toBeDefined();
    expect(missed!.lastResult).toMatchObject({ occurrenceAt: T0, status: "missed" });
    expect(missed!.state).toBe("completed");
    expect(missed!.nextRunAt).toBeNull();

    releases.forEach((release) => release());
    await vi.advanceTimersByTimeAsync(0);
    rows = await store.list(sharedScope);
    expect(rows.filter((row) => row.lastResult?.status === "accepted")).toHaveLength(MAX_CONCURRENT_TRIGGERS);
    expect(rows.filter((row) => row.lastResult?.status === "missed")).toHaveLength(1);
  });

  it("finalizes a rejected trigger as failed", async () => {
    vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
    const created = await store.create(sharedScope, { title: "standup", prompt: "Prepare the daily standup.", kind: "once", at: T0 });

    vi.setSystemTime(new Date(T0));
    trigger.mockRejectedValueOnce(new Error("bot offline"));

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].schedule.id).toBe(created.id);
    const [row] = await store.list(sharedScope);
    expect(row.lastResult).toMatchObject({ occurrenceAt: T0, status: "failed" });
    expect(row.lastResult?.error).toEqual({ name: "Error", message: "bot offline" });
    expect(row.state).toBe("completed");
  });

  it("stops arming future work after stop() while preserving rows", async () => {
    const created = await store.create(sharedScope, { title: "quarterly", prompt: "Ping.", kind: "cron", cron: "*/15 * * * *" });
    expect(created.nextRunAt).toBe("2026-08-01T00:15:00.000Z");

    await scheduler.start();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(trigger).not.toHaveBeenCalled();
    const [row] = await store.list(sharedScope);
    expect(row.state).toBe("enabled");
    expect(row.nextRunAt).toBe("2026-08-01T00:15:00.000Z");
    expect(row.lastResult).toBeUndefined();
  });

  it("does not restore a timer when stop races with an in-flight arm read", async () => {
    const task = await store.create(sharedScope, { title: "stopped", prompt: "p", kind: "cron", cron: "*/15 * * * *" });
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((done) => {
      entered = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    vi.spyOn(store, "listEnabled").mockImplementationOnce(async () => {
      entered();
      await gate;
      return [task];
    });
    const timer = vi.spyOn(globalThis, "setTimeout");
    const starting = scheduler.start();
    await reading;
    scheduler.stop();
    release();
    await starting;
    expect(timer).not.toHaveBeenCalled();
  });

  it("rearms a long delay in bounded chunks without submitting early", async () => {
    const dueAt = new Date(Date.parse(T0) + 0x7fffffff + 60_000).toISOString();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    vi.setSystemTime(new Date(Date.parse(T0) - 1));
    await store.create(sharedScope, { title: "far future", prompt: "Wait.", kind: "once", at: dueAt });

    vi.setSystemTime(new Date(T0));
    await scheduler.start();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 0x7fffffff);
    await vi.advanceTimersByTimeAsync(0x7fffffff);

    expect(trigger).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(trigger).toHaveBeenCalledOnce();
  });

  it("does not submit an occurrence claimed before stop and records it as interrupted", async () => {
    vi.setSystemTime(new Date(Date.parse(T0) - 60_000));
    const created = await store.create(sharedScope, { title: "shutdown", prompt: "Do not send.", kind: "once", at: T0 });
    const originalClaim = store.claim.bind(store);
    const claimed = new Promise<void>((resolve) => {
      vi.spyOn(store, "claim").mockImplementation(async (id, occurrenceAt) => {
        const row = await originalClaim(id, occurrenceAt);
        resolve();
        await new Promise<void>((release) => (releaseClaim = release));
        return row;
      });
    });
    let releaseClaim!: () => void;

    vi.setSystemTime(new Date(T0));
    await scheduler.start();
    const withWake = scheduler as unknown as { wake(): Promise<void> };
    const wake = withWake.wake();
    await claimed;
    scheduler.stop();
    releaseClaim();
    await wake;

    expect(trigger).not.toHaveBeenCalled();
    const [row] = await store.list(sharedScope);
    expect(row.lastResult).toMatchObject({ occurrenceAt: created.at, status: "interrupted" });
    expect(row.state).toBe("completed");
  });

  describe("turn outcomes", () => {
    const report = vi.fn();
    beforeEach(() => {
      report.mockReset();
      scheduler = newScheduler(store, { post: trigger, postAndReport: report });
    });
    const runOnce = async (delivery: "channel" | "silent" = "channel") => {
      vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
      await store.create(sharedScope, { title: "sign in", prompt: "Sign in.", delivery, kind: "once", at: T0 });
      vi.setSystemTime(new Date(T0));
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(60_000);
      return (await store.list(sharedScope))[0].lastResult;
    };

    const qq = { type: "direct", platform: "onebot", selfId: "bot", channelId: "private:owner", userId: "owner" } as ScheduleScope;
    it.each([false, true])("completes heartbeat checks with notified=%s", async (delivered) => {
      report.mockResolvedValue({ kind: "run", outcome: { status: "done", delivered } });
      const task = await store.create(qq, { title: "心跳", prompt: "关注近期事项", purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect((await store.list(qq))[0].lastResult).toMatchObject({ status: "completed", notified: delivered });
      expect(report.mock.calls[0][0].text).toContain("不是用户刚发来的消息");
      expect(report.mock.calls[0][0].text).toContain("不检查或公开私人邮箱");
      expect(report.mock.calls[0][0].text).toContain("通常用一条短消息说完");
      // A QQ heartbeat stays in its own conversation, and may look for news on what the person cares about.
      expect(report.mock.calls[0][0].text).toContain("不得列出、读取其他会话的聊天记录");
      expect(report.mock.calls[0][0].text).not.toContain("巡查整个实例");
      expect(report.mock.calls[0][0].text).toContain("对方关心的人和事");
      expect(report.mock.calls[0][0].text).not.toContain("当前是网页私聊");
      expect(report.mock.calls[0][0].text).not.toContain("等待动画旁");
      expect(report.mock.calls[0][1]).toMatchObject({ ifBusy: "reject", historyMode: "conversation" });
      expect((await store.list(qq))[0].id).toBe(task.id);
      scheduler.stop();
    });
    it.each(["onebot", "web", "wechat-bridge", "xiaoheihe"])("keeps an ordinary %s task named heartbeat free of QQ heartbeat rules", async (platform) => {
      report.mockResolvedValue({ kind: "run", outcome: { status: "done", delivered: false } });
      await store.create({ ...qq, platform }, { title: "心跳计划", prompt: "检查", delivery: "silent", kind: "cron", cron: "*/30 * * * *" });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(report).toHaveBeenCalledOnce();
      expect(report.mock.calls[0][0].platform).toBe(platform);
      expect(report.mock.calls[0][0].text).not.toContain("这是一次定时心跳检查");
      expect(report.mock.calls[0][0].text).not.toContain("通常用一条短消息说完");
      expect(report.mock.calls[0][1]).not.toHaveProperty("historyMode");
      expect(report.mock.calls[0][1]).toMatchObject({ ifBusy: "defer", delivery: "silent" });
      expect(report.mock.calls[0][1]).not.toHaveProperty("quiet");
      expect(report.mock.calls[0][0]).not.toHaveProperty("historyNote");
      scheduler.stop();
    });
    it("runs a web direct heartbeat like a QQ one", async () => {
      report.mockResolvedValue({ kind: "run", outcome: { status: "done", delivered: true } });
      const web = { type: "direct", platform: "web", selfId: "bot", channelId: "owner.1", userId: "owner.1" } as ScheduleScope;
      await store.create(web, { title: "心跳", prompt: "检查", purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(report.mock.calls[0][0].text).toContain("这是一次定时心跳检查");
      // User, 2026-11-18: the owner's web conversation looks across the whole instance.
      expect(report.mock.calls[0][0].text).toContain("巡查整个实例");
      expect(report.mock.calls[0][0].text).toContain("instance_tasks");
      expect(report.mock.calls[0][0].text).not.toContain("不得列出、读取其他会话的聊天记录");
      expect(report.mock.calls[0][1]).toMatchObject({ ifBusy: "reject", historyMode: "conversation" });
      expect((await store.list(web))[0].lastResult).toMatchObject({ status: "completed", notified: true });
      scheduler.stop();
    });
    it("never blocks a heartbeat's messages: silent only hides the investigation, explicit wakes the bot", async () => {
      report.mockResolvedValue({ kind: "run", outcome: { status: "done", delivered: true } });
      const web = { type: "direct", platform: "web", selfId: "bot", channelId: "owner.1", userId: "owner.1" } as ScheduleScope;
      await store.create(web, { title: "静默心跳", prompt: "检查", purpose: "heartbeat", delivery: "silent", kind: "cron", cron: "*/30 * * * *" });
      await store.create(qq, { title: "显式心跳", prompt: "检查", purpose: "heartbeat", delivery: "channel", kind: "cron", cron: "*/30 * * * *" });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      const call = (title: string) => report.mock.calls.find((item) => (item[0].text as string).includes(`"${title}"`))!;
      const [silentEvent, silentOptions] = call("静默心跳");
      expect(silentOptions).toMatchObject({ delivery: "channel", quiet: true, ifBusy: "reject", historyMode: "conversation" });
      expect(silentEvent.text).toContain("这是一次静默心跳");
      expect(silentEvent.text).toContain("照常发消息");
      const [explicitEvent, explicitOptions] = call("显式心跳");
      expect(explicitOptions).toMatchObject({ delivery: "channel", historyMode: "conversation" });
      expect(explicitOptions).not.toHaveProperty("quiet");
      expect(explicitEvent.text).toContain("这是一次显式心跳");
      // Each run stays recognisable to later heartbeats, which continue from where it got to.
      expect(silentEvent).toMatchObject({ historyNote: "之前的一次心跳检查（计划「静默心跳」）" });
      expect(silentEvent.text).toContain("接着往下查");
      expect((await store.list(web))[0].lastResult).toMatchObject({ status: "completed", notified: true });
      scheduler.stop();
    });
    it("tells a silent ordinary task that nothing it writes reaches anyone", async () => {
      report.mockResolvedValue({ kind: "run", outcome: { status: "done", delivered: false } });
      await store.create(qq, { title: "整理", prompt: "检查", delivery: "silent", kind: "cron", cron: "*/30 * * * *" });
      await store.create({ ...qq, channelId: "private:other", userId: "other" }, { title: "普通", prompt: "检查", kind: "cron", cron: "*/30 * * * *" });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      const texts = report.mock.calls.map((call) => call[0].text as string);
      const silent = texts.find((text) => text.includes("整理"))!;
      expect(silent).toContain("静默执行");
      expect(silent).toContain("finish");
      expect(silent).toContain("schedule_update");
      expect(texts.find((text) => text.includes("普通"))).not.toContain("静默执行");
      scheduler.stop();
    });
    it("skips a heartbeat when the conversation is busy", async () => {
      report.mockRejectedValue(Object.assign(new Error("busy"), { name: "AgentBusyError" }));
      await store.create(qq, { title: "心跳", prompt: "检查", purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect((await store.list(qq))[0].lastResult?.status).toBe("missed");
      scheduler.stop();
    });
    it("does not overlap heartbeat checks or replace an in-flight receipt", async () => {
      let finish!: (value: unknown) => void;
      report.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await store.create(qq, { title: "心跳", prompt: "检查", purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(report).toHaveBeenCalledOnce();
      finish({ kind: "run", outcome: { status: "done", delivered: false } });
      await vi.advanceTimersByTimeAsync(1);
      expect((await store.list(qq))[0].lastResult).toMatchObject({ status: "completed", notified: false });
      scheduler.stop();
    });
    it("rejects heartbeat use outside recurring QQ and web direct schedules", async () => {
      await expect(
        store.create(sharedScope, { title: "心跳", prompt: "检查", purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" }),
      ).rejects.toMatchObject({
        code: "heartbeat_requires_qq",
      });
      await expect(store.create(qq, { title: "心跳", prompt: "检查", purpose: "heartbeat", kind: "once", at: "2030-01-01T00:00:00Z" })).rejects.toMatchObject({
        code: "heartbeat_requires_recurring",
      });
    });
    it("records a turn that replied as completed", async () => {
      report.mockResolvedValue({ kind: "run", outcome: { status: "done", delivered: true } });
      expect(await runOnce()).toMatchObject({ status: "completed" });
      expect(trigger).not.toHaveBeenCalled();
    });
    it("records a turn that sent nothing as undelivered, unless the schedule is silent", async () => {
      report.mockResolvedValue({ kind: "run", outcome: { status: "done", delivered: false } });
      expect(await runOnce()).toMatchObject({ status: "undelivered" });
    });
    it("records a silent turn that finished as completed", async () => {
      report.mockResolvedValue({ kind: "run", outcome: { status: "done", delivered: false } });
      expect(await runOnce("silent")).toMatchObject({ status: "completed" });
    });
    it("records a failed turn as failed", async () => {
      report.mockResolvedValueOnce({ kind: "run", outcome: { status: "failed", delivered: false } });
      expect(await runOnce()).toMatchObject({ status: "failed", error: { name: "TurnFailed", message: "turn_failed" } });
    });
    it("records an aborted turn or a stopping messenger as interrupted", async () => {
      report.mockResolvedValueOnce({ kind: "run", outcome: { status: "aborted", delivered: true } });
      expect(await runOnce()).toMatchObject({ status: "interrupted" });
      report.mockResolvedValueOnce({ kind: "closed" });
      vi.setSystemTime(new Date(Date.parse(T0) + 60_000));
      await store.create(sharedScope, { title: "again", prompt: "Again.", kind: "once", at: new Date(Date.parse(T0) + 120_000).toISOString() });
      await scheduler.rearm();
      await vi.advanceTimersByTimeAsync(120_000);
      const again = (await store.list(sharedScope)).find((row) => row.title === "again")!;
      expect(again.lastResult).toMatchObject({ status: "interrupted" });
    });
    it("keeps accepted when the outcome is unknown", async () => {
      report.mockResolvedValue({ kind: "run" });
      expect(await runOnce()).toMatchObject({ status: "accepted" });
    });

    it("keeps queued until the real Core start callback and persists the actual run metadata", async () => {
      let options!: { onTurnStart: (turn: { turnId: string; startedAt: string }) => Promise<void> };
      let finish!: (report: unknown) => void;
      report.mockImplementation((_event, value) => {
        options = value as typeof options;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
      const task = await store.create(sharedScope, { title: "queued", prompt: "p", kind: "once", at: T0 });
      vi.setSystemTime(new Date(T0));
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(1000);
      const queued = (await store.listRunsManaged(task.id)).runs[0];
      expect(queued.status).toBe("queued");
      expect(queued.startedAt).toBeUndefined();
      expect(queued.finishedAt).toBeUndefined();
      const startedAt = new Date(Date.now()).toISOString();
      await options.onTurnStart({ turnId: "actual-turn", startedAt });
      expect((await store.listRunsManaged(task.id)).runs[0]).toMatchObject({ status: "running", turnId: "actual-turn", startedAt });
      finish({ kind: "run", outcome: { status: "done", delivered: true } });
      await vi.advanceTimersByTimeAsync(1000);
      expect((await store.listRunsManaged(task.id)).runs[0]).toMatchObject({ status: "completed", startedAt, finishedAt: expect.any(String) });
      scheduler.stop();
    });

    it("stores only a safe failure category in history when submission throws a private error", async () => {
      report.mockRejectedValue(new Error("Authorization: Bearer provider-secret"));
      await runOnce();
      const [task] = await store.list(sharedScope);
      const history = await store.listRunsManaged(task.id);
      expect(history.runs[0]).toMatchObject({ status: "failed", error: { code: "submission_failed" } });
      expect(history.runs[0].startedAt).toBeUndefined();
      expect(JSON.stringify(history)).not.toContain("provider-secret");
    });
  });

  describe("due event", () => {
    it("names the private chat's user so the run lands in the live conversation", async () => {
      const onebot = {
        type: "direct",
        platform: "onebot",
        selfId: "3535802886",
        channelId: "private:1049700117",
        userId: "1049700117",
      } satisfies ScheduleScope;
      vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
      const created = await store.create(onebot, { title: "签到", prompt: "签到。", kind: "once", at: T0 });
      expect(created.userId).toBe("1049700117");
      vi.setSystemTime(new Date(T0));
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(trigger.mock.calls[0][0]).toMatchObject({
        channel: { id: "private:1049700117", type: CHANNEL_TYPE.direct },
        user: { id: "1049700117" },
      });
    });

    it("includes the bot's notes after the prompt", async () => {
      vi.setSystemTime(new Date(Date.parse(T0) - 3_600_000));
      const created = await store.create(sharedScope, { title: "签到", prompt: "打开页面签到。", kind: "once", at: T0 });
      await store.update(sharedScope, created.id, { notes: "用 computer_cua 点「点击这里签到」，先关掉广告浮层。" });
      vi.setSystemTime(new Date(T0));
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(60_000);
      const text = trigger.mock.calls[0][0].text;
      expect(text).toContain("打开页面签到。\n\n你之前执行这个任务时记下的做法（先照着试）：\n用 computer_cua 点「点击这里签到」，先关掉广告浮层。");
      expect(text.indexOf("做法")).toBeGreaterThan(text.indexOf("打开页面签到。"));
    });
  });
});

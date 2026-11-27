import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { HANDOFF_EXPIRY_MS, Tasks } from "../src/tasks/manager.js";
import { TaskStore } from "../src/tasks/store.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const input = { channel: "channel-a", session: "first.jsonl", kind: "computer" as const, instruction: "每日签到" };

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "yib-handoff-expiry-"));
  dirs.push(path);
  return path;
}

async function waiting(store: TaskStore, key: string, requestedAt: number, deviceId?: string) {
  const { record } = await store.create({ ...input, key });
  await store.update(record.id, (row) => {
    row.status = "waiting";
    row.result = "需要先登录签到网站";
    row.notification = "delivered";
    row.handoff = { id: randomUUID(), state: "pending", instruction: "请在电脑上登录签到网站", requestedAt, ...(deviceId ? { deviceId } : {}) };
  });
  return record.id;
}

// User, 2026-11-19: 「超过一天就自动过期，由当天新建的任务接替」. Preview records: check-in handoffs waited 2.5–4.6 days
// while the daily schedule kept creating new tasks.
it("ends a task whose handoff nobody handled for a day, silently and keeping its report", async () => {
  const path = await directory();
  const store = new TaskStore(path);
  const now = Date.now();
  const old = await waiting(store, "old", now - HANDOFF_EXPIRY_MS - 60_000);
  const fresh = await waiting(store, "fresh", now - HANDOFF_EXPIRY_MS + 3_600_000);
  const held = await waiting(store, "held", now - HANDOFF_EXPIRY_MS - 60_000, randomUUID());
  const notify = vi.fn(async () => "delivered" as const),
    changed = vi.fn();
  const manager = new Tasks(path, {
    prepare: vi.fn(),
    notify,
    diagnostic: vi.fn(),
    changed,
    // The user is controlling the computer of this handoff right now.
    handoffInProgress: (record) => record.handoff?.deviceId !== undefined,
  });
  await manager.start();
  try {
    const ended = (await manager.store.get(old))!;
    expect(ended).toMatchObject({ status: "cancelled", handoff: { state: "cancelled" }, notification: "delivered" });
    expect(ended.result).toContain("交接超过一天没有处理，任务已自动结束");
    expect(ended.result).toContain("结束前的报告：需要先登录签到网站");
    await expect(manager.resolveHandoff(old, ended.handoff!.id)).rejects.toThrow("task_handoff_stale");
    expect(await manager.store.get(fresh)).toMatchObject({ status: "waiting", handoff: { state: "pending" } });
    expect(await manager.store.get(held)).toMatchObject({ status: "waiting", handoff: { state: "pending" } });
    expect(notify).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    // A later check ends the next one once its day has passed; the computer in use still keeps its handoff.
    expect(await manager.expireHandoffs(now + 3_600_000 + 60_000)).toBe(1);
    expect(await manager.store.get(fresh)).toMatchObject({ status: "cancelled" });
    expect(await manager.store.get(held)).toMatchObject({ status: "waiting" });
  } finally {
    await manager.stop();
  }
});

it("checks for expired handoffs every ten minutes until stopped", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const manager = new Tasks(await directory(), { prepare: vi.fn(), notify: vi.fn(), diagnostic: vi.fn(), changed: vi.fn() });
  const expire = vi.spyOn(manager, "expireHandoffs");
  await manager.start();
  expect(expire).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(expire).toHaveBeenCalledTimes(2);
  await manager.stop();
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
  expect(expire).toHaveBeenCalledTimes(2);
});

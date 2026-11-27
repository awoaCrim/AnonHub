import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { ChannelContext } from "../src/channels/index.js";
import { YesImBotCore } from "../src/core.js";
import { Tasks, type TaskHost } from "../src/tasks/manager.js";
import { TaskStore, type TaskRecord } from "../src/tasks/store.js";
import { TestEvents, testAccount } from "./helpers/index.js";

// User, 2026-11-20: 「任何任务都不在需要我核实，让主bot核实就行了」.
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "yesimbot-task-unknown-"));
  directories.push(path);
  return path;
}

const input = { key: "turn:call", channel: "channel-a", session: "first.jsonl", kind: "computer" as const, instruction: "检查服务器上报" };

it("hands a task cut off by a process loss to the main conversation once, without running it again", async () => {
  const path = await directory();
  const store = new TaskStore(path);
  const running = (await store.create(input)).record;
  const queued = (await store.create({ ...input, key: "queued" })).record;
  await store.update(running.id, (row) => {
    row.status = "running";
  });
  const notify = vi.fn(async (_record: TaskRecord) => "delivered" as const),
    prepare = vi.fn();
  const manager = new Tasks(path, { prepare, notify, diagnostic: vi.fn(), changed: vi.fn() });
  await manager.start();
  await vi.waitFor(async () => {
    for (const id of [running.id, queued.id]) expect(await manager.store.get(id)).toMatchObject({ status: "unknown", notification: "delivered" });
  });
  expect(notify.mock.calls.map(([record]) => record.id).sort()).toEqual([running.id, queued.id].sort());
  expect(notify.mock.calls[0]?.[0]).toMatchObject({ status: "unknown", result: "进程中断，执行结果需要核实；未自动重新执行。" });
  expect(prepare).not.toHaveBeenCalled();
  await manager.stop();
  const restarted = new Tasks(path, { prepare, notify, diagnostic: vi.fn(), changed: vi.fn() });
  await restarted.start();
  expect(notify).toHaveBeenCalledTimes(2);
  await restarted.stop();
});

it("tells the main conversation to check an unknown result itself rather than ask the user", async () => {
  const path = await directory();
  const manager = new Tasks(path, { prepare: vi.fn(), notify: vi.fn(), diagnostic: vi.fn(), changed: vi.fn() });
  const prompt = await manager.plugin({ channel: "channel-a", session: "first.jsonl" }).appendSystemPrompt?.({} as never);
  expect(prompt).toContain("结果未知时由你自己核实，不要让用户去核实");
  expect(prompt).not.toContain("结果未知时不要重做，并告诉用户");

  await writeFile(join(path, "models.json"), "{}");
  const scope: ChannelContext = { type: "direct", platform: "test", channelId: "channel", selfId: "bot", userId: "user" };
  const service = new YesImBotCore({
    baseDir: path,
    config: { basePath: path, chatModel: "test:model" },
    events: new TestEvents(),
    account: () => testAccount(scope.platform, scope.selfId),
  });
  const internal = service as unknown as { channels: { storedContext: unknown; resolve: unknown }; messenger: { postAndReport: unknown } };
  internal.channels.storedContext = vi.fn(async () => scope);
  internal.channels.resolve = vi.fn(async () => ({ conversation: { currentSessionId: () => "session" } }));
  const postAndReport = vi.fn(async (_event: { text: string }) => ({ kind: "run", outcome: { delivered: true } }));
  internal.messenger.postAndReport = postAndReport;
  const host = (service.tasks as unknown as { host: TaskHost }).host;
  const record: TaskRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    channel: "channel",
    session: "session.jsonl",
    key: "unknown",
    kind: "computer",
    instruction: "重启上报服务",
    status: "unknown",
    result: "服务中断，需要核实已执行操作。",
    createdAt: 0,
    updatedAt: 0,
  };
  try {
    expect(await host.notify(record)).toBe("delivered");
    const text = postAndReport.mock.calls[0]?.[0].text ?? "";
    expect(text).toContain("服务中断，需要核实已执行操作。");
    expect(text).toContain("由你自己核实，不要让用户去核实");
    expect(text).not.toContain("不要重做，并告诉用户");
  } finally {
    await service.tasks.stop();
  }
});

it("writes nothing after stop: a result answered later stays claimed", async () => {
  const path = await directory();
  const store = new TaskStore(path);
  const { record } = await store.create(input);
  await store.update(record.id, (row) => {
    row.status = "running";
  });
  let answer: (status: "delivered") => void = () => {};
  const notify = vi.fn(() => new Promise<"delivered">((resolve) => (answer = resolve)));
  const manager = new Tasks(path, { prepare: vi.fn(), notify, diagnostic: vi.fn(), changed: vi.fn() });
  await manager.start();
  await vi.waitFor(() => expect(notify).toHaveBeenCalled());
  await manager.stop();
  answer("delivered");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await expect(manager.store.update(record.id, () => {})).rejects.toMatchObject({ code: "task_service_stopping" });
  expect(await new TaskStore(path).get(record.id)).toMatchObject({ notification: "unknown" });
});

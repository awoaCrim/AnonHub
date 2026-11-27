import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import * as platforms from "@yesimbot/contracts/platforms";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import type { ScheduledTask } from "../src/shared/schedules";
import { ApiError } from "../web/src/lib/api";
import * as scheduleRuns from "../web/src/lib/schedule-runs";
import { ui } from "./fixtures/ui";

interface TaskFixture {
  id: string;
  revision?: string;
  title?: string;
  platform?: string;
  selfId?: string;
  channelId?: string;
  type?: string;
}

interface SnapshotFixture {
  available: boolean;
  tasks: TaskFixture[];
}

interface Bindings {
  loading: vue.Ref<boolean>;
  error: vue.Ref<string>;
  editing: vue.Ref<string>;
  selectedId: vue.Ref<string>;
  scheduleEditor: vue.Ref<{ cancel(): Promise<void> } | undefined>;
  snapshot: vue.Ref<SnapshotFixture | undefined>;
  tasks: vue.ComputedRef<TaskFixture[]>;
  results: Record<"accepted" | "completed" | "undelivered" | "failed", string>;
  rule(task: Pick<ScheduledTask, "kind"> & Partial<Pick<ScheduledTask, "cron" | "at">>): string;
  outcome(task: Pick<ScheduledTask, "purpose" | "lastResult">): string;
  load(): Promise<void>;
  remove(task: TaskFixture): Promise<void>;
  openTask(task: TaskFixture): void;
  updateOpen(open: boolean): Promise<void>;
  cancelEditing(): void;
  saved(task?: TaskFixture): Promise<void>;
}

function harness(platform = "web") {
  let dispose = () => {};
  const confirm = vi.fn(async () => true);
  const toast = vi.fn();
  const api = vi.fn(async (): Promise<SnapshotFixture> => ({ available: true, tasks: [] }));
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/ScheduledTasks.vue", import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: "schedules-test" });
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => Bindings } } };
  runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module,
    exports: module.exports,
    require: (name: string) =>
      ({
        vue: {
          ...vue,
          onBeforeUnmount: (fn: () => void) => {
            dispose = fn;
          },
        },
        "../lib/api": { api, ApiError },
        "../lib/editor-guard": { trackEditor: () => {} },
        "../lib/dialog": { confirmDialog: confirm },
        "../lib/toast": { toast },
        "./LimitedList.vue": { default: {} },
        "./LoadingRows.vue": { default: {} },
        "./ScheduleEditor.vue": { default: {} },
        "./ScheduleRunHistory.vue": { default: {} },
        "../lib/schedule-runs": scheduleRuns,
        "@yesimbot/contracts/platforms": platforms,
      })[name] ?? ui(name),
  });
  const props = vue.reactive({ enabled: true, scope: { platform, selfId: "bot", channelId: "owner", type: "direct" } });
  const scope = vue.effectScope();
  const state = scope.run(() => module.exports.default.setup(props, { expose: () => {}, emit: () => {} }))!;
  return {
    state,
    confirm,
    toast,
    props,
    api,
    dispose: () => {
      dispose();
      scope.stop();
    },
  };
}

it("loads fresh on mount and capability changes, and uses the scheduler timezone", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.state.loading.value).toBe(false));
  expect(h.api).toHaveBeenCalledExactlyOnceWith("/yesimbot/api/v1/schedules", undefined, { fresh: true });
  expect(h.state.rule({ kind: "cron", cron: "0 9 * * *" })).toBe("每天 09:00");
  expect(h.state.rule({ kind: "cron", cron: "0 9 * * 1-5" })).toBe("重复 · 0 9 * * 1-5");
  expect(h.state.rule({ kind: "cron", cron: "*/30 * * * *" })).toBe("每 30 分钟");
  expect(h.state.rule({ kind: "cron", cron: "*/7 * * * *" })).toBe("重复 · */7 * * * *");
  expect(h.state.rule({ kind: "once", at: "2026-11-05T01:00:00Z" })).toContain("2026/11/05 09:00");
  expect(h.state.results.accepted).toBe("结果未知");
  expect(h.state.results).toMatchObject({ completed: "已结束", undelivered: "未发送回复", failed: "执行失败" });
  expect(h.state.outcome({ purpose: "heartbeat", lastResult: { occurrenceAt: "2026-11-14T01:00:00Z", status: "completed" } })).toBe("已结束");
  expect(h.state.outcome({ purpose: "heartbeat", lastResult: { occurrenceAt: "2026-11-14T01:00:00Z", status: "completed", notified: false } })).toBe(
    "检查完成，无需通知",
  );
  h.props.enabled = false;
  await vue.nextTick();
  expect(h.api).toHaveBeenCalledTimes(2);
  h.dispose();
});

it("keeps the last list on failure, clears error on retry and ignores late or disposed reads", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.state.loading.value).toBe(false));
  h.api.mockRejectedValueOnce(new Error("offline"));
  await h.state.load();
  expect(h.state.error.value).toContain("加载失败");
  expect(h.state.snapshot.value).toEqual({ available: true, tasks: [] });
  let resolve!: (value: SnapshotFixture) => void;
  h.api.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = h.state.load();
  await h.state.load();
  resolve({ available: false, tasks: [] });
  await pending;
  expect(h.state.snapshot.value!.available).toBe(true);
  expect(h.state.error.value).toBe("");
  h.api.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const late = h.state.load();
  h.dispose();
  resolve({ available: false, tasks: [] });
  await late;
  expect(h.state.snapshot.value!.available).toBe(true);
});

it("deletes only after confirmation and reports stale revisions without removing the row", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.state.loading.value).toBe(false));
  const task = { id: "a", revision: "b".repeat(64), title: "任务" };
  h.confirm.mockResolvedValueOnce(false);
  await h.state.remove(task);
  expect(h.api).toHaveBeenCalledTimes(1);
  h.state.snapshot.value!.tasks = [task];
  h.api.mockRejectedValueOnce(new ApiError(409, "schedule_changed"));
  await h.state.remove(task);
  expect(h.state.snapshot.value!.tasks).toHaveLength(1);
  expect(h.toast).toHaveBeenCalledWith("任务已被修改或触发，请刷新后重新确认删除。", "danger");
  h.api.mockResolvedValueOnce({ ok: true } as never);
  await h.state.remove(task);
  expect(h.api).toHaveBeenCalledWith("/yesimbot/api/v1/schedules/delete", { id: "a", revision: task.revision });
  expect(h.state.snapshot.value!.tasks).toEqual([]);
  h.dispose();
});

it("closes the dialog on save, merges the saved row in place without refetching, and refetches without clearing when the response has no row", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.state.loading.value).toBe(false));
  h.state.snapshot.value = {
    available: true,
    tasks: [
      { id: "a", title: "旧" },
      { id: "b", title: "B" },
    ],
  };
  h.api.mockClear();
  h.state.selectedId.value = "a";
  h.state.editing.value = "a";
  await h.state.saved({ id: "a", title: "新" });
  expect(h.state.editing.value).toBe("");
  expect(h.state.selectedId.value).toBe("");
  expect(h.api).not.toHaveBeenCalled();
  expect(h.state.snapshot.value!.tasks).toEqual([
    { id: "a", title: "新" },
    { id: "b", title: "B" },
  ]);
  // A row this view does not list is not inserted; the view refetches instead.
  h.api.mockImplementationOnce(async () => ({
    available: true,
    tasks: [
      { id: "a", title: "新" },
      { id: "b", title: "B" },
    ],
  }));
  await h.state.saved({ id: "c", title: "C" });
  expect(h.api).toHaveBeenCalledTimes(1);
  expect(h.state.snapshot.value!.tasks.map((task) => task.id)).toEqual(["a", "b"]);
  let seen: unknown;
  h.api.mockImplementationOnce(async () => {
    seen = h.state.snapshot.value;
    return { available: true, tasks: [] };
  });
  await h.state.saved();
  expect(seen).toBeDefined();
  h.dispose();
});

it("keeps non-web schedule views scoped to the selected conversation and resets editing when it changes", async () => {
  const h = harness("onebot");
  await vi.waitFor(() => expect(h.state.loading.value).toBe(false));
  const own = { id: "own", platform: "onebot", selfId: "bot", channelId: "owner", type: "direct" };
  h.state.snapshot.value = {
    available: true,
    tasks: [
      own,
      { ...own, id: "other-chat", channelId: "other" },
      { ...own, id: "other-bot", selfId: "other" },
      { ...own, id: "other-platform", platform: "web" },
      { ...own, id: "group", type: "guild" },
    ],
  };
  expect(h.state.tasks.value.map((task) => task.id)).toEqual(["own"]);
  h.state.editing.value = "own";
  h.state.selectedId.value = "own";
  h.props.scope.channelId = "other";
  await vue.nextTick();
  expect(h.state.editing.value).toBe("");
  expect(h.state.selectedId.value).toBe("");
  expect(h.state.tasks.value).toEqual([]);
  h.dispose();
});

it("keeps an open plan and the list when the chat hands over an equal scope or another web conversation", async () => {
  const h = harness();
  try {
    await vi.waitFor(() => expect(h.state.loading.value).toBe(false));
    const plan = { id: "plan", platform: "onebot", selfId: "qq", channelId: "group", type: "guild" };
    h.state.snapshot.value = { available: true, tasks: [plan] };
    h.state.openTask(plan);
    const reads = h.api.mock.calls.length;
    // Every chat update hands over a new scope object with the same values.
    h.props.scope = { ...h.props.scope };
    await vue.nextTick();
    // The web owner lists the whole instance, whichever web conversation is open.
    h.props.scope = { ...h.props.scope, channelId: "owner.a1b2c3d4" };
    await vue.nextTick();
    expect(h.state.selectedId.value).toBe("plan");
    expect(h.state.snapshot.value?.tasks).toEqual([plan]);
    expect(h.api).toHaveBeenCalledTimes(reads);
  } finally {
    h.dispose();
  }
});

it("shows the web owner all schedules returned by their isolated instance without changing their destinations", async () => {
  const h = harness();
  try {
    await vi.waitFor(() => expect(h.state.loading.value).toBe(false));
    const qq = { id: "qq-heartbeat", platform: "onebot", selfId: "qq-bot", channelId: "group", type: "guild", purpose: "heartbeat" };
    const web = { id: "web-plan", platform: "web", selfId: "bot", channelId: "previous-web-chat", type: "direct" };
    h.state.snapshot.value = { available: true, tasks: [qq, web] };
    expect(h.state.tasks.value).toEqual([qq, web]);
    h.state.openTask(qq);
    expect(h.state.selectedId.value).toBe(qq.id);
    expect(h.state.snapshot.value.tasks[0]).toEqual(qq);
  } finally {
    h.dispose();
  }
});

it("routes dialog dismissal through the schedule editor's cancel, which keeps the dialog only while a save is in flight", async () => {
  const h = harness();
  try {
    await vi.waitFor(() => expect(h.state.loading.value).toBe(false));
    const task = { id: "own", platform: "web", selfId: "bot", channelId: "owner", type: "direct" };
    h.state.snapshot.value = { available: true, tasks: [task] };
    h.state.openTask(task);
    h.state.editing.value = task.id;
    const cancel = vi.fn(async () => {});
    h.state.scheduleEditor.value = { cancel };
    await h.state.updateOpen(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.state.selectedId.value).toBe(task.id);
    expect(h.state.editing.value).toBe(task.id);
    cancel.mockImplementationOnce(async () => h.state.cancelEditing());
    await h.state.updateOpen(false);
    expect(h.state.selectedId.value).toBe("");
    expect(h.state.editing.value).toBe("");
  } finally {
    h.dispose();
  }
});

it("lists schedules newest first by creation time, then last edit, keeping the server order for undated ones", async () => {
  const h = harness();
  try {
    await vi.waitFor(() => expect(h.state.loading.value).toBe(false));
    const row = (id: string, dates: { createdAt?: string; updatedAt?: string }) => ({
      id,
      platform: "web",
      selfId: "bot",
      channelId: "c",
      type: "direct",
      ...dates,
    });
    h.state.snapshot.value = {
      available: true,
      tasks: [
        row("undated-a", {}),
        row("old", { createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-14T00:00:00Z" }),
        row("edited-only", { updatedAt: "2026-11-10T00:00:00Z" }),
        row("new", { createdAt: "2026-11-12T00:00:00Z" }),
        row("undated-b", {}),
      ],
    };
    expect(h.state.tasks.value.map((task) => task.id)).toEqual(["new", "edited-only", "old", "undated-a", "undated-b"]);
  } finally {
    h.dispose();
  }
});

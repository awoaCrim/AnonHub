import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import type { ScheduleRun } from "../src/shared/schedules";
import * as scheduleRuns from "../web/src/lib/schedule-runs";
import { ui } from "./fixtures/ui";

function run(id: string): ScheduleRun {
  return {
    id,
    scheduleId: "plan",
    occurrenceAt: "2026-11-14T01:00:00Z",
    recordedAt: "2026-11-14T01:00:00Z",
    status: "running",
    purpose: "task",
    delivery: "channel",
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

interface View {
  selectedRun: vue.Ref<ScheduleRun | undefined>;
  selected: vue.ComputedRef<ScheduleRun | undefined>;
  openRun(run: ScheduleRun): void;
  back(): Promise<void>;
  refresh(): Promise<void>;
}

function harness() {
  const state = vue.reactive({ runs: [run("a"), run("b")], error: "", loading: false, pages: 1 });
  const history = { state, open: vi.fn(), refresh: vi.fn(async () => {}), dispose: vi.fn() };
  let cleanup = () => {};
  let mount = () => {};
  let poll = () => {};
  const document = { hidden: false };
  const clearTimer = vi.fn();
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/ScheduleRunHistory.vue", import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: "run-history-test" });
  const module = { exports: {} as { default: { setup(props: unknown, context: unknown): View } } };
  runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module,
    exports: module.exports,
    document,
    setInterval: (callback: () => void) => {
      poll = callback;
      return 1;
    },
    clearInterval: clearTimer,
    require: (name: string) =>
      ({
        vue: { ...vue, onMounted: (callback: () => void) => (mount = callback), onBeforeUnmount: (callback: () => void) => (cleanup = callback) },
        "../state/schedule-runs": { createScheduleRunHistory: () => history },
        "../lib/schedule-runs": scheduleRuns,
      })[name] ?? ui(name),
  });
  const scope = vue.effectScope();
  const props = vue.reactive({ task: { id: "plan" } });
  const view = scope.run(() => module.exports.default.setup(props, { emit() {}, expose() {} }))!;
  mount();
  return {
    view,
    state,
    history,
    props,
    document,
    clearTimer,
    poll: () => poll(),
    dispose() {
      cleanup();
      scope.stop();
    },
  };
}

it("does not reopen a dismissed detail or replace the user's next selection when a refresh returns", async () => {
  const h = harness();
  try {
    h.view.openRun(h.state.runs[0]);
    const pending = deferred();
    h.history.refresh.mockImplementationOnce(() => pending.promise);
    const refreshing = h.view.refresh();
    await h.view.back();
    h.view.openRun(h.state.runs[1]);
    pending.resolve();
    await refreshing;
    expect(h.view.selected.value?.id).toBe("b");

    const next = deferred();
    h.history.refresh.mockImplementationOnce(() => next.promise);
    const reading = h.view.refresh();
    await h.view.back();
    next.resolve();
    await reading;
    expect(h.view.selected.value).toBeUndefined();
  } finally {
    h.dispose();
  }
});

it("polls active runs only on the visible first page and releases the timer on close", async () => {
  const h = harness();
  h.poll();
  expect(h.history.refresh).toHaveBeenCalledTimes(1);
  h.document.hidden = true;
  h.poll();
  h.document.hidden = false;
  h.state.pages = 2;
  h.poll();
  h.state.pages = 1;
  h.state.loading = true;
  h.poll();
  h.state.loading = false;
  h.state.error = "读取失败";
  h.poll();
  h.state.error = "";
  h.state.runs = [{ ...run("finished"), status: "completed" }];
  h.poll();
  expect(h.history.refresh).toHaveBeenCalledTimes(1);
  h.dispose();
  expect(h.clearTimer).toHaveBeenCalledExactlyOnceWith(1);
  expect(h.history.dispose).toHaveBeenCalledOnce();
});

it("keeps a failed-refresh detail with its error, but removes an old page's stale running status after success", async () => {
  const h = harness();
  try {
    h.view.openRun(h.state.runs[0]);
    h.history.refresh.mockImplementationOnce(async () => {
      h.state.error = "读取失败";
    });
    await h.view.refresh();
    expect(h.view.selected.value?.id).toBe("a");
    h.history.refresh.mockImplementationOnce(async () => {
      h.state.error = "";
      h.state.runs = [run("new")];
    });
    await h.view.refresh();
    expect(h.view.selected.value).toBeUndefined();
    expect(h.state.runs.map((item) => item.id)).toEqual(["new"]);
  } finally {
    h.dispose();
  }
});

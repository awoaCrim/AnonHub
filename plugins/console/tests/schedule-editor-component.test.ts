import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import { ApiError } from "../web/src/lib/api";
import { ui } from "./fixtures/ui";

interface Bindings {
  form: { title: string; prompt: string; notes: string; time: string; at: string; purpose: "task" | "heartbeat" };
  terminal: boolean;
  error: vue.Ref<string>;
  patch(): Record<string, unknown>;
  save(): Promise<void>;
  cancel(): Promise<void>;
}

function harness(overrides: Record<string, unknown> = {}) {
  let dispose = () => {};
  const api = vi.fn(async () => ({ ok: true }));
  const emit = vi.fn();
  const confirmDiscard = vi.fn(async () => true);
  const task = {
    id: "a",
    revision: "b".repeat(64),
    title: "早报",
    prompt: "昨天新闻",
    kind: "cron",
    cron: "0 9 * * *",
    at: null,
    delivery: "channel",
    state: "enabled",
    ...overrides,
  };
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/ScheduleEditor.vue", import.meta.url), "utf8"));
  const code = ts.transpileModule(compileScript(descriptor, { id: "editor" }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => Bindings } } };
  runInNewContext(code, {
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
        "../lib/dialog": { confirmDiscard },
        "./PickerMenu.vue": { default: {} },
      })[name] ?? ui(name),
  });
  const state = module.exports.default.setup({ task }, { expose() {}, emit });
  return { state, task, api, emit, confirmDiscard, dispose: () => dispose() };
}

it("edits daily time with an exact revision and prevents repeat saves", async () => {
  const h = harness();
  h.state.form.time = "10:30";
  expect(h.state.patch()).toEqual({ kind: "cron", cron: "30 10 * * *" });
  await Promise.all([h.state.save(), h.state.save()]);
  expect(h.api).toHaveBeenCalledExactlyOnceWith("/yesimbot/api/v1/schedules/update", {
    id: "a",
    revision: h.task.revision,
    patch: { kind: "cron", cron: "30 10 * * *" },
  });
  expect(h.emit).toHaveBeenCalledWith("saved", undefined);
});

it("preserves once seconds and past rules during text edits; writes explicit Shanghai offset for a new time", () => {
  const h = harness({ kind: "once", at: "2030-01-01T01:00:30Z", cron: null });
  expect(h.state.form.at).toBe("2030-01-01T09:00");
  h.state.form.title = "修改标题";
  expect(h.state.patch()).toEqual({ title: "修改标题" });
  h.state.form.at = "2030-01-02T09:15";
  expect(h.state.patch()).toEqual({ title: "修改标题", kind: "once", at: "2030-01-02T09:15:00+08:00" });
  const past = harness({ kind: "once", at: "2020-01-01T01:00:30Z", state: "completed", cron: null });
  past.state.form.prompt = "新内容";
  expect(past.state.terminal).toBe(true);
  expect(past.state.patch()).toEqual({ prompt: "新内容" });
});

it("edits, trims and clears the bot's notes as their own field", () => {
  const h = harness({ notes: "点签到按钮" });
  expect(h.state.form.notes).toBe("点签到按钮");
  expect(h.state.patch()).toEqual({});
  h.state.form.notes = "  先关广告，再点签到  ";
  expect(h.state.patch()).toEqual({ notes: "先关广告，再点签到" });
  h.state.form.notes = "";
  expect(h.state.patch()).toEqual({ notes: "" });
  const none = harness();
  expect(none.state.form.notes).toBe("");
  none.state.form.notes = "  ";
  expect(none.state.patch()).toEqual({});
});

it("keeps a conflicting draft until 取消, which drops it without asking, and ignores disposed success", async () => {
  const h = harness();
  h.state.form.prompt = "新内容";
  h.api.mockRejectedValueOnce(new ApiError(409, "schedule_changed"));
  await h.state.save();
  expect(h.state.error.value).toContain("任务已被修改或触发");
  expect(h.state.form.prompt).toBe("新内容");
  expect(h.emit).not.toHaveBeenCalled();
  const saving = deferred();
  h.api.mockImplementationOnce(() => saving.promise);
  const pending = h.state.save();
  await h.state.cancel();
  expect(h.emit).not.toHaveBeenCalled();
  saving.reject(new ApiError(409, "schedule_changed"));
  await pending;
  await h.state.cancel();
  expect(h.confirmDiscard).not.toHaveBeenCalled();
  expect(h.emit).toHaveBeenCalledExactlyOnceWith("cancel");
  h.emit.mockClear();
  h.api.mockImplementationOnce(async () => {
    h.dispose();
    return { ok: true };
  });
  await h.state.save();
  expect(h.emit).not.toHaveBeenCalled();
});

it("converts a QQ once task into a half-hour heartbeat without changing its content", async () => {
  const h = harness({ platform: "onebot", kind: "once", at: "2030-01-01T01:00:00Z", cron: null });
  h.state.form.purpose = "heartbeat";
  await vue.nextTick();
  expect(h.state.patch()).toEqual({ purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" });
});

it("offers the heartbeat purpose for a web direct schedule but not for a web group or other platforms", () => {
  const source = readFileSync(new URL("../web/src/components/ScheduleEditor.vue", import.meta.url), "utf8");
  expect(source).toContain("task.platform === 'onebot' || (task.platform === 'web' && task.type === 'direct')");
  const h = harness({ platform: "web", type: "direct", kind: "once", at: "2030-01-01T01:00:00Z", cron: null });
  h.state.form.purpose = "heartbeat";
  return vue.nextTick().then(() => expect(h.state.patch()).toEqual({ purpose: "heartbeat", kind: "cron", cron: "*/30 * * * *" }));
});

function deferred() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<never>((_resolve, fail) => (reject = fail));
  return { promise, reject };
}

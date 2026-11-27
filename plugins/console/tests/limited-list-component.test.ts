import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import LimitedList from "../web/src/components/LimitedList.vue";
import { ui } from "./fixtures/ui";

// Reka's portal only mounts in a browser, so the dialog parts render inline here; LimitedList's own logic is what is under test.
vi.mock("../web/src/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const part = (tag: string) =>
    defineComponent({
      setup:
        (_props, { slots }) =>
        () =>
          h(tag, slots.default?.()),
    });
  const Dialog = defineComponent({
    props: { open: Boolean },
    setup:
      (props, { slots }) =>
      () =>
        props.open ? h("div", { class: "dialog" }, slots.default?.()) : null,
  });
  return { Dialog, DialogContent: part("section"), DialogHeader: part("header"), DialogTitle: part("h2") };
});

const items = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `t${index + 1}`, title: `任务${index + 1}` }));

/** Teleported content (the dialog) lands in `ctx.teleports`, keyed by target. */
async function render(list: Array<{ id: string; title: string }>, open = false) {
  const ctx: { teleports?: Record<string, string> } = {};
  const html = await renderToString(
    vue.createSSRApp({
      render: () =>
        vue.h(
          LimitedList,
          { items: list, buttonLabel: `查看全部 ${list.length} 项…`, dialogTitle: `全部 · ${list.length}`, open },
          { row: ({ item }: { item: { title: string } }) => vue.h("button", { class: "row" }, item.title) },
        ),
    }),
    ctx,
  );
  return html + Object.values(ctx.teleports ?? {}).join("");
}
const rows = (html: string) => [...html.matchAll(/<button class="row">([^<]+)<\/button>/g)].map((match) => match[1]);

it("shows three rows and a view-all button when there are more", async () => {
  const html = await render(items(5));
  expect(rows(html)).toEqual(["任务1", "任务2", "任务3"]);
  expect(html).toContain("查看全部 5 项…");
});

it("shows no button and no dialog when there are three or fewer", async () => {
  for (const count of [0, 2, 3]) {
    const html = await render(items(count));
    expect(rows(html)).toHaveLength(count);
    expect(html).not.toContain("查看全部");
    expect(html).not.toContain("data-view-all");
  }
});

it("lists every item, in the same order and with the same row, in the dialog", async () => {
  const html = await render(items(5), true);
  expect(html).toContain("全部 · 5");
  // Three inline rows, then all five again inside the dialog.
  expect(rows(html)).toEqual(["任务1", "任务2", "任务3", "任务1", "任务2", "任务3", "任务4", "任务5"]);
});

// ---------- Newest first ----------
function load(file: string, requires: Record<string, unknown>, props: unknown) {
  const { descriptor } = parse(readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), "utf8"));
  const module = { exports: {} as { default: { setup: (props: unknown, context: unknown) => Record<string, unknown> } } };
  runInNewContext(ts.transpileModule(compileScript(descriptor, { id: file }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module,
    exports: module.exports,
    AbortController,
    require: (name: string) => requires[name] ?? ui(name) ?? (name.endsWith(".vue") ? { default: {} } : {}),
  });
  return module.exports.default.setup(props, { expose() {}, emit() {} }) as Record<string, vue.Ref<unknown> & vue.ComputedRef<unknown>>;
}

it("sorts background tasks newest first inside each group", () => {
  const task = (id: string, status: string, updatedAt: number) => ({ id, instruction: id, channel: "c", session: "s", status, updatedAt });
  const topic = vue.reactive({
    data: {
      items: [task("old", "succeeded", 1), task("new", "failed", 9), task("mid", "cancelled", 5), task("run-a", "running", 2), task("run-b", "queued", 7)],
    },
    failed: false,
    unavailable: false,
  });
  const scope = vue.effectScope();
  const state = scope.run(() =>
    load(
      "TaskPanel.vue",
      {
        vue: { ...vue, onBeforeUnmount() {} },
        "../lib/use-topic": { useTopic: () => topic },
        "../lib/api": { api: vi.fn(), ApiError: class {} },
        "../lib/editor-guard": { trackEditor() {} },
        "../lib/dialog": { confirmDiscard: vi.fn() },
      },
      vue.reactive({ conversation: { channel: "c", session: "s" } }),
    ),
  )!;
  const groups = state.groups!.value as Array<{ label: string; items: Array<{ id: string }> }>;
  expect(groups.find((group) => group.label === "已结束")!.items.map((item) => item.id)).toEqual(["new", "mid", "old"]);
  expect(groups.find((group) => group.label === "正在进行")!.items.map((item) => item.id)).toEqual(["run-b", "run-a"]);
  scope.stop();
});

it("ends a paused task that another task carries on, and keeps a user's waiting task open", () => {
  const task = (id: string, extra: Record<string, unknown>) => ({ id, instruction: id, channel: "c", session: "s", status: "waiting", updatedAt: 1, ...extra });
  const topic = vue.reactive({
    data: {
      items: [task("continued", { pauseReason: "context_budget", continuedBy: "next" }), task("paused", { pauseReason: "context_budget" }), task("ask", {})],
    },
    failed: false,
    unavailable: false,
  });
  const scope = vue.effectScope();
  const state = scope.run(() =>
    load(
      "TaskPanel.vue",
      {
        vue: { ...vue, onBeforeUnmount() {} },
        "../lib/use-topic": { useTopic: () => topic },
        "../lib/api": { api: vi.fn(), ApiError: class {} },
        "../lib/editor-guard": { trackEditor() {} },
      },
      vue.reactive({ conversation: { channel: "c", session: "s" } }),
    ),
  )!;
  const groups = state.groups!.value as Array<{ label: string; items: Array<{ id: string }> }>;
  expect(groups.find((group) => group.label === "需要你处理")!.items.map((item) => item.id)).toEqual(["paused", "ask"]);
  expect(groups.find((group) => group.label === "已结束")!.items.map((item) => item.id)).toEqual(["continued"]);
  const label = state.statusLabel as unknown as (task: unknown) => string;
  expect(label(topic.data.items[0])).toBe("已暂停，后续任务接着做");
  expect(label(topic.data.items[1])).toBe("已暂停");
  expect(label(topic.data.items[2])).toBe("需要补充");
  scope.stop();
});

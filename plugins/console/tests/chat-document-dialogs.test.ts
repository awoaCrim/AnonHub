import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import * as roleCards from "@yesimbot/contracts/role-cards";
import * as icons from "reicon-vue";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import type { CardsSnapshot } from "../src/shared/character-cards";
import LimitedList from "../web/src/components/LimitedList.vue";
import WorkStepView from "../web/src/components/WorkStepView.vue";
import { api, ApiError } from "../web/src/lib/api";
import * as summaries from "../web/src/lib/document-summary";
import * as pluginConfig from "../web/src/lib/plugin-config";
import * as workSteps from "../web/src/lib/work-steps";
import { cardError, cardPictureUrl, createRoleEditor } from "../web/src/state/role-editor";
import { ui } from "./fixtures/ui";

const wrapper = (tag: string) =>
  vue.defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        vue.h(tag, slots.default?.()),
  });

// Keep the normal DOM separate from the dialog portal so a body rendered beside a
// file row fails these tests, even when it only appears after selecting that row.
const dialog = {
  Dialog: vue.defineComponent({
    props: { open: Boolean },
    setup:
      (props, { slots }) =>
      () =>
        props.open ? vue.h(vue.Teleport, { to: "body" }, slots.default?.()) : null,
  }),
  DialogContent: wrapper("dialog"),
  DialogTitle: wrapper("h2"),
  DialogHeader: wrapper("header"),
  DialogDescription: wrapper("p"),
};

function documentComponent<T>(name: string, imports: Record<string, unknown>, initialProps: Record<string, unknown> = {}, slots: vue.Slots = {}) {
  const props = vue.reactive<Record<string, unknown>>({ opened: false, persona: {}, ...initialProps });
  const emit = vi.fn();
  const unmount: Array<() => void> = [];
  const { descriptor } = parse(readFileSync(new URL(`../web/src/components/${name}.vue`, import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: name });
  const module = { exports: {} as { default: { setup: (props: unknown, context: unknown) => T } } };
  const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(transpile(script.content), {
    module,
    exports: module.exports,
    AbortController,
    setTimeout,
    clearTimeout,
    document: { activeElement: null },
    HTMLTextAreaElement: class {},
    require: (path: string) =>
      imports[path] ??
      {
        vue: { ...vue, onBeforeUnmount: (fn: () => void) => unmount.push(fn) },
        "reicon-vue": icons,
        "@yesimbot/contracts/platforms": { platformLabel: (platform: string) => platform, displayChannelId: (_platform: string, channel: string) => channel },
        "@yesimbot/contracts/role-cards": roleCards,
        "../lib/document-summary": summaries,
        "../lib/editor-guard": { trackEditor() {} },
        "../lib/format": { formatTime: () => "刚刚" },
        "../lib/toast": { toast() {} },
        "../lib/work-steps": workSteps,
        "./ui/dialog": dialog,
        "./LimitedList.vue": { default: LimitedList },
        "./ChatMarkdown.vue": {
          default: vue.defineComponent({ props: ["text"], setup: (props) => () => vue.h("p", props.text) }),
        },
        "./RoleEditor.vue": {
          default: vue.defineComponent({
            props: ["open", "value", "creating"],
            setup:
              (props, { slots }) =>
              () =>
                props.open
                  ? vue.h(vue.Teleport, { to: "body" }, [
                      vue.h("dialog", [
                        vue.h("h2", props.creating ? "新建角色卡" : props.value.name),
                        vue.h("textarea", props.value.identity),
                        slots.notice?.(),
                        slots.details?.(),
                      ]),
                    ])
                  : null,
          }),
        },
      }[path] ??
      ui(path) ??
      (path.endsWith(".vue") ? { default: wrapper("div") } : {}),
  });
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: `${name}.vue`,
    id: name,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  expect(template.errors).toEqual([]);
  const templateModule = { exports: {} as { render: (...args: unknown[]) => vue.VNode } };
  runInNewContext(transpile(template.code), { module: templateModule, exports: templateModule.exports, require: () => vue });
  const scope = vue.effectScope();
  const state = scope.run(() => module.exports.default.setup(props, { expose() {}, emit }))!;
  return {
    props,
    state,
    emit,
    async render() {
      const context: { teleports?: Record<string, string> } = {};
      const app = vue.createSSRApp({ render: () => templateModule.exports.render({ $slots: slots }, [], props, vue.proxyRefs(state as object)) });
      const list = await renderToString(app, context);
      return { list, dialog: context.teleports?.body ?? "" };
    },
    dispose() {
      unmount.splice(0).forEach((fn) => fn());
      scope.stop();
    },
  };
}

interface MemoryBindings {
  loaded: vue.Ref<boolean>;
  items: vue.Ref<{ id: string; content: string; visibility: string; revision: number }[]>;
  edit(item: MemoryBindings["items"]["value"][number]): Promise<void>;
}

it("keeps memory names in the file list and puts their full content only in the dialog", async () => {
  const content = "# 茶饮偏好\n\n喜欢红茶，不加糖。";
  const c = documentComponent<MemoryBindings>("MemoryPanel", {
    "../lib/api": { api: vi.fn(async () => ({ memories: [{ id: "tea", content, visibility: "owner", revision: 1 }] })), ApiError },
  });
  try {
    await vi.waitFor(() => expect(c.state.loaded.value).toBe(true));
    const closed = await c.render();
    expect(closed.list).toContain("茶饮偏好");
    expect(closed.list).toContain("主人私有");
    expect(closed.list).not.toContain("喜欢红茶");
    expect(closed.list).not.toContain("textarea");
    expect(closed.dialog).toBe("");
    await c.state.edit(c.state.items.value[0]!);
    expect(c.emit).toHaveBeenCalledWith("open");
    c.props.opened = true;
    const opened = await c.render();
    expect(opened.list).toContain("memory-file");
    expect(opened.list).toContain("茶饮偏好");
    expect(opened.list).not.toContain("喜欢红茶");
    expect(opened.list).not.toContain("textarea");
    expect(opened.dialog).toContain("记忆正文");
    expect(opened.dialog).toContain("喜欢红茶，不加糖。");
    expect(opened.dialog).not.toMatch(/<(details|summary)[\s>]/);
  } finally {
    c.dispose();
  }
});

interface RoleBindings {
  open(id: string): Promise<void>;
  create(): Promise<void>;
  close(): void;
  commit(): Promise<void>;
  createCard(): Promise<void>;
}

function roleComponent() {
  let snapshot: CardsSnapshot;
  // Saves keep what was sent, so the next read shows it.
  const request = vi.fn(async (path: string, body?: { fields?: typeof fields }) => {
    if (body?.fields && path.endsWith("/characters/save")) {
      snapshot.selected = { ...snapshot.selected!, fields: JSON.parse(JSON.stringify(body.fields)) };
      snapshot.cards[0]!.fields = snapshot.selected.fields;
    }
    return JSON.parse(JSON.stringify(snapshot));
  });
  const view = createRoleEditor(request as typeof api);
  const fields = { ...view.state.value, name: "爱音", identity: "角色正文仅应出现在弹窗中。" };
  snapshot = {
    revision: "r-dialog",
    active: "aino",
    cards: [{ id: "aino", name: fields.name, fields, pictures: {}, etag: "etag" }],
    selected: { id: "aino", fields, pictures: {}, etag: "etag" },
  };
  const toast = vi.fn();
  const plugins = vue.reactive({ data: { writable: true, tree: [{ name: "yesimbot-roleplay", path: "role-dialog", enabled: true }] } });
  const c = documentComponent<RoleBindings>("ChatRoleEditor", {
    "vue-router": { useRoute: () => ({ query: {} }) },
    "../state/role-editor": { createRoleEditor: () => view, cardError, cardPictureUrl },
    "../lib/plugin-config": pluginConfig,
    "../lib/dialog": { confirmDialog: vi.fn(async () => true) },
    "../lib/use-topic": { useTopic: () => plugins },
    "../lib/toast": { toast },
  });
  return { ...c, view, request, toast, plugins };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("keeps role names in the list while opening and creating cards in a dialog", async () => {
  const c = roleComponent();
  try {
    await vi.waitFor(() => expect(c.view.state.snapshot).toBeDefined());
    expect((await c.render()).list).not.toContain("角色正文");
    await c.state.open("aino");
    expect(c.emit).toHaveBeenCalledWith("open");
    c.props.opened = true;
    const opened = await c.render();
    expect(opened.list).toContain("role-file");
    expect(opened.list).toContain("爱音");
    expect(opened.list).not.toContain("角色正文");
    expect(opened.dialog).toContain("角色正文仅应出现在弹窗中。");
    expect(opened.dialog).not.toMatch(/<(details|summary)[\s>]/);
    await c.state.create();
    expect(c.view.state.creating).toBe(true);
    expect((await c.render()).dialog).toContain("新建角色卡");
  } finally {
    c.dispose();
    c.view.dispose();
  }
});

it("saves a typed role edit on close without asking", async () => {
  const c = roleComponent();
  try {
    await vi.waitFor(() => expect(c.view.state.snapshot).toBeDefined());
    await c.state.open("aino");
    c.view.edit({ ...c.view.state.value, identity: "关闭时保存的正文" });
    c.state.close();
    expect(c.emit).toHaveBeenCalledWith("close");
    await vi.waitFor(() => expect(c.view.state.saved.identity).toBe("关闭时保存的正文"));
    expect(c.view.dirty.value).toBe(false);
  } finally {
    c.dispose();
    c.view.dispose();
  }
});

it("drops a new card that was never created, and writes it only on 创建", async () => {
  const c = roleComponent();
  try {
    await vi.waitFor(() => expect(c.view.state.snapshot).toBeDefined());
    await c.state.create();
    c.view.edit({ ...c.view.state.value, name: "新角色" });
    await c.state.commit();
    c.state.close();
    expect(c.request.mock.calls.some(([path]) => String(path).endsWith("/characters/create"))).toBe(false);
    await vi.waitFor(() => expect(c.view.state.creating).toBe(false));
    await c.state.create();
    c.view.edit({ ...c.view.state.value, name: "新角色" });
    await c.state.createCard();
    expect(c.request.mock.calls.some(([path]) => String(path).endsWith("/characters/create"))).toBe(true);
    expect(c.toast).toHaveBeenCalledWith("角色卡已创建。");
  } finally {
    c.dispose();
    c.view.dispose();
  }
});

it("saves a role edit at once with 撤销, and keeps typing made while it saves", async () => {
  const c = roleComponent();
  try {
    await vi.waitFor(() => expect(c.view.state.snapshot).toBeDefined());
    await c.state.open("aino");
    c.view.edit({ ...c.view.state.value, identity: "改写后的正文" });
    const saving = c.state.commit();
    c.view.edit({ ...c.view.state.value, history: "保存时又写的经历" });
    await saving;
    expect(c.view.state.saved.identity).toBe("改写后的正文");
    expect(c.view.state.value.history).toBe("保存时又写的经历");
    const [text, , , action] = c.toast.mock.calls.find(([message]) => message === "已保存")!;
    expect([text, action.label]).toEqual(["已保存", "撤销"]);
    await c.state.commit();
    action.run();
    await vi.waitFor(() => expect(c.view.state.saved.identity).toBe("角色正文仅应出现在弹窗中。"));
    expect(c.toast).toHaveBeenCalledWith("已撤销", "ok", undefined, undefined);
    expect(c.emit).not.toHaveBeenCalledWith("close");
  } finally {
    c.dispose();
    c.view.dispose();
  }
});

it("shows the whole card in one dialog: names, pictures, 角色设定 box by box, 示例对话 and 回复前提醒", async () => {
  const fields = JSON.parse(JSON.stringify(createRoleEditor().state.value));
  const c = documentComponent<{ save(): void; updateOpen(open: boolean): void }>(
    "RoleEditor",
    {},
    {
      open: true,
      value: { ...fields, name: "爱音", identity: "身份正文", relationships: "关系正文", examples: "示例正文", reminder: "提醒正文" },
      busy: false,
      disabled: false,
      creating: false,
      pictures: { reference: "/picture?key=reference" },
    },
    { details: () => [vue.h("section", "角色库与全平台默认设置")] },
  );
  try {
    const { dialog } = await c.render();
    expect(dialog.match(/<dialog[\s>]/g)).toHaveLength(1);
    const order = [
      "名字",
      "自称",
      "参考图",
      "三视图",
      "角色设定",
      "身份",
      "外貌",
      "性格",
      "说话方式",
      "经历",
      "关系",
      "规矩",
      "示例对话",
      "回复前提醒",
      "角色库与全平台默认设置",
    ];
    const positions = order.map((text) => dialog.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const text of ["身份正文", "关系正文", "示例正文", "提醒正文", "/picture?key=reference", "更换参考图", "上传三视图"]) expect(dialog).toContain(text);
    for (const text of ["高级设置", "开场白", "作者", "扩展数据", "导入", "导出", "场景", "性格摘要"]) expect(dialog).not.toContain(text);
    c.state.save();
    expect(c.emit).toHaveBeenCalledWith("commit");
    c.state.updateOpen(false);
    expect(c.emit).toHaveBeenCalledWith("close");
  } finally {
    c.dispose();
  }
});

interface BackgroundTask {
  id: string;
  instruction: string;
  channel: string;
  session: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown";
  updatedAt: number;
  /** Only in records from before reminders were dropped. */
  dismissedAt?: number;
  result?: string;
  notification?: "pending" | "claimed" | "delivered" | "unknown" | "obsolete";
  handoff?: { id: string; state: "pending"; instruction: string; deviceId?: string };
}

interface TaskBindings {
  drafts: Record<string, string>;
  selected: vue.ComputedRef<BackgroundTask | undefined>;
  groups: vue.ComputedRef<Array<{ label: string; items: BackgroundTask[] }>>;
  busy: vue.Ref<string>;
  taskList: vue.Ref<HTMLElement | undefined>;
  openTask(task: BackgroundTask, event?: MouseEvent): void;
  updateOpen(open: boolean): void;
  restoreFocus(event: Event): void;
  act(task: BackgroundTask, action: "cancel" | "update" | "resolve-handoff"): Promise<void>;
}

/** The open task's steps (user, 2026-11-20: 「至少我得知道，执行了哪些命令，正在执行什么命令吧？」), none in these tests. */
const STEPS_PATH = "/yesimbot/api/v1/tasks/steps";
const NO_STEPS = { steps: [], total: 0 };

function backgroundTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "unknown-task",
    instruction: "创建心跳任务\n检查相关计划后再决定下一步。",
    channel: "web:owner",
    session: "today",
    status: "unknown",
    updatedAt: 1,
    result: "创建请求已提交，但没有收到最终回执。",
    ...overrides,
  };
}

function taskPanel(tasks: BackgroundTask[]) {
  const topic = vue.reactive({ data: { items: tasks }, failed: false, unavailable: false });
  const request = vi.fn(async (path: string, _body?: unknown): Promise<unknown> => (path.startsWith(STEPS_PATH) ? NO_STEPS : { items: tasks }));
  const c = documentComponent<TaskBindings>(
    "TaskPanel",
    {
      "../lib/api": { api: request, ApiError },
      "../lib/dialog": { confirmDiscard: vi.fn(async () => true) },
      "../lib/use-topic": { useTopic: () => topic },
    },
    { conversation: { channel: "web:owner", session: "today" } },
  );
  return { ...c, request, topic };
}

// User, 2026-11-20: 「我点开这个后台任务不就是为了看进度吗？至少我得知道，执行了哪些命令，正在执行什么命令吧？」
// User, 2026-11-26: 「查看后台活动时，做成左tab的形式，右边顶部需要标注本次工具的摘要」.
it("opens a running task on its newest call, lists every call as a tab in order, and reads again from the one still running", async () => {
  const task = backgroundTask({ status: "running", result: undefined });
  const topic = vue.reactive({ data: { items: [task] }, failed: false, unavailable: false });
  const exec = (id: string, command: string, status: string, stdout?: string) => ({
    id,
    tool: "computer_exec",
    input: { command },
    status,
    ...(stdout === undefined ? {} : { output: { status: "succeeded", output: { exitCode: 0, stdout } } }),
  });
  const answers = [
    { total: 2, steps: [exec("a", "uname -a", "ok", "Linux denver"), exec("b", "curl -O https://example.com/k.tgz", "running")] },
    { total: 3, steps: [exec("b", "curl -O https://example.com/k.tgz", "ok", "saved"), exec("c", "tar xzf k.tgz", "ok", "")] },
  ];
  const request = vi.fn(async (path: string) => (path.startsWith(STEPS_PATH) ? answers.shift() : { items: [task] }));
  const c = documentComponent<TaskBindings & { tab: vue.Ref<string>; pick(id: string): void }>(
    "TaskPanel",
    {
      "../lib/api": { api: request, ApiError },
      "../lib/use-topic": { useTopic: () => topic },
      "./WorkStepView.vue": { default: WorkStepView },
    },
    { conversation: { channel: "web:owner", session: "today" } },
  );
  const pane = async () => {
    const dialog = (await c.render()).dialog;
    return dialog.slice(dialog.indexOf('id="task-pane"'));
  };
  try {
    c.state.openTask(task);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(`${STEPS_PATH}?id=${task.id}&from=0`, undefined, expect.objectContaining({ fresh: true })));
    await vi.waitFor(() => expect(c.state.tab.value).toBe("b"));
    const running = (await c.render()).dialog;
    expect(running).toContain("已执行 2 步");
    // The tabs: 概览, then each call in the order it was made, each with its one-line summary.
    expect(running.indexOf("概览")).toBeLessThan(running.indexOf("uname -a"));
    expect(running.indexOf("uname -a")).toBeLessThan(running.indexOf("curl -O"));
    // The open tab heads with what this call does.
    expect(await pane()).toMatch(/第 2 步[\s\S]*正在执行[\s\S]*curl -O https:\/\/example.com\/k.tgz/);
    expect(await pane()).not.toContain("任务内容");
    // It ended: only the tail from the step that was running is read again, and the open tab stays where it was.
    topic.data = { items: [{ ...task, status: "succeeded", result: "下载好了" }] };
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(`${STEPS_PATH}?id=${task.id}&from=1`, undefined, expect.objectContaining({ fresh: true })));
    await vi.waitFor(async () => expect((await c.render()).dialog).toContain("tar xzf k.tgz"));
    expect((await c.render()).dialog).toContain("已执行 3 步");
    expect(c.state.tab.value).toBe("b");
    expect(await pane()).toContain("saved");
    c.state.pick("");
    expect(await pane()).toContain("下载好了");
    expect(await pane()).toContain("任务内容");
  } finally {
    c.dispose();
  }
});
// User, 2026-11-20: 「任何任务都不在需要我核实，让主bot核实就行了」.
it("lists an interrupted task with the finished ones and leaves checking it to the bot", async () => {
  const task = backgroundTask({ handoff: { id: "stale-handoff", state: "pending", instruction: "过期的人工操作" }, notification: "delivered" });
  const waiting = backgroundTask({ id: "waiting", status: "waiting", instruction: "补充目标文件名" });
  // Records from before keep the time their reminder was closed; it no longer means anything.
  const closedEarlier = backgroundTask({ id: "closed-earlier", updatedAt: 0.5, dismissedAt: 2 });
  const succeeded = backgroundTask({ id: "succeeded", status: "succeeded", notification: "unknown", updatedAt: 0 });
  const c = taskPanel([task, waiting, closedEarlier, succeeded, backgroundTask({ id: "other-session", session: "yesterday" })]);
  try {
    expect(c.state.groups.value.map(({ label, items }) => [label, items.map(({ id }) => id)])).toEqual([
      ["需要你处理", [waiting.id]],
      ["正在进行", []],
      ["已结束", [task.id, closedEarlier.id, succeeded.id]],
    ]);
    const list = (await c.render()).list;
    expect(list).toContain(">已结束</h4>");
    expect(list.match(/已中断/g)).toHaveLength(2);
    expect(list).not.toMatch(/结果待核实|已关闭提醒|text-destructive/);
    c.state.openTask(task);
    const opened = await c.render();
    expect(opened.dialog).toContain("任务停止时还有操作的结果没确认，没有自动重试。结果交给对话里的 bot 核实，不需要你处理。");
    expect(opened.dialog).toContain(task.result);
    expect(opened.dialog).not.toMatch(/不再提醒|过期的人工操作|已处理，继续任务|等待你处理|取消任务|提交补充|textarea|<(details|summary)[\s>]/);
    for (const [notification, note] of [
      ["obsolete", "原来的对话已经结束，结果没有交给 bot。"],
      ["unknown", "结果未确认送达对话"],
    ] as const) {
      c.topic.data = { items: [{ ...task, notification }, waiting, closedEarlier, succeeded] };
      await vue.nextTick();
      const dialog = (await c.render()).dialog;
      expect(dialog).toContain(note);
      expect(dialog).not.toContain("不需要你处理");
    }
    c.state.openTask(succeeded);
    expect((await c.render()).dialog).toContain("结果未确认送达对话");
    expect((await c.render()).dialog).not.toContain("任务停止时");
  } finally {
    c.dispose();
  }
});

it("applies an action's receipt at once, ignores a second click meanwhile, and distinguishes a later refresh failure", async () => {
  const task = backgroundTask({ status: "running", result: undefined });
  const receipt = { ...task, status: "cancelled" as const, result: "任务已取消；已完成的外部操作不会自动撤销。", updatedAt: 20 };
  const saving = deferred<BackgroundTask>();
  const reading = deferred<{ items: BackgroundTask[] }>();
  const c = taskPanel([task]);
  const trigger = { isConnected: true, focus: vi.fn() };
  const fallback = { focus: vi.fn() };
  try {
    // Opening the task also reads its steps; the action and the refresh after it are answered in turn.
    const answers = [() => saving.promise, () => reading.promise];
    c.request.mockImplementation(async (path: string) => (path.startsWith(STEPS_PATH) ? NO_STEPS : answers.shift()!()));
    c.state.openTask(task, { currentTarget: trigger } as unknown as MouseEvent);
    const pending = c.state.act(task, "cancel");
    await c.state.act(task, "cancel");
    expect(c.request.mock.calls.filter(([path]) => !path.startsWith(STEPS_PATH))).toHaveLength(1);
    expect(c.request).toHaveBeenCalledWith("/yesimbot/api/v1/tasks/update", { id: task.id, action: "cancel" });
    const busyButtons = (await c.render()).dialog.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(busyButtons.find((button) => button.includes("取消任务"))).toMatch(/\sdisabled(?:=|\s|>)/);
    await c.state.updateOpen(false);
    expect(c.state.selected.value?.id).toBe(task.id);
    saving.resolve(receipt);
    await vi.waitFor(() => expect(c.state.selected.value?.status).toBe("cancelled"));
    expect(c.state.groups.value.find(({ label }) => label === "已结束")?.items).toEqual([receipt]);
    reading.reject(new Error("offline"));
    await pending;
    const saved = await c.render();
    expect(saved.dialog).toContain("操作已保存，暂时无法刷新任务列表");
    expect(saved.dialog).not.toContain("未能确认操作结果");
    expect(c.state.busy.value).toBe("");
    trigger.isConnected = false;
    const querySelector = vi.fn(() => fallback);
    c.state.taskList.value = { querySelector } as unknown as HTMLElement;
    await c.state.updateOpen(false);
    const preventDefault = vi.fn();
    c.state.restoreFocus({ preventDefault } as unknown as Event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(querySelector).toHaveBeenCalledWith("button:not(:disabled)");
    expect(fallback.focus).toHaveBeenCalledOnce();
    expect(trigger.focus).not.toHaveBeenCalled();
  } finally {
    c.dispose();
  }
});

it("keeps an open task while new chat snapshots hand over the same conversation", async () => {
  const task = backgroundTask();
  const c = taskPanel([task]);
  try {
    c.state.openTask(task);
    c.props.conversation = { channel: "web:owner", session: "today" };
    await vue.nextTick();
    expect(c.state.selected.value?.id).toBe(task.id);
    c.props.conversation = { channel: "web:owner", session: "tomorrow" };
    await vue.nextTick();
    c.props.conversation = { channel: "web:owner", session: "today" };
    await vue.nextTick();
    expect(c.state.selected.value).toBeUndefined();
  } finally {
    c.dispose();
  }
});

it("clears a previous task error when opening another detail dialog", async () => {
  const task = backgroundTask({ status: "running" });
  const another = backgroundTask({ id: "another-task", instruction: "另一个任务" });
  const c = taskPanel([task, another]);
  try {
    c.state.openTask(task);
    c.request.mockRejectedValueOnce(new ApiError(0, "write_unknown"));
    await c.state.act(task, "cancel");
    expect((await c.render()).dialog).toContain("未能确认操作结果");
    c.state.openTask(another);
    expect((await c.render()).dialog).not.toContain("未能确认操作结果");
  } finally {
    c.dispose();
  }
});

it("preserves supplement and cancellation actions for waiting tasks", async () => {
  const task = backgroundTask({ status: "waiting" });
  const queued = { ...task, status: "queued" as const, instruction: `${task.instruction}\n用户补充：目标文件是 plan.md` };
  const cancelled = { ...queued, status: "cancelled" as const, result: "任务已取消" };
  const c = taskPanel([task]);
  try {
    c.state.openTask(task);
    expect((await c.render()).dialog).toContain("提交补充");
    c.state.drafts[task.id] = "目标文件是 plan.md";
    c.request.mockResolvedValueOnce(queued).mockResolvedValueOnce({ items: [queued] });
    await c.state.act(task, "update");
    expect(c.request).toHaveBeenCalledWith("/yesimbot/api/v1/tasks/update", { id: task.id, action: "update", instruction: "目标文件是 plan.md" });
    expect(c.state.drafts[task.id]).toBe("");
    expect(c.state.selected.value?.status).toBe("queued");
    c.request.mockResolvedValueOnce(cancelled).mockResolvedValueOnce({ items: [cancelled] });
    await c.state.act(queued, "cancel");
    expect(c.request).toHaveBeenCalledWith("/yesimbot/api/v1/tasks/update", { id: task.id, action: "cancel" });
    expect(c.state.selected.value?.status).toBe("cancelled");
    expect((await c.render()).dialog).not.toContain("提交补充");
  } finally {
    c.dispose();
  }
});

it("shows task content, handoff, and results only in its detail dialog and preserves all task actions", async () => {
  const task = {
    id: "task-1",
    instruction: "整理资料\n完整任务正文",
    status: "waiting",
    channel: "web:owner",
    session: "today",
    updatedAt: 1,
    result: "完整执行结果",
    handoff: { id: "handoff-1", state: "pending", instruction: "需要人工填写验证码", deviceId: "computer" },
  };
  const request = vi.fn(async (path: string, body?: unknown) => (path.startsWith(STEPS_PATH) ? NO_STEPS : body ? task : { items: [task] }));
  const discard = vi.fn(async () => false);
  const c = documentComponent<{
    drafts: Record<string, string>;
    selected: vue.ComputedRef<unknown>;
    openTask(task: unknown): void;
    updateOpen(open: boolean): void;
    act(task: unknown, action: string): Promise<void>;
  }>(
    "TaskPanel",
    {
      "../lib/api": { api: request, ApiError },
      "../lib/dialog": { confirmDiscard: discard },
      "../lib/use-topic": { useTopic: () => ({ data: { items: [task] } }) },
    },
    { conversation: { channel: "web:owner", session: "today" } },
  );
  try {
    const closed = await c.render();
    expect(closed.list).toContain("整理资料");
    expect(closed.list).not.toMatch(/完整任务正文|完整执行结果|验证码|<(details|summary)[\s>]/);
    c.state.openTask(task);
    const opened = await c.render();
    expect(opened.list).not.toContain("完整任务正文");
    expect(opened.dialog).toContain("完整任务正文");
    expect(opened.dialog).toContain("完整执行结果");
    expect(opened.dialog).toContain("验证码");
    expect(opened.dialog).toContain("已处理，继续任务");
    expect(opened.dialog).toContain("取消任务");
    // Closing never asks: an unsent supplement goes with the dialog.
    c.state.drafts[task.id] = "草稿不会保留";
    c.state.updateOpen(false);
    expect(discard).not.toHaveBeenCalled();
    expect(c.state.selected.value).toBeUndefined();
    expect(c.state.drafts[task.id]).toBe("");
    c.state.openTask(task);
    c.state.drafts[task.id] = "补充任务说明";
    await c.state.act(task, "resolve-handoff");
    expect(request).toHaveBeenCalledWith("/yesimbot/api/v1/tasks/update", {
      id: task.id,
      action: "resolve-handoff",
      instruction: "补充任务说明",
      handoffId: "handoff-1",
    });
    expect(c.state.drafts[task.id]).toBe("");
    await c.state.updateOpen(false);
    expect(c.state.selected.value).toBeUndefined();
  } finally {
    c.dispose();
  }
});

it("opens scheduled task content and operations in a detail dialog without an inline expansion", async () => {
  const task = {
    id: "schedule-1",
    title: "每日阅读",
    prompt: "阅读计划的完整正文",
    notes: "计划的做法记录",
    state: "enabled",
    kind: "cron",
    cron: "0 9 * * *",
    platform: "web",
    selfId: "bot",
    channelId: "owner",
    type: "direct",
    delivery: "channel",
  };
  const c = documentComponent<{ loading: vue.Ref<boolean>; openTask(task: unknown): void }>(
    "ScheduledTasks",
    { "../lib/api": { api: vi.fn(async () => ({ available: true, tasks: [task] })), ApiError } },
    { enabled: true, scope: { platform: "web", selfId: "bot", channelId: "owner", type: "direct" } },
  );
  try {
    await vi.waitFor(() => expect(c.state.loading.value).toBe(false));
    const closed = await c.render();
    expect(closed.list).toContain("每日阅读");
    expect(closed.list).not.toMatch(/完整正文|做法记录|<(details|summary)[\s>]/);
    c.state.openTask(task);
    const opened = await c.render();
    expect(opened.list).not.toContain("完整正文");
    expect(opened.dialog).toContain("阅读计划的完整正文");
    expect(opened.dialog).toContain("计划的做法记录");
    expect(opened.dialog).toContain("修改计划");
    expect(opened.dialog).toContain("删除");
    expect(opened.dialog).not.toMatch(/<(details|summary)[\s>]/);
  } finally {
    c.dispose();
  }
});

it("renders record sections only in one independent detail dialog", async () => {
  const c = documentComponent(
    "ConversationRecordDialog",
    {},
    {
      record: {
        label: "工具调用 · read_file",
        timestamp: 1,
        sections: [
          { title: "调用参数", text: "完整参数" },
          { title: "执行结果", text: "完整结果" },
        ],
      },
    },
  );
  try {
    const opened = await c.render();
    expect(opened.list).not.toMatch(/完整参数|完整结果/);
    expect(opened.dialog.match(/<dialog[\s>]/g)).toHaveLength(1);
    expect(opened.dialog).toContain("记录详情");
    expect(opened.dialog).toContain("完整参数");
    expect(opened.dialog).toContain("完整结果");
    expect(opened.dialog).not.toMatch(/<(details|summary)[\s>]/);
    c.props.record = undefined;
    expect((await c.render()).dialog).toBe("");
  } finally {
    c.dispose();
  }
});

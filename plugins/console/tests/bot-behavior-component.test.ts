import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import { ApiError, type api } from "../web/src/lib/api";
import * as pluginConfig from "../web/src/lib/plugin-config";
import * as autosave from "../web/src/state/autosave";
import * as fields from "../web/src/state/config-fields";
import { createContextPolicyEditor } from "../web/src/state/context-policy";
import { ui } from "./fixtures/ui";
import { createDraft } from "./legacy-draft-fixture";

interface Row {
  path: string[];
  label: string;
}
interface Bindings {
  busy: vue.ComputedRef<boolean>;
  visibleSections: vue.ComputedRef<{ title: string; requires?: string; rows: Row[] }[]>;
  policy: ReturnType<typeof createContextPolicyEditor>;
  editor: ReturnType<typeof fields.createConfigFieldsEditor>;
  value(path: readonly string[]): unknown;
  setFlag(row: Row, enabled: boolean): void;
  setNumber(row: Row, event: Event): void;
  retryPolicy(): Promise<boolean | void> | undefined;
}

const wrapper = (tag: string) =>
  vue.defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        vue.h(tag, slots.default?.()),
  });
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
};

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function harness(
  role: "owner" | "member" = "owner",
  part: "speaking" | "memory" | "input" = "speaking",
  options: { writable?: boolean; locked?: boolean } = {},
) {
  const unmount: (() => void)[] = [];
  const plugins = vue.reactive({ writable: options.writable ?? true, tree: [{ name: "yesimbot", path: "yesimbot:core", locked: options.locked }] });
  const config = { imageInput: true, session: { archive: { maxKB: 1024 } }, untouched: "keep" };
  const policy = { magicContext: {}, archive: { maxKB: 5120 } };
  const request = vi.fn(async (path: string, body?: { session?: typeof policy; config?: typeof config }) => {
    if (path === "/yesimbot/admin/context-policy") return { revision: "policy", policy: { session: body?.session ?? policy } };
    if (path.includes("/schema?"))
      return {
        schema: {
          type: "object",
          dict: {
            imageInput: { type: "boolean" },
            videoInput: { type: "boolean" },
            pacing: { type: "object", dict: { charactersPerSecond: { type: "number" }, maxTotalDelayMs: { type: "number" } } },
            customInnerThought: { type: "boolean" },
            modelRetries: { type: "number" },
            resourceReadTimeout: { type: "number" },
          },
        },
      };
    return { revision: "child", config };
  });
  const storage = new Map<string, string>();
  const confirm = vi.fn(async () => true),
    toast = vi.fn();
  const { descriptor } = parse(readFileSync(new URL("../web/src/pages/BotBehavior.vue", import.meta.url), "utf8"));
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => Bindings } } };
  const script = compileScript(descriptor, { id: "behavior" });
  const transpile = (source: string) =>
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
  runInNewContext(transpile(script.content), {
    module,
    exports: module.exports,
    require: (name: string) =>
      ({
        vue: { ...vue, onUnmounted: (fn: () => void) => unmount.push(fn) },
        "../context": {
          useSession: () => ({ state: { role, username: role, features: { accounts: role === "owner" } } }),
          useLive: () => ({
            use: () => ({
              state: { data: plugins },
              release() {},
            }),
          }),
        },
        "../lib/api": { api: request },
        "../lib/dialog": { confirmDiscard: confirm },
        "../lib/editor-guard": { trackEditor() {} },
        "../lib/drafts": {
          createDraft: (key: string, version: number) =>
            createDraft(key, version, {
              getItem: (key) => storage.get(key) ?? null,
              setItem: (key, value) => void storage.set(key, value),
              removeItem: (key) => void storage.delete(key),
            }),
        },
        "../lib/plugin-config": pluginConfig,
        "../lib/toast": {
          toast,
          toastNotices() {},
          toastErrors(source: vue.WatchSource<string>, clear: () => void, inPage: () => boolean) {
            vue.watch(source, (error) => error && !inPage() && clear());
          },
        },
        "../shell/TopicFeedback.vue": { default: vue.defineComponent({ setup: () => () => null }) },
        "../components/ui/dialog": dialog,
        "../state/config-fields": {
          ...fields,
          createConfigFieldsEditor: (keys: readonly string[], options: Parameters<typeof fields.createConfigFieldsEditor>[1]) =>
            fields.createConfigFieldsEditor(keys, { ...options, request: request as typeof api }),
        },
        "../state/autosave": autosave,
        "../state/context-policy": { createContextPolicyEditor: () => createContextPolicyEditor(request as never) },
      })[name] ?? ui(name),
  });
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: "BotBehavior.vue",
    id: "behavior",
    compilerOptions: { bindingMetadata: script.bindings },
  });
  expect(template.errors).toEqual([]);
  const renderModule = { exports: {} as { render: (...args: unknown[]) => vue.VNode } };
  runInNewContext(transpile(template.code), { module: renderModule, exports: renderModule.exports, require: () => vue });
  const props = vue.reactive({ part });
  const scope = vue.effectScope();
  const state = scope.run(() => module.exports.default.setup(props, { expose() {} }))!;
  const dispose = () => {
    unmount.forEach((fn) => fn());
    scope.stop();
  };
  cleanups.push(dispose);
  await vi.waitFor(() => expect(state.busy.value).toBe(false));
  const row = (path: string) => state.visibleSections.value.flatMap((section) => section.rows).find((item) => item.path.join(".") === path)!;
  const writes = () => request.mock.calls.filter((call) => call[1]);
  return {
    row,
    writes,
    state,
    request,
    config,
    plugins,
    confirm,
    toast,
    dispose,
    async render() {
      const context: { teleports?: Record<string, string> } = {};
      const app = vue.createSSRApp({ render: () => renderModule.exports.render({}, [], props, vue.proxyRefs(state as object)) });
      app.component("RouterLink", wrapper("a"));
      const list = await renderToString(app, context);
      return { list, dialog: context.teleports?.body ?? "" };
    },
  };
}

it("saves a change at once and offers 撤销, which restores what it replaced", async () => {
  const h = await harness("owner", "speaking");
  h.state.setFlag(h.row("customInnerThought"), true);
  await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
  await vi.waitFor(() => expect(h.state.busy.value).toBe(false));
  expect(h.writes()[0][0]).toBe("/yesimbot/api/v1/plugins/update");
  expect(h.writes()[0][1]!.config).toEqual({ ...h.config, customInnerThought: true });
  expect(h.state.editor.dirty.value).toBe(false);
  const [text, tone, , action] = h.toast.mock.calls.at(-1)!;
  expect([text, tone, action.label]).toEqual(["已保存：记录内部判断", "ok", "撤销"]);
  action.run();
  await vi.waitFor(() => expect(h.writes()).toHaveLength(2));
  await vi.waitFor(() => expect(h.state.busy.value).toBe(false));
  expect(h.writes()[1][1]!.config).toEqual(h.config);
  // Undoing offers no second undo.
  expect(h.toast.mock.calls.at(-1)).toEqual(["已撤销：记录内部判断", "ok", undefined, undefined]);
});

it("saves the owner's long-conversation settings to the shared policy, never to the bot", async () => {
  const h = await harness("owner", "memory");
  expect(h.state.visibleSections.value.filter((s) => s.requires === "session")).toHaveLength(1);
  h.state.setNumber(h.row("session.magicContext.triggerTokens"), { target: { value: "50000", checkValidity: () => true } } as never);
  await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
  expect(h.writes()[0][0]).toBe("/yesimbot/admin/context-policy");
  expect(h.writes()[0][1]!.session!.magicContext).toEqual({ triggerTokens: 50000 });
  expect(h.writes()[0][1]!.session!.archive.maxKB).toBe(5120);
});

it("does not load administrator settings or expose long-conversation controls to a member", async () => {
  const h = await harness("member", "memory");
  expect(h.request.mock.calls.some((call) => call[0].includes("/admin/"))).toBe(false);
  expect(h.state.visibleSections.value).toEqual([]);
});

it("shows each part where it belongs: 对话 says and remembers, 模型 takes input and network", async () => {
  const titles = (h: Awaited<ReturnType<typeof harness>>) => h.state.visibleSections.value.map((section) => section.title);
  const speaking = await harness("owner", "speaking");
  expect(titles(speaking)).toEqual(["节奏"]);
  // How it talks never touches the shared long-conversation policy.
  expect(speaking.request.mock.calls.some(([path]) => path === "/yesimbot/admin/context-policy")).toBe(false);
  speaking.dispose();
  const memory = await harness("owner", "memory");
  expect(titles(memory)).toEqual(["长对话"]);
  // Session files still split in the background, but the size is no longer a setting on the page; the stored value is kept.
  const rows = memory.state.visibleSections.value[0].rows.map((row) => row.path.join("."));
  expect(rows).not.toContain("session.archive.maxKB");
  expect(memory.state.value(["session", "archive", "maxKB"])).toBe(5120);
  memory.dispose();
  const input = await harness("owner", "input");
  expect(titles(input)).toEqual(["看图和视频", "网络"]);
  expect(input.state.visibleSections.value.some((section) => section.rows.some((row) => row.path[0] === "replyReview"))).toBe(false);
});

it("shows its controls in place: no dialog, no save bar, no guidance text", async () => {
  const h = await harness("owner", "input");
  const view = await h.render();
  for (const label of ["直接看图片", "读取视频", "出错重试", "下载超时"]) expect(view.list).toContain(label);
  expect(view.list).not.toMatch(/<(dialog|small|footer|details)[\s>]/);
  expect(view.dialog).toBe("");
});

it("rereads the saved copy when a save fails, so the form never shows a value that was not kept", async () => {
  const h = await harness("owner", "input");
  h.request.mockRejectedValueOnce(new ApiError(400, "invalid_config"));
  h.state.setFlag(h.row("imageInput"), false);
  await vi.waitFor(() => expect(h.state.busy.value).toBe(false));
  await vi.waitFor(() => expect(h.state.value(["imageInput"])).toBe(true));
  expect(h.state.editor.dirty.value).toBe(false);
  expect(h.toast.mock.calls.some(([text]) => String(text).startsWith("已保存"))).toBe(false);
});

it.each([{ writable: false }, { locked: true }])("does not mutate or save read-only behavior settings: %j", async (options) => {
  const h = await harness("owner", "input", options);
  h.state.setFlag(h.row("imageInput"), false);
  await vue.nextTick();
  expect(h.state.value(["imageInput"])).toBe(true);
  expect(h.writes()).toHaveLength(0);
});

it("uses the renamed core path after an external enable or disable without rereading", async () => {
  const h = await harness("owner", "input");
  h.request.mockClear();
  h.plugins.tree[0].path = "~yesimbot:core";
  await vue.nextTick();
  expect(h.request).not.toHaveBeenCalled();
  expect(h.state.editor.state.path).toBe("~yesimbot:core");
  h.state.setFlag(h.row("imageInput"), false);
  await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
  expect(h.writes()[0][1]).toMatchObject({ path: "~yesimbot:core" });
});

it("shows a change made while saving at once and sends everything made meanwhile in one save", async () => {
  const h = await harness("owner", "input");
  const original = h.request.getMockImplementation()!;
  let release!: () => void;
  h.request.mockImplementationOnce(
    (path, body) =>
      new Promise((resolve) => {
        release = () => resolve(original(path, body));
      }),
  );
  h.state.setFlag(h.row("imageInput"), false);
  await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
  // Not blocked: the card keeps taking changes and shows them before they are saved.
  h.state.setFlag(h.row("videoInput"), true);
  h.state.setFlag(h.row("imageInput"), true);
  expect(h.state.busy.value).toBe(false);
  expect(h.state.value(["videoInput"])).toBe(true);
  expect(h.state.value(["imageInput"])).toBe(true);
  release();
  await vi.waitFor(() => expect(h.writes()).toHaveLength(2));
  await vi.waitFor(() => expect(h.toast).toHaveBeenCalledTimes(2));
  expect(h.writes()[1][1]!.config).toMatchObject({ imageInput: true, videoInput: true });
  expect(h.toast.mock.calls.map((call) => call[0])).toEqual(["已保存：直接看图片", "已保存：读取视频、直接看图片"]);
});

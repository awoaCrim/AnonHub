import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import { ApiError } from "../web/src/lib/api";
import * as extensionsLib from "../web/src/lib/extensions";
import { ui } from "./fixtures/ui";

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);

function component(file: string, imports: Record<string, unknown> = {}, inlineTemplate = false) {
  const { descriptor } = parse(readFileSync(new URL(`../web/src/${file}`, import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: file, inlineTemplate });
  // A compiled component's setup and the bindings it returns, which these tests read loosely.
  // oxlint-disable-next-line typescript/no-explicit-any
  const module = { exports: {} as { default: vue.Component & { setup: (...args: any[]) => any } } };
  runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    document: { visibilityState: "visible" },
    require: (name: string) => imports[name] ?? (name === "vue" ? vue : ui(name)) ?? { default: {} },
  });
  return module.exports.default;
}

function state(file: string, props: Record<string, unknown> = {}, imports: Record<string, unknown> = {}, emit = vi.fn()) {
  const dispose: Array<() => void> = [];
  const lifecycle = { ...vue, onMounted() {}, onUnmounted: (fn: () => void) => dispose.push(fn), onBeforeUnmount: (fn: () => void) => dispose.push(fn) };
  const view = component(file, { vue: lifecycle, ...imports });
  const scope = vue.effectScope();
  const bindings = scope.run(() => view.setup(props, { emit, expose() {} }));
  const off = () => {
    dispose.splice(0).forEach((fn) => fn());
    scope.stop();
  };
  cleanups.push(off);
  return { bindings, emit, dispose: off };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// oxlint-disable-next-line typescript/no-explicit-any
type HostNode = { type: string; text: string; props: Record<string, any>; children: HostNode[]; parent: HostNode | null };
const hostNode = (type: string, text = ""): HostNode => ({ type, text, props: {}, children: [], parent: null });
function renderer() {
  return vue.createRenderer<HostNode, HostNode>({
    createElement: (type) => hostNode(type),
    createText: (text) => hostNode("text", text),
    createComment: (text) => hostNode("comment", text),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
      node.parent = parent;
    },
    remove(node) {
      node.parent?.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = null;
    },
    setElementText(node, text) {
      node.text = text;
      node.children = [];
    },
    setText(node, text) {
      node.text = text;
    },
    patchProp(node, key, _previous, next) {
      node.props[key] = next;
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  });
}
function nodes(root: HostNode, type: string): HostNode[] {
  return [...(root.type === type ? [root] : []), ...root.children.flatMap((child) => nodes(child, type))];
}
// Native template elements keep their contents inert, unlike Vue's conditional template groups.
const visibleText = (root: HostNode): string => (root.type === "template" ? "" : root.text + root.children.map(visibleText).join(""));

it("opens an uncontrolled detail dialog and still supports a controlled parent", async () => {
  const context = Symbol("dialog");
  type DialogState = { open: vue.ComputedRef<boolean>; set(open: boolean): void };
  const roots: DialogState[] = [];
  const primitive = (name: string) =>
    vue.defineComponent({
      setup:
        (_props, { attrs, slots }) =>
        () =>
          vue.h(name, attrs, slots.default?.()),
    });
  const dialogs = {
    Dialog: vue.defineComponent({
      props: { open: { type: Boolean, default: undefined } },
      emits: ["update:open"],
      setup(props, { emit, slots }) {
        const local = vue.ref(false);
        const value = {
          open: vue.computed(() => props.open ?? local.value),
          set(open: boolean) {
            if (props.open === undefined) local.value = open;
            emit("update:open", open);
          },
        };
        roots.push(value);
        vue.provide(context, value);
        return () => slots.default?.();
      },
    }),
    DialogTrigger: vue.defineComponent({
      setup: (_props, { slots }) => {
        const value = vue.inject<DialogState>(context)!;
        return () => vue.h("trigger", { onClick: () => value.set(!value.open.value) }, slots.default?.());
      },
    }),
    DialogContent: vue.defineComponent({
      setup: (_props, { attrs, slots }) => {
        const value = vue.inject<DialogState>(context)!;
        return () => (value.open.value ? vue.h("content", attrs, slots.default?.()) : null);
      },
    }),
    DialogHeader: primitive("header"),
    DialogTitle: primitive("title"),
    DialogDescription: primitive("description"),
  };
  const DetailDialog = component("components/DetailDialog.vue", { "./ui/dialog": dialogs, "./ui/button": { Button: primitive("button") } }, true);
  const root = hostNode("root");
  const app = renderer().createApp({ render: () => vue.h(DetailDialog, { title: "使用说明" }, () => "说明正文") });
  app.mount(root);
  cleanups.push(() => app.unmount());
  expect(nodes(root, "content")).toHaveLength(0);
  nodes(root, "trigger")[0]!.props.onClick();
  await vue.nextTick();
  expect(nodes(root, "content")).toHaveLength(1);
  roots[0]!.set(false);
  await vue.nextTick();
  expect(nodes(root, "content")).toHaveLength(0);

  const open = vue.ref(false),
    controlledRoot = hostNode("root");
  const controlled = renderer().createApp({
    render: () => vue.h(DetailDialog, { title: "详情", open: open.value, "onUpdate:open": (next: boolean) => (open.value = next) }),
  });
  controlled.mount(controlledRoot);
  cleanups.push(() => controlled.unmount());
  nodes(controlledRoot, "trigger")[0]!.props.onClick();
  await vue.nextTick();
  expect(open.value).toBe(true);
  roots[1]!.set(false);
  await vue.nextTick();
  expect(open.value).toBe(false);
});

const extension = { name: "yesimbot-extension-demo", version: "1.0.0", module: "demo", status: "running" };
function extensions() {
  const request = vi.fn(async (_path: string, body?: unknown): Promise<unknown> => (body ? { ok: true } : { items: [extension] }));
  const confirmDiscard = vi.fn(async () => true);
  let guard = { dirty: () => false, busy: () => false };
  const h = state(
    "components/ExtensionsPanel.vue",
    {},
    {
      "../lib/api": { api: request, ApiError },
      "../lib/extensions": extensionsLib,
      "../lib/dialog": { confirmDialog: async () => true, confirmDiscard },
      "../lib/editor-guard": { trackEditor: (dirty: () => boolean, busy: () => boolean) => (guard = { dirty, busy }) },
    },
  );
  return { ...h, request, confirmDiscard, guard: () => guard };
}

it("renders the extensions overview and install action as visible page content", () => {
  const primitive = (name: string) =>
    vue.defineComponent({
      setup:
        (_props, { attrs, slots }) =>
        () =>
          vue.h(name, attrs, slots.default?.()),
    });
  const Dialog = vue.defineComponent({
    props: { open: Boolean },
    setup:
      (props, { slots }) =>
      () =>
        props.open ? slots.default?.() : null,
  });
  const ExtensionsPanel = component(
    "components/ExtensionsPanel.vue",
    {
      vue: { ...vue, onMounted() {} },
      "../lib/api": { api: vi.fn(), ApiError },
      "../lib/extensions": extensionsLib,
      "../lib/editor-guard": { trackEditor() {} },
      "../lib/dialog": { confirmDiscard: async () => true, confirmDialog: async () => true },
      "./ui/dialog": {
        Dialog,
        DialogContent: primitive("content"),
        DialogHeader: primitive("header"),
        DialogTitle: primitive("title"),
        DialogDescription: primitive("description"),
      },
      // Vitest compiles imported SFCs for SSR; this custom renderer has no SSR context, so the groups are stubbed too.
      "./group/SettingsGroup.vue": {
        default: vue.defineComponent({
          props: { title: String },
          setup:
            (props, { slots }) =>
            () =>
              vue.h("section", [vue.h("h2", props.title), slots.actions?.(), slots.default?.()]),
        }),
      },
      "./group/GroupRow.vue": {
        default: vue.defineComponent({
          props: { title: String, detail: String },
          setup:
            (props, { slots }) =>
            () =>
              vue.h("row", [props.title, props.detail, slots.default?.()]),
        }),
      },
      "./SettingsSubpage.vue": { default: Dialog },
      "./ui/button": { Button: primitive("button") },
      "./ui/alert": { Alert: primitive("alert") },
      "./ui/input": { Input: primitive("input") },
      "./ui/switch": { Switch: primitive("switch") },
      "./ui/textarea": { Textarea: primitive("textarea") },
    },
    true,
  );
  const root = hostNode("root"),
    app = renderer().createApp(ExtensionsPanel);
  app.mount(root);
  cleanups.push(() => app.unmount());
  expect(visibleText(root)).toContain("我的扩展");
  expect(visibleText(root)).toContain("安装扩展");
  expect(visibleText(root)).toContain("尚未安装扩展");
});

it("drops installation input on dismissal without asking and includes it in the page's draft guard", async () => {
  const h = extensions();
  await h.bindings.setInstallOpen(true);
  h.bindings.spec.value = "yesimbot-extension-demo@1.0.0";
  expect(h.guard().dirty()).toBe(true);
  h.bindings.busy.value = true;
  await h.bindings.setInstallOpen(false);
  expect(h.bindings.installOpen.value).toBe(true);
  h.bindings.busy.value = false;
  await h.bindings.setInstallOpen(false);
  expect(h.bindings.installOpen.value).toBe(false);
  expect(h.bindings.spec.value).toBe("");
  expect(h.guard().dirty()).toBe(false);
  expect(h.confirmDiscard).not.toHaveBeenCalled();
});

it("keeps only the latest requested prompt preview and ignores a late error", async () => {
  const first = deferred<unknown>(),
    second = deferred<unknown>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const h = state("components/PromptOverview.vue", {}, { "../lib/api": { api: request, ApiError } });
  h.bindings.openKey.value = "role";
  const old = h.bindings.load("old"),
    latest = h.bindings.load("latest");
  expect(h.bindings.openKey.value).toBe("");
  second.resolve({ conversation: "latest", conversations: [], segments: [], tools: [] });
  await latest;
  expect(h.bindings.loading.value).toBe(false);
  first.reject(new Error("offline"));
  await old;
  expect(h.bindings.data.value.conversation).toBe("latest");
  expect(h.bindings.error.value).toBe("");
});

// The prompt overview moved from 回复偏好 to 系统 (user, 2026-11-17); `section=prompt` still opens it.
it("closes the prompt overview when its settings link selects another section on the same page", async () => {
  const route = vue.reactive({ query: { section: "prompt" } });
  const h = state(
    "pages/SystemSettings.vue",
    {},
    {
      "vue-router": { useRoute: () => route },
      "../lib/use-topic": { useTopic: () => ({ data: null }) },
      "../lib/route-state": { useRouteState: () => vue.ref("server") },
      "../context": { useSession: () => ({ state: { features: {}, role: "owner" } }) },
      "../lib/editor-guard": { editorRegistry: { busy: () => false } },
    },
  );
  expect(h.bindings.promptOpen.value).toBe(true);
  route.query.section = "yesimbot-sticker-manager";
  await vue.nextTick();
  expect(h.bindings.promptOpen.value).toBe(false);
});

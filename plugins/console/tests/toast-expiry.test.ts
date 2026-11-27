import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as vue from "vue";

import { dismissToast, toast, toasts } from "../web/src/lib/toast";

class HostNode extends EventTarget {
  children: HostNode[] = [];
  parent: HostNode | null = null;
  props: Record<string, unknown> = {};
  text = "";
  offsetHeight = 40;
  style: Record<string, unknown> & { setProperty(name: string, value: string): void; removeProperty(name: string): void };

  constructor(readonly type: string) {
    super();
    const style: HostNode["style"] = {
      setProperty(name, value) {
        style[name] = value;
      },
      removeProperty(name) {
        delete style[name];
      },
    };
    this.style = style;
  }

  get childNodes(): HostNode[] {
    return this.children;
  }

  get nodeType(): number {
    return this.type === "text" ? this.TEXT_NODE : 1;
  }

  readonly TEXT_NODE = 3;

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(text: string) {
    this.text = text;
  }

  readonly dataset: Record<string, string> = {};

  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  focus(): void {
    browserDocument.activeElement = this;
  }

  setAttribute(name: string, value: string): void {
    this.props[name] = value;
  }

  removeAttribute(name: string): void {
    delete this.props[name];
  }

  hasPointerCapture(): boolean {
    return false;
  }

  setPointerCapture(): void {}
  releasePointerCapture(): void {}
}

const browserDocument = { activeElement: null as HostNode | null };
const browserWindow = Object.assign(new EventTarget(), {
  document: browserDocument,
  navigator: { userAgent: "toast-test", maxTouchPoints: 0 },
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  HTMLElement: HostNode,
});

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
let Toasts: vue.Component;
const mounted: Array<{ unmount(): void }> = [];

beforeAll(async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: browserDocument });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: HostNode });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HostNode });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, writable: true, value: browserWindow.requestAnimationFrame });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, writable: true, value: browserWindow.cancelAnimationFrame });
  const reka = await import("reka-ui");
  const Toast = vue.defineComponent({
    inheritAttrs: false,
    props: { open: Boolean, duration: Number, variant: String },
    emits: ["update:open"],
    setup:
      (props, { attrs, emit, slots }) =>
      () =>
        vue.h(reka.ToastRoot, { ...attrs, open: props.open, duration: props.duration, "onUpdate:open": (open: boolean) => emit("update:open", open) }, slots),
  });
  const primitive = (type: string) =>
    vue.defineComponent({
      setup:
        (_props, { attrs, slots }) =>
        () =>
          vue.h(type, attrs, slots.default?.()),
    });
  const source = readFileSync(new URL("../web/src/shell/Toasts.vue", import.meta.url), "utf8");
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: "toast-expiry", inlineTemplate: true });
  const module = { exports: {} as { default: vue.Component } };
  runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module,
    exports: module.exports,
    require: (name: string) =>
      name === "vue"
        ? vue
        : name === "../components/ui/toast"
          ? { Toast, ToastProvider: reka.ToastProvider, ToastViewport: reka.ToastViewport, ToastTitle: reka.ToastTitle, ToastClose: reka.ToastClose }
          : name === "../components/ui/button"
            ? { Button: primitive("button") }
            : name === "../lib/toast"
              ? { toast, toasts, dismissToast }
              : name === "./Icon.vue"
                ? { default: primitive("svg") }
                : {},
  });
  Toasts = module.exports.default;
});

afterEach(() => {
  mounted.splice(0).forEach((app) => app.unmount());
  toasts.splice(0);
  browserDocument.activeElement = null;
  vi.useRealTimers();
});

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
  if (originalElement) Object.defineProperty(globalThis, "Element", originalElement);
  else Reflect.deleteProperty(globalThis, "Element");
  if (originalHTMLElement) Object.defineProperty(globalThis, "HTMLElement", originalHTMLElement);
  else Reflect.deleteProperty(globalThis, "HTMLElement");
  if (originalRequestAnimationFrame) Object.defineProperty(globalThis, "requestAnimationFrame", originalRequestAnimationFrame);
  else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  if (originalCancelAnimationFrame) Object.defineProperty(globalThis, "cancelAnimationFrame", originalCancelAnimationFrame);
  else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
});

const renderer = vue.createRenderer<HostNode, HostNode>({
  createElement: (type) => new HostNode(type),
  createText: (text) => Object.assign(new HostNode("text"), { text }),
  createComment: (text) => Object.assign(new HostNode("comment"), { text }),
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
    child.parent = parent;
  },
  remove(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = null;
  },
  setElementText(node, text) {
    node.text = text;
    node.children = [];
  },
  setText(node, text) {
    node.text = text;
  },
  parentNode: (node) => node.parent,
  nextSibling: (node) => (node.parent ? (node.parent.children[node.parent.children.indexOf(node) + 1] ?? null) : null),
  patchProp(node, key, _previous, value) {
    node.props[key] = value;
  },
});

function mountToasts(): HostNode {
  const root = new HostNode("root");
  const app = renderer.createApp(Toasts);
  app.mount(root);
  mounted.push(app);
  return root;
}

function find(node: HostNode, type: string): HostNode | undefined {
  if (node.type === type) return node;
  for (const child of node.children) {
    const match = find(child, type);
    if (match) return match;
  }
}

async function renderTimers(): Promise<void> {
  await vue.nextTick();
  await vue.nextTick();
}

it("assigns finite defaults to success, warning, and danger while preserving a custom duration", () => {
  toast("成功");
  toast("提醒", "warn");
  toast("失败", "danger");
  expect(toasts.map(({ tone, duration }) => ({ tone, duration }))).toEqual([
    { tone: "ok", duration: 4000 },
    { tone: "warn", duration: 8000 },
    { tone: "danger", duration: 8000 },
  ]);
  toast("自定义", "danger", 1234);
  expect(toasts.at(-1)).toMatchObject({ text: "自定义", tone: "danger", duration: 1234 });
});

it("dismisses each controlled toast from Reka's real timer", async () => {
  vi.useFakeTimers({ now: 1000 });
  mountToasts();
  toast("成功");
  toast("提醒", "warn");
  toast("失败", "danger");
  await renderTimers();

  await vi.advanceTimersByTimeAsync(3999);
  expect(toasts.map((item) => item.text)).toEqual(["成功", "提醒", "失败"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(toasts.map((item) => item.text)).toEqual(["提醒", "失败"]);
  await vi.advanceTimersByTimeAsync(4000);
  expect(toasts).toEqual([]);
});

it("keeps consecutive repeated notifications independent and pauses them while hovered", async () => {
  vi.useFakeTimers({ now: 1000 });
  const root = mountToasts();
  for (let index = 0; index < 4; index++) toast("重复通知", "ok", 1000);
  await renderTimers();
  expect(toasts).toHaveLength(3);

  find(root, "ol")!.dispatchEvent(new Event("pointermove"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(toasts).toHaveLength(3);
  find(root, "ol")!.dispatchEvent(new Event("pointerleave"));
  await vi.advanceTimersByTimeAsync(999);
  expect(toasts).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(toasts).toEqual([]);
});

it("resumes the remaining duration after returning from the background", async () => {
  vi.useFakeTimers({ now: 1000 });
  mountToasts();
  toast("后台通知", "warn", 1000);
  await renderTimers();
  await vi.advanceTimersByTimeAsync(400);

  browserWindow.dispatchEvent(new Event("blur"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(toasts).toHaveLength(1);
  browserWindow.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(599);
  expect(toasts).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(toasts).toEqual([]);
});

it("clears pending notifications when the toast host unmounts", async () => {
  vi.useFakeTimers({ now: 1000 });
  mountToasts();
  toast("即将卸载", "danger", 1000);
  await renderTimers();
  mounted.pop()!.unmount();
  expect(toasts).toEqual([]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(toasts).toEqual([]);
});

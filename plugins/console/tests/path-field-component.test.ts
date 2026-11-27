import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import type { FileEntry, FileListing, FileStat, UploadResult } from "../src/shared/files";
import { ui } from "./fixtures/ui";

const cleanups: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settleMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const primitive = (tag: string) =>
  vue.defineComponent({
    setup:
      (_, { attrs, slots }) =>
      () =>
        vue.h(tag, attrs, slots.default?.()),
  });
const dialogs = { Dialog: primitive("dialog"), DialogContent: primitive("section"), DialogTitle: primitive("h2") };

interface PathBindings {
  picker: vue.Ref<Pick<HTMLInputElement, "click"> | undefined>;
  browsing: vue.Ref<boolean>;
  dragging: vue.Ref<boolean>;
  uploading: vue.Ref<boolean>;
  unavailable: vue.Ref<boolean>;
  progress: vue.Ref<number | undefined>;
  error: vue.Ref<string>;
  thumb: vue.Ref<string>;
  browserTrigger: vue.Ref<HTMLElement | undefined>;
  openPicker(): void;
  startBrowsing(event?: MouseEvent): void;
  type(path: string): void;
  choose(path: string): void;
  dragOver(): void;
  dropped(event: DragEvent): void;
  picked(event: Event): void;
  upload(file: File): Promise<void>;
  inspect(path: string): Promise<void>;
}

interface BrowserBindings {
  listing: vue.Ref<FileListing | undefined>;
  canConfirm: vue.Ref<boolean>;
  loading: vue.Ref<boolean>;
  error: vue.Ref<string>;
  open(dir: string): Promise<void>;
  confirm(): void;
  activate(entry: FileEntry): void;
  select(entry: FileEntry): void;
  close(): void;
  restoreFocus(event: Event): void;
}

function component<T extends object>(file: string, props: Record<string, unknown>, files: Record<string, unknown>) {
  const { descriptor } = parse(readFileSync(new URL(`../web/src/schema/${file}.vue`, import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: file });
  const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} as { default: { setup: (props: unknown, context: unknown) => T } } };
  const unmount: Array<() => void> = [];
  const objectUrl = { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() };
  const fetch = vi.fn();
  runInNewContext(transpile(script.content), {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    URL: objectUrl,
    fetch,
    require: (name: string) =>
      ({
        vue: { ...vue, onMounted() {}, onUnmounted: (fn: () => void) => unmount.push(fn), inject: (_key: unknown, fallback: unknown) => fallback },
        "../lib/files": files,
        "./schema-model": { SCHEMA_SCOPE: Symbol("scope") },
        "../components/ui/dialog": dialogs,
      })[name] ??
      ui(name) ?? { default: {} },
  });
  const emit = vi.fn();
  const scope = vue.effectScope();
  const bindings = scope.run(() => module.exports.default.setup(props, { emit, expose() {} }))!;
  const dispose = () => {
    unmount.splice(0).forEach((fn) => fn());
    scope.stop();
  };
  cleanups.push(dispose);
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: `${file}.vue`,
    id: file,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  expect(template.errors).toEqual([]);
  const rendered = { exports: {} as { render: (...args: unknown[]) => vue.VNode } };
  runInNewContext(transpile(template.code), { module: rendered, exports: rendered.exports, require: () => vue });
  return {
    bindings,
    emit,
    dispose,
    objectUrl,
    fetch,
    render: () => renderToString(vue.createSSRApp({ render: () => rendered.exports.render({}, [], props, vue.proxyRefs(bindings)) })),
  };
}

function pathField(initial: Record<string, unknown> = {}) {
  const props = vue.reactive({ modelValue: "", placeholder: "文件路径", disabled: false, ...initial });
  const uploadFile = vi.fn(async (_file: File, _scope: string, _progress?: (ratio: number) => void): Promise<UploadResult> => ({
    path: "uploads/new.txt",
    name: "new.txt",
    size: 4,
  }));
  const statFile = vi.fn(async (path: string): Promise<FileStat> => ({ path, exists: false }));
  const h = component<PathBindings>("PathField", props, {
    uploadFile,
    statFile,
    previewUrl: (path: string) => path,
    fileError: () => "上传失败",
    formatBytes: (size: number) => `${size} B`,
    MAX_UPLOAD_BYTES: 20 * 1024 * 1024,
  });
  return { ...h, props, uploadFile, statFile };
}
const file = (name = "new.txt", buffer = Promise.resolve(new ArrayBuffer(8))) => ({ name, size: 4, arrayBuffer: vi.fn(() => buffer) }) as unknown as File;
const pickerEvent = (selected?: File) => ({ target: { files: selected ? [selected] : [], value: selected?.name ?? "" } }) as unknown as Event;
const dropEvent = (selected: File) => ({ dataTransfer: { files: [selected] } }) as unknown as DragEvent;

it("blocks read-only path edits, drag uploads and a picker opened before the field became disabled", async () => {
  const h = pathField();
  const click = vi.fn();
  h.bindings.picker.value = { click };
  h.bindings.openPicker();
  expect(click).toHaveBeenCalledOnce();
  h.bindings.startBrowsing();
  expect(h.bindings.browsing.value).toBe(true);
  h.props.disabled = true;
  h.bindings.type("changed.txt");
  h.bindings.choose("changed.txt");
  h.bindings.dragOver();
  h.bindings.dropped(dropEvent(file()));
  const chosen = pickerEvent(file());
  h.bindings.picked(chosen);
  h.bindings.openPicker();
  h.bindings.startBrowsing();
  await h.bindings.upload(file());
  expect(h.emit).not.toHaveBeenCalled();
  expect(h.uploadFile).not.toHaveBeenCalled();
  expect(click).toHaveBeenCalledOnce();
  expect(h.bindings.dragging.value).toBe(false);
  expect(h.bindings.browsing.value).toBe(false);
  expect((chosen.target as HTMLInputElement).value).toBe("");
  const html = await h.render();
  expect(html.match(/\sdisabled(?:\s|>)/g)).toHaveLength(4);
});

it("does not upload after cancelling the native picker or for a directory-only field", async () => {
  const h = pathField({ extra: { filters: ["directory"] } });
  h.bindings.picked(pickerEvent());
  h.bindings.picked(pickerEvent(file()));
  h.bindings.dropped(dropEvent(file()));
  await h.bindings.upload(file());
  expect(h.uploadFile).not.toHaveBeenCalled();
  expect(h.emit).not.toHaveBeenCalled();
  expect(h.bindings.uploading.value).toBe(false);
});

it("locks the field while uploading and accepts only one upload until its response settles", async () => {
  const response = deferred<UploadResult>();
  const h = pathField();
  h.uploadFile.mockImplementationOnce(() => response.promise);
  const pending = h.bindings.upload(file("card.png"));
  expect(h.bindings.unavailable.value).toBe(true);
  h.bindings.dropped(dropEvent(file()));
  h.bindings.picked(pickerEvent(file()));
  h.bindings.type("changed.txt");
  h.bindings.choose("changed.txt");
  expect(h.uploadFile).toHaveBeenCalledOnce();
  h.uploadFile.mock.calls[0]![2]!(0.5);
  expect(h.bindings.progress.value).toBe(0.5);
  response.resolve({ path: "uploads/card.png", name: "card.png", size: 8 });
  await pending;
  expect(h.emit).toHaveBeenCalledExactlyOnceWith("update:modelValue", "uploads/card.png");
  expect(h.bindings.uploading.value).toBe(false);
  expect(h.bindings.progress.value).toBeUndefined();
});

it.each(["disable", "replace", "dispose"])("ignores upload progress and a late result after %s", async (action) => {
  const h = pathField();
  const response = deferred<UploadResult>();
  h.uploadFile.mockImplementationOnce(() => response.promise);
  const pending = h.bindings.upload(file("image.jpg"));
  if (action === "disable") {
    h.props.disabled = true;
    h.props.disabled = false;
  } else if (action === "replace") h.props.modelValue = "other.txt";
  else h.dispose();
  h.uploadFile.mock.calls[0]![2]!(0.75);
  expect(h.bindings.progress.value).toBe(0);
  response.resolve({ path: "uploads/image.jpg", name: "image.jpg", size: 4 });
  await pending;
  expect(h.emit).not.toHaveBeenCalled();
  expect(h.objectUrl.createObjectURL).not.toHaveBeenCalled();
});

it("ignores upload errors that arrive after dismissal", async () => {
  const h = pathField();
  const response = deferred<UploadResult>();
  h.uploadFile.mockImplementationOnce(() => response.promise);
  const pending = h.bindings.upload(file());
  h.dispose();
  response.reject(new Error("offline"));
  await pending;
  expect(h.bindings.error.value).toBe("");
});

it.each(["replace", "dispose"])("ignores an image preview completed after %s", async (action) => {
  const h = pathField({ modelValue: "card.png" });
  const preview = deferred<Blob>();
  h.statFile.mockResolvedValueOnce({ path: "card.png", exists: true, type: "file" });
  const blob = vi.fn(() => preview.promise);
  h.fetch.mockResolvedValueOnce({ ok: true, blob });
  const pending = h.bindings.inspect("card.png");
  await settleMicrotasks();
  expect(blob).toHaveBeenCalledOnce();
  if (action === "replace") h.props.modelValue = "other.txt";
  else h.dispose();
  preview.resolve(new Blob([]));
  await pending;
  expect(h.objectUrl.createObjectURL).not.toHaveBeenCalled();
  expect(h.bindings.thumb.value).toBe("");
});

const entry = (name: string, type: "file" | "directory" = "file"): FileEntry => ({ name, path: `old/${name}`, type, size: 4, mtime: 1 });
const listing = (dir = "old"): FileListing => ({
  dir,
  parent: ".",
  entries: [entry("card.png"), entry("other.txt"), entry("child", "directory")],
  truncated: false,
});
function fileBrowser(initial: Record<string, unknown> = {}) {
  const props = vue.reactive<{ start: string; mode: "file" | "directory" | "any"; extensions: string[]; disabled: boolean }>({
    start: "old",
    mode: "any",
    extensions: [],
    disabled: false,
    ...initial,
  });
  const listFiles = vi.fn(async (_dir: string) => listing());
  const h = component<BrowserBindings>("FileBrowser", props, { listFiles, fileError: () => "读取失败", formatBytes: (size: number) => `${size} B` });
  return { ...h, props, listFiles };
}

it.each(["close", "choose"])("returns the file browser to its path-field button after %s", (action) => {
  const path = pathField();
  const trigger = { isConnected: true, matches: vi.fn(() => false), focus: vi.fn() };
  const click = { currentTarget: trigger as unknown as EventTarget | null };
  path.bindings.startBrowsing(click as unknown as MouseEvent);
  click.currentTarget = null;
  const h = fileBrowser({ returnFocusTo: path.bindings.browserTrigger.value });
  if (action === "close") h.bindings.close();
  else {
    h.bindings.listing.value = listing();
    h.bindings.confirm();
  }
  const preventDefault = vi.fn();
  h.bindings.restoreFocus({ preventDefault } as unknown as Event);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(trigger.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
});

it("does not restore a browser into a removed or disabled path-field button", () => {
  const trigger = { isConnected: false, matches: vi.fn(() => true), focus: vi.fn() };
  const h = fileBrowser({ returnFocusTo: trigger });
  const preventDefault = vi.fn();
  h.bindings.restoreFocus({ preventDefault } as unknown as Event);
  expect(preventDefault).not.toHaveBeenCalled();
  trigger.isConnected = true;
  h.bindings.restoreFocus({ preventDefault } as unknown as Event);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(trigger.focus).not.toHaveBeenCalled();
});

it("cannot confirm an old directory or activate old rows while another directory is loading or has failed", async () => {
  const h = fileBrowser();
  h.bindings.listing.value = listing();
  expect(h.bindings.canConfirm.value).toBe(true);
  const response = deferred<FileListing>();
  h.listFiles.mockImplementationOnce(() => response.promise).mockRejectedValueOnce(new Error("offline"));
  const pending = h.bindings.open("missing");
  h.bindings.confirm();
  h.bindings.activate(entry("card.png"));
  await h.bindings.open("another");
  expect(h.listFiles).toHaveBeenCalledOnce();
  expect(h.bindings.canConfirm.value).toBe(false);
  const html = await h.render();
  expect(html.replace(/<!--.*?-->/g, "")).toMatch(/<button[^>]*\sdisabled[^>]*>\s*选择此文件夹/);
  response.reject(new Error("offline"));
  await pending;
  expect(h.listFiles).toHaveBeenLastCalledWith(".");
  expect(h.bindings.loading.value).toBe(false);
  expect(h.bindings.error.value).toBe("读取失败");
  h.bindings.confirm();
  h.bindings.activate(entry("card.png"));
  expect(h.emit).not.toHaveBeenCalled();
});

it("keeps selection locked through fallback and can choose the successfully loaded data directory", async () => {
  const h = fileBrowser({ mode: "directory" });
  const fallback = deferred<FileListing>();
  h.listFiles.mockRejectedValueOnce(new Error("missing")).mockImplementationOnce(() => fallback.promise);
  const pending = h.bindings.open("missing");
  await settleMicrotasks();
  expect(h.listFiles).toHaveBeenLastCalledWith(".");
  expect(h.bindings.loading.value).toBe(true);
  expect(h.bindings.canConfirm.value).toBe(false);
  fallback.resolve(listing("."));
  await pending;
  expect(h.bindings.loading.value).toBe(false);
  expect(h.bindings.error.value).toBe("");
  h.bindings.confirm();
  expect(h.emit).toHaveBeenCalledExactlyOnceWith("choose", ".");
});

it.each(["close", "dispose", "disable"])("invalidates a pending directory request on %s and skips its fallback", async (action) => {
  const h = fileBrowser();
  const response = deferred<FileListing>();
  h.listFiles.mockImplementationOnce(() => response.promise);
  const pending = h.bindings.open("missing");
  if (action === "close") h.bindings.close();
  else if (action === "dispose") h.dispose();
  else h.props.disabled = true;
  response.reject(new Error("offline"));
  await pending;
  expect(h.listFiles).toHaveBeenCalledOnce();
  expect(h.bindings.listing.value).toBeUndefined();
  expect(h.bindings.error.value).toBe("");
  h.bindings.confirm();
  expect(h.emit.mock.calls.filter(([name]) => name === "choose")).toEqual([]);
});

it("blocks read-only file selection and rejects a stale selection after the filter contract changes", async () => {
  const h = fileBrowser({ mode: "file" });
  h.bindings.listing.value = listing();
  h.bindings.select(entry("card.png"));
  expect(h.bindings.canConfirm.value).toBe(true);
  h.props.extensions = [".txt"];
  expect(h.bindings.canConfirm.value).toBe(false);
  h.bindings.confirm();
  h.bindings.activate(entry("card.png"));
  h.props.disabled = true;
  h.bindings.select(entry("other.txt"));
  h.bindings.activate(entry("other.txt"));
  h.bindings.confirm();
  await h.bindings.open(".");
  expect(h.emit).not.toHaveBeenCalled();
  expect(h.listFiles).not.toHaveBeenCalled();
});

it("confirms an allowed file once and keeps cancel available while the browser is read-only", () => {
  const h = fileBrowser({ mode: "file", extensions: [".png"] });
  h.bindings.listing.value = listing();
  h.bindings.select(entry("card.png"));
  h.bindings.confirm();
  h.bindings.confirm();
  h.bindings.activate(entry("card.png"));
  expect(h.emit).toHaveBeenCalledExactlyOnceWith("choose", "old/card.png");
  const disabled = fileBrowser({ disabled: true });
  disabled.bindings.close();
  disabled.bindings.close();
  expect(disabled.emit).toHaveBeenCalledExactlyOnceWith("close");
});

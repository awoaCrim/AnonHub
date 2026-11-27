import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import { ApiError } from "../web/src/lib/api";
import * as summary from "../web/src/lib/document-summary";
import { ui } from "./fixtures/ui";

type Memory = { id: string; content: string; visibility: "owner" | "conversation" | "shared"; revision: number };
interface Bindings {
  loaded: vue.Ref<boolean>;
  items: vue.Ref<Memory[]>;
  draft: vue.Ref<string>;
  visibility: vue.Ref<Memory["visibility"]>;
  busy: vue.Ref<boolean>;
  selected: vue.Ref<Memory | undefined>;
  error: vue.Ref<string>;
  edit(item: Memory): Promise<void>;
  problem: vue.Ref<string>;
  close(): void;
  updateOpen(open: boolean): void;
  commit(): Promise<void>;
  setVisibility(value: string): void;
  load(): Promise<void>;
  remove(item: Memory): Promise<void>;
  attachmentsOf(item: Memory & { attachments?: unknown[] }): { kind: string; name: string; url?: string; size?: number }[];
}
const original: Memory = { id: "private-fact", content: "喜欢安静的早晨。", visibility: "conversation", revision: 7 };
function harness() {
  const api = vi.fn(async (_url: string, _body?: unknown): Promise<unknown> => ({ memories: [{ ...original }] }));
  const confirm = vi.fn(async () => true),
    emit = vi.fn(),
    toast = vi.fn();
  let guarded = () => false;
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/MemoryPanel.vue", import.meta.url), "utf8"));
  const module = { exports: {} as { default: { setup: (props: unknown, context: unknown) => Bindings } } };
  runInNewContext(
    ts.transpileModule(compileScript(descriptor, { id: "memory-panel" }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    {
      module,
      exports: module.exports,
      URLSearchParams,
      require: (name: string) =>
        ({
          vue: { ...vue, onBeforeUnmount() {} },
          "../lib/api": { api, ApiError },
          "../lib/dialog": { confirmDialog: confirm },
          "../lib/document-summary": summary,
          "../lib/editor-guard": {
            trackEditor: (dirty: () => boolean) => {
              guarded = dirty;
            },
          },
          "../lib/toast": { toast },
          "../lib/format": { formatTime: () => "刚刚" },
          "@yesimbot/contracts/platforms": { platformLabel: (value: string) => value },
        })[name] ??
        ui(name) ??
        (name.endsWith(".vue") ? { default: {} } : {}),
    },
  );
  const scope = vue.effectScope();
  const state = scope.run(() => module.exports.default.setup(vue.reactive({ opened: false }), { expose() {}, emit }));
  return { state, api, confirm, emit, toast, guarded: () => guarded(), dispose: () => scope.stop() };
}

it("saves the typed text when the box loses focus, keeps the dialog open and offers 撤销", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.state.loaded.value).toBe(true));
  await h.state.edit(h.state.items.value[0]!);
  expect(h.state.draft.value).toBe(original.content);
  expect(h.state.visibility.value).toBe("conversation");
  h.state.draft.value = "喜欢安静的早晨，也喜欢红茶。";
  h.api.mockResolvedValueOnce({ ...original, content: h.state.draft.value, revision: 8 });
  await h.state.commit();
  expect(h.api).toHaveBeenLastCalledWith("/yesimbot/api/v1/memory", {
    action: "update",
    id: original.id,
    revision: 7,
    content: "喜欢安静的早晨，也喜欢红茶。",
  });
  expect(h.state.items.value[0]!.revision).toBe(8);
  expect(h.state.selected.value?.revision).toBe(8);
  expect(h.emit).not.toHaveBeenCalledWith("close");
  expect(h.guarded()).toBe(false);
  const [text, , , action] = h.toast.mock.calls.at(-1)!;
  expect([text, action.label]).toEqual(["已保存", "撤销"]);
  h.api.mockResolvedValueOnce({ ...original, revision: 9 });
  action.run();
  await vi.waitFor(() => expect(h.state.draft.value).toBe(original.content));
  expect(h.api).toHaveBeenLastCalledWith("/yesimbot/api/v1/memory", { action: "update", id: original.id, revision: 8, content: original.content });
  expect(h.toast.mock.calls.at(-1)![0]).toBe("已撤销");
  h.dispose();
});

it("saves a changed range at once, refuses an empty text and saves the typed text on close", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.state.loaded.value).toBe(true));
  await h.state.edit(h.state.items.value[0]!);
  h.api.mockResolvedValueOnce({ ...original, visibility: "owner", revision: 8 });
  h.state.setVisibility("owner");
  await vi.waitFor(() => expect(h.state.busy.value).toBe(false));
  expect(h.api).toHaveBeenLastCalledWith("/yesimbot/api/v1/memory", {
    action: "update",
    id: original.id,
    revision: 7,
    content: original.content,
    visibility: "owner",
  });
  const calls = h.api.mock.calls.length;
  h.state.draft.value = "  ";
  await h.state.commit();
  expect(h.state.problem.value).toBe("记忆正文不能为空。");
  expect(h.api).toHaveBeenCalledTimes(calls);
  h.state.draft.value = "新的正文";
  h.api.mockResolvedValueOnce({ ...original, content: "新的正文", visibility: "owner", revision: 9 });
  h.state.updateOpen(false);
  expect(h.state.selected.value).toBeUndefined();
  expect(h.emit).toHaveBeenCalledWith("close");
  await vi.waitFor(() => expect(h.state.items.value[0]!.content).toBe("新的正文"));
  h.dispose();
});

it("shows the latest copy after a revision conflict and keeps the typed text after another failure", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.state.loaded.value).toBe(true));
  await h.state.edit(h.state.items.value[0]!);
  h.state.draft.value = "离线时写的";
  h.api.mockRejectedValueOnce(new Error("offline"));
  await h.state.commit();
  expect(h.state.draft.value).toBe("离线时写的");
  expect(h.toast).toHaveBeenLastCalledWith("没能保存，请稍后重试。", "danger");
  h.api.mockRejectedValueOnce(new ApiError(409, "memory_revision_conflict"));
  h.api.mockResolvedValueOnce({ memories: [{ ...original, content: "别处改过的", revision: 8 }] });
  await h.state.commit();
  expect(h.toast).toHaveBeenLastCalledWith("这份记忆刚在别处更新，已显示最新内容。", "danger");
  expect(h.state.draft.value).toBe("别处改过的");
  expect(h.state.selected.value?.revision).toBe(8);
  h.dispose();
});

it("keeps the loaded file list on failure and deletes only after confirmation using its revision", async () => {
  const h = harness();
  await vi.waitFor(() => expect(h.state.loaded.value).toBe(true));
  h.api.mockRejectedValueOnce(new Error("offline"));
  await h.state.load();
  expect(h.state.items.value).toEqual([original]);
  expect(h.state.error.value).toContain("无法读取");
  h.state.error.value = "";
  h.confirm.mockResolvedValueOnce(false);
  await h.state.remove(original);
  expect(h.api).toHaveBeenCalledTimes(2);
  h.api.mockResolvedValueOnce({ deleted: true });
  await h.state.remove(original);
  expect(h.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true }));
  expect(h.api).toHaveBeenLastCalledWith("/yesimbot/api/v1/memory", { action: "delete", id: original.id, revision: 7 });
  expect(h.state.items.value).toEqual([]);
  h.dispose();
});

it("makes reading previews without exposing metadata lines or changing the editor content", () => {
  const content = "来源: web entry-id-123\n# 用户偏好\n- **喜欢红茶**，不加糖。\ncompartment: owner\nevidence: message-5";
  expect(summary.documentTitle(content)).toBe("用户偏好");
  expect(summary.documentPreview(content)).not.toMatch(/entry-id|compartment|message-5/);
  expect(content).toContain("entry-id-123");
});

it("shows a memory's pictures as images and other attachments as files, read through the owner's attachment route", () => {
  const h = harness();
  const memory = {
    ...original,
    id: "立绘 记忆",
    attachments: [
      { index: 1, mediaType: "image/jpeg", byteLength: 590_887 },
      { index: 3, name: "notes.pdf", mediaType: "application/pdf", byteLength: 1024 },
    ],
  };
  expect(h.state.attachmentsOf(memory)).toEqual([
    { kind: "image", name: "图片 1", url: "/yesimbot/api/v1/memory/attachment?id=%E7%AB%8B%E7%BB%98+%E8%AE%B0%E5%BF%86&index=1", size: 590_887 },
    { kind: "file", name: "notes.pdf", url: "/yesimbot/api/v1/memory/attachment?id=%E7%AB%8B%E7%BB%98+%E8%AE%B0%E5%BF%86&index=3", size: 1024 },
  ]);
  expect(h.state.attachmentsOf(original)).toEqual([]);
  h.dispose();
});

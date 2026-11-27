import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import type { ChatSnapshot } from "../src/shared/chat";
import { api, ApiError, type RequestOptions } from "../web/src/lib/api";
import { formatBytes, formatTime } from "../web/src/lib/format";
import { useVoiceInput } from "../web/src/lib/voice-input";
import { chatError, createWebChat } from "../web/src/state/web-chat";

const snapshot = (messages: ChatSnapshot["messages"], typing = false): ChatSnapshot => ({
  conversation: { platform: "web", channel: "web:bot:owner", session: "20261107.jsonl" },
  messages,
  typing,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("shows a sent message at once, keeps it until the snapshot lists it, and links older messages", async () => {
  const sent: unknown[] = [];
  const request = vi.fn(async (path: string, body?: unknown) => {
    if (path === "/yesimbot/api/v1/chat") return snapshot([{ id: "a", role: "bot", text: "早", at: 1, status: "sent" }]);
    sent.push(body);
    return { messageId: "m1" };
  }) as never;
  const chat = createWebChat(request);
  await chat.load();
  expect(chat.messages.value.map((message) => message.text)).toEqual(["早"]);
  expect(chat.historyLink.value).toBe("/conversations?c=web%3Abot%3Aowner");

  expect(await chat.send("  你好  ")).toBe(true);
  expect(sent).toEqual([{ text: "你好", clientId: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
  // Accepted but not yet in a snapshot: still shown, without a spinner, under the server's ID.
  expect(chat.messages.value.at(-1)).toMatchObject({ id: "m1", role: "user", text: "你好", status: "sent" });

  chat.accept(
    snapshot(
      [
        { id: "a", role: "bot", text: "早", at: 1 },
        { id: "m1", role: "user", text: "你好", at: 2, status: "sent" },
      ],
      true,
    ),
  );
  expect(chat.messages.value.map((message) => [message.id, message.status])).toEqual([
    ["a", undefined],
    ["m1", "sent"],
  ]);
  expect(chat.typing.value).toBe(true);
  expect(chat.state.pending).toEqual([]);
});

it("shows the images of a message being sent from their local previews until the snapshot lists it", async () => {
  const request = vi.fn(async (_path: string, body?: unknown) => (body ? { messageId: "m2" } : snapshot([]))) as never;
  const chat = createWebChat(request);
  await chat.load();
  expect(await chat.send("", ["u1"], [{ kind: "image", name: "a.png", url: "blob:a" }])).toBe(true);
  expect((request as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]).toEqual({ text: "", uploads: ["u1"], clientId: expect.any(String) });
  expect(chat.messages.value.at(-1)).toMatchObject({ id: "m2", status: "sent", attachments: [{ kind: "image", name: "a.png", url: "blob:a" }] });
  chat.accept(
    snapshot([
      {
        id: "m2",
        role: "user",
        text: "",
        at: 2,
        status: "sent",
        attachments: [{ kind: "image", name: "a.png", url: "/yesimbot/api/v1/chat/attachment?c=&asset=x" }],
      },
    ]),
  );
  expect(chat.messages.value.map((message) => message.attachments?.[0]?.url)).toEqual(["/yesimbot/api/v1/chat/attachment?c=&asset=x"]);
});

it("keeps a refused message on screen as failed with the reason, and refuses empty text", async () => {
  const request = vi.fn(async () => {
    throw new ApiError(429, "busy");
  }) as never;
  const chat = createWebChat(request);
  chat.accept(snapshot([]));
  expect(await chat.send("   ")).toBe(false);
  expect(request).not.toHaveBeenCalled();
  expect(await chat.send("在吗")).toBe(false);
  expect(chat.messages.value).toMatchObject([{ text: "在吗", status: "failed" }]);
  expect(chat.failure(chat.messages.value[0]!.id)).toBe("它还在处理前面的消息，等一下再发。");
  // A real refusal is not retried by itself.
  expect(request).toHaveBeenCalledTimes(1);

  expect(chatError(new ApiError(503, "runtime_not_ready"))).toBe("机器人还没准备好，请稍后再发。");
  expect(chatError(new ApiError(400, "invalid_chat_request"))).toBe("消息不能为空，也不能超过 4000 个字。");
  expect(chatError(new TypeError("fetch failed"))).toBe("网络连接不上，消息还没发出去，请稍后重试。");
});

it("retries a send whose answer was lost under the same client ID, so it lands once and never fails", async () => {
  const seen: string[] = [];
  let lost = 2;
  const request = vi.fn(async (_path: string, body?: unknown) => {
    const id = (body as { clientId: string }).clientId;
    seen.push(id);
    // The server has it every time; only the answer is lost.
    if (lost-- > 0) throw new ApiError(0, "write_unknown");
    return { messageId: id };
  }) as never;
  const chat = createWebChat(request, { retryDelays: [0, 0] });
  chat.accept(snapshot([]));
  const sent = chat.send("在吗");
  // Shown at once, before any answer.
  expect(chat.messages.value).toMatchObject([{ text: "在吗", status: "sent" }]);
  expect(await sent).toBe(true);
  expect(seen).toHaveLength(3);
  expect(new Set(seen).size).toBe(1);
  expect(chat.messages.value).toMatchObject([{ id: seen[0], status: "sent" }]);
  expect(chat.state.error).toBe("");
});

it("treats a send as landed when the snapshot lists it while its answer is still missing", async () => {
  let id = "";
  const chat = createWebChat(
    vi.fn(async (_path: string, body?: unknown) => {
      id = (body as { clientId: string }).clientId;
      chat.accept(snapshot([{ id, role: "user", text: "在吗", at: 2, status: "sending" }]));
      throw new ApiError(0, "write_unknown");
    }) as never,
    { retryDelays: [0] },
  );
  chat.accept(snapshot([]));
  expect(await chat.send("在吗")).toBe(true);
  expect(chat.state.pending).toEqual([]);
  // What the server holds is accepted: no spinner on it.
  expect(chat.messages.value).toMatchObject([{ id, text: "在吗", status: "sent" }]);
});

it("marks a send that stayed unanswered as failed, and retry sends the same message again", async () => {
  const seen: Array<{ clientId: string; uploads?: string[] }> = [];
  let online = false;
  const chat = createWebChat(
    vi.fn(async (_path: string, body?: unknown) => {
      seen.push(body as never);
      if (!online) throw new ApiError(0, "write_unknown");
      return { messageId: (body as { clientId: string }).clientId };
    }) as never,
    { retryDelays: [0] },
  );
  chat.accept(snapshot([]));
  expect(await chat.send("在吗", ["u1"])).toBe(false);
  expect(seen).toHaveLength(2);
  const [failed] = chat.messages.value;
  expect(failed).toMatchObject({ text: "在吗", status: "failed" });
  online = true;
  expect(await chat.retry(failed!.id)).toBe(true);
  expect(seen).toHaveLength(3);
  expect(seen[2]).toEqual({ text: "在吗", uploads: ["u1"], clientId: seen[0]!.clientId });
  expect(chat.messages.value).toMatchObject([{ status: "sent" }]);
});

it("sends several messages without waiting for answers, in the order typed", async () => {
  const order: string[] = [];
  const release: Array<() => void> = [];
  const chat = createWebChat(
    vi.fn(
      (_path: string, body?: unknown) =>
        new Promise((resolve) => {
          order.push((body as { text: string }).text);
          release.push(() => resolve({ messageId: (body as { clientId: string }).clientId }));
        }),
    ) as never,
  );
  chat.accept(snapshot([]));
  const first = chat.send("一");
  const second = chat.send("二");
  expect(chat.messages.value.map((message) => message.text)).toEqual(["一", "二"]);
  await flush();
  expect(order).toEqual(["一"]);
  release[0]!();
  await first;
  await flush();
  expect(order).toEqual(["一", "二"]);
  release[1]!();
  expect(await second).toBe(true);
});

it("treats a server without the web chat as unavailable instead of failing forever", async () => {
  const chat = createWebChat(
    vi.fn(async () => {
      throw new ApiError(404, "request_failed");
    }) as never,
  );
  await chat.load();
  expect(chat.state.unavailable).toBe(true);
  expect(chat.state.loadError).toBe("");
  // A live snapshot later wins.
  chat.accept(snapshot([]));
  expect(chat.state.unavailable).toBe(false);

  const flaky = createWebChat(
    vi.fn(async () => {
      throw new ApiError(500, "boom");
    }) as never,
  );
  await flaky.load();
  expect(flaky.state.unavailable).toBe(false);
  expect(flaky.state.loadError).toBe("暂时读不到对话，稍后会自动重试。");
});

const source = readFileSync(new URL("../web/src/components/WebChat.vue", import.meta.url), "utf8");

it("compiles its template", () => {
  const { descriptor } = parse(source);
  const result = compileTemplate({ source: descriptor.template!.content, filename: "WebChat.vue", id: "web-chat" });
  expect(result.errors).toEqual([]);
});

type View = {
  draft: vue.Ref<string>;
  files: vue.Ref<Array<{ id: string; name: string; kind: string }>>;
  uploadAvailable: vue.Ref<boolean>;
  fileUploads: vue.Ref<boolean>;
  previews: Map<string, string>;
  viewing: vue.Ref<unknown>;
  uploading: vue.Ref<boolean>;
  selectFiles(event: Event): Promise<void>;
  dragging: vue.Ref<boolean>;
  dragEnter(event: unknown): void;
  dragOver(event: unknown): void;
  dragLeave(event: unknown): void;
  drop(event: unknown): void;
  paste(event: unknown): void;
  keydown: (event: Partial<KeyboardEvent> & { preventDefault: () => void }) => void;
  submit: () => Promise<void>;
  state: ReturnType<typeof createWebChat>["state"];
  messages: vue.ComputedRef<{ text: string }[]>;
  rows: vue.ComputedRef<{ message: { id: string }; first: boolean; last: boolean; stamp: string }[]>;
  time: (value: number) => string;
};

function mount(
  request: (path: string, body?: unknown, options?: RequestOptions) => Promise<unknown>,
  topic: { data?: ChatSnapshot; unavailable?: boolean } = {},
  globals: Record<string, unknown> = {},
) {
  const { descriptor } = parse(source);
  const code = ts.transpileModule(compileScript(descriptor, { id: "web-chat" }).content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const topicState = vue.reactive({ data: topic.data, unavailable: topic.unavailable ?? false });
  const unmount: Array<() => void> = [];
  let nextToast = 0;
  const notices = new Map<number, string>();
  const toast = vi.fn((text: string) => {
    notices.set(++nextToast, text);
    return nextToast;
  });
  const dismissToast = vi.fn((id: number) => {
    notices.delete(id);
  });
  const imports: Record<string, unknown> = {
    vue: { ...vue, onMounted: () => {}, onBeforeUnmount: (fn: () => void) => unmount.push(fn) },
    "../lib/format": { formatTime, formatBytes },
    "../lib/talk": { webTitle: (item: { id: string; title: string }) => (item.id ? item.title || "新对话" : "全局大脑") },
    "../lib/use-topic": { useTopic: () => topicState },
    "../lib/web-persona": { useWebPersona: () => ({ bot: vue.computed(() => ({ name: "千早爱音" })) }) },
    "../shell/BotAvatar.vue": { default: {} },
    "../shell/Icon.vue": { default: {} },
    "../shell/bot-identity": { injectBotIdentity: () => vue.computed(() => ({ name: "千早爱音" })), botIdentityKey: Symbol("bot-identity") },
    "../lib/api": { api: request, ApiError },
    "../lib/dialog": { confirmDialog: async () => true },
    "../lib/plugin-config": { flattenPlugins: () => [] },
    "../lib/toast": { toast, dismissToast },
    "../state/accounts-health": { relativeTime: () => "" },
    "../state/web-chat": { createWebChat: () => createWebChat(request as never) },
    "./ChatMarkdown.vue": { default: {} },
    "./ChatAttachments.vue": { default: {} },
    "./AttachmentViewer.vue": { default: {} },
    "./PickerMenu.vue": { default: {} },
    "reicon-vue": { ArrowDown: {}, Loader: {}, Microphone: {}, Add: {}, Stars: {}, Stop: {} },
    "../lib/voice-input": { useVoiceInput },
  };
  const module = { exports: {} as { default: { setup: (props: unknown, context: unknown) => Record<string, unknown> } } };
  runInNewContext(code, { module, exports: module.exports, clearTimeout, setInterval, clearInterval, ...globals, require: (name: string) => imports[name] });
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} })) as unknown as View;
  return {
    view,
    topicState,
    toast,
    notices,
    dismissToast,
    dispose() {
      unmount.splice(0).forEach((fn) => fn());
      scope.stop();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fileSelection(names = ["notes.txt"]) {
  const input = { value: names.join(","), files: names.map((name) => new File(["hello attachment"], name, { type: "text/plain" })) };
  return { input, event: { target: input } as unknown as Event };
}

it.each(["unavailable", "changing", "uploading", "disconnected", "disposed"] as const)("ignores a late attachment selection while %s", async (blocked) => {
  const request = vi.fn(async () => ({ id: "upload", name: "notes.txt", kind: "file" }));
  const c = mount(request, { data: snapshot([]) });
  c.view.uploadAvailable.value = c.view.fileUploads.value = blocked !== "disconnected";
  if (blocked === "disposed") c.dispose();
  else if (blocked === "uploading") c.view.uploading.value = true;
  else if (blocked !== "disconnected") c.view.state[blocked] = true;
  const selected = fileSelection();
  await c.view.selectFiles(selected.event);
  expect(selected.input.value).toBe(blocked === "uploading" ? "notes.txt" : "");
  expect(request).not.toHaveBeenCalled();
  expect(c.view.files.value).toEqual([]);
  expect(c.toast).not.toHaveBeenCalled();
  c.dispose();
});

it("uploads a native 43-byte File without FileReader or a client-side base64 conversion", async () => {
  const bytes = new Uint8Array(43).fill(97);
  const nativeFile = new File([bytes], "Safari + 附件?.txt", { type: "text/plain" });
  const fetcher = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.body).toBe(nativeFile);
    expect(new Uint8Array(await (init!.body as Blob).arrayBuffer())).toEqual(bytes);
    return new Response(JSON.stringify({ id: "native-upload", name: nativeFile.name, kind: "file" }));
  });
  const c = mount((path, body, options) => api(path, body, options, fetcher), { data: snapshot([]) }, { FileReader: undefined });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    const input = { value: nativeFile.name, files: [nativeFile] };
    await c.view.selectFiles({ target: input } as unknown as Event);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `/yesimbot/api/v1/chat/uploads?name=${encodeURIComponent(nativeFile.name)}`,
      expect.objectContaining({ method: "POST", body: nativeFile, headers: { Accept: "application/json", "Content-Type": "application/octet-stream" } }),
    );
    expect(c.view.files.value).toEqual([{ id: "native-upload", name: nativeFile.name, kind: "file" }]);
    expect(input.value).toBe("");
    expect(c.toast).not.toHaveBeenCalled();
  } finally {
    c.dispose();
  }
});

it("keeps the native file selection valid until the sequential upload batch settles", async () => {
  const selected = fileSelection(["first.txt", "second.txt"]);
  const first = deferred<{ id: string; name: string; kind: string }>();
  const second = deferred<{ id: string; name: string; kind: string }>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    const uploading = c.view.selectFiles(selected.event);
    expect(selected.input.value).toBe("first.txt,second.txt");
    await c.view.selectFiles(selected.event);
    expect(request).toHaveBeenCalledOnce();
    expect(selected.input.value).toBe("first.txt,second.txt");
    first.resolve({ id: "first", name: "first.txt", kind: "file" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(selected.input.value).toBe("first.txt,second.txt");
    expect(request.mock.calls[1]).toEqual(["/yesimbot/api/v1/chat/uploads?name=second.txt", undefined, { rawBody: selected.input.files[1] }]);
    second.resolve({ id: "second", name: "second.txt", kind: "file" });
    await uploading;
    expect(c.view.files.value.map((file) => file.name)).toEqual(["first.txt", "second.txt"]);
    expect(selected.input.value).toBe("");
    expect(c.toast).not.toHaveBeenCalled();
  } finally {
    c.dispose();
  }
});

it("serializes attachment selections and keeps earlier successful files when a later upload fails", async () => {
  const first = deferred<{ id: string; name: string; kind: string }>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockRejectedValueOnce(new Error("offline"));
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    const uploading = c.view.selectFiles(fileSelection(["first.txt", "second.txt"]).event);
    await vue.nextTick();
    expect(c.view.uploading.value).toBe(true);
    await c.view.selectFiles(fileSelection(["duplicate.txt"]).event);
    expect(request).toHaveBeenCalledTimes(1);
    first.resolve({ id: "first", name: "first.txt", kind: "file" });
    await uploading;
    expect(request).toHaveBeenCalledTimes(2);
    expect(c.view.files.value).toEqual([{ id: "first", name: "first.txt", kind: "file" }]);
    expect(c.view.uploading.value).toBe(false);
    expect(c.toast).toHaveBeenCalledOnce();
  } finally {
    c.dispose();
  }
});

it("clears only the uploader's previous network error when a valid retry starts", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ id: "retry", name: "notes.txt", kind: "file" });
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    const unrelated = c.toast("其他操作已保存");
    await c.view.selectFiles(fileSelection().event);
    const previous = [...c.notices.keys()].at(-1)!;
    expect(c.notices.size).toBe(2);
    const retrying = c.view.selectFiles(fileSelection().event);
    expect(c.dismissToast).toHaveBeenCalledExactlyOnceWith(previous);
    expect([...c.notices.entries()]).toEqual([[unrelated, "其他操作已保存"]]);
    await retrying;
    expect(c.view.files.value).toEqual([{ id: "retry", name: "notes.txt", kind: "file" }]);
    expect([...c.notices.entries()]).toEqual([[unrelated, "其他操作已保存"]]);
  } finally {
    c.dispose();
  }
});

it.each(["too_many", "empty", "oversized"])("keeps one uploader error for %s files, clears it on retry and disposes only its own toast", async (reason) => {
  const request = vi.fn(async () => ({ id: "upload", name: "notes.txt", kind: "file" }));
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    const unrelated = c.toast("其他操作已保存");
    const selected = fileSelection(reason === "too_many" ? Array.from({ length: 9 }, (_, i) => `${i}.txt`) : ["invalid.txt"]);
    if (reason !== "too_many") selected.input.files[0] = new File(reason === "empty" ? [] : [new Uint8Array(181 * 1024)], "invalid.txt");
    await c.view.selectFiles(selected.event);
    expect(request).not.toHaveBeenCalled();
    expect(selected.input.value).toBe("");
    const previous = [...c.notices.keys()].at(-1)!;
    await c.view.selectFiles(selected.event);
    expect(c.dismissToast).toHaveBeenCalledExactlyOnceWith(previous);
    expect(c.notices.size).toBe(2);
    const retrying = c.view.selectFiles(fileSelection().event);
    expect([...c.notices.entries()]).toEqual([[unrelated, "其他操作已保存"]]);
    await retrying;
    expect(request).toHaveBeenCalledOnce();
    await c.view.selectFiles(selected.event);
    expect(c.notices.size).toBe(2);
    c.dispose();
    expect([...c.notices.entries()]).toEqual([[unrelated, "其他操作已保存"]]);
    expect(c.dismissToast.mock.calls.flat()).not.toContain(unrelated);
  } finally {
    c.dispose();
  }
});

it.each(["channel", "id", "session"] as const)("does not attach an old batch after the conversation %s changes during upload", async (field) => {
  const response = deferred<{ id: string; name: string; kind: string }>();
  const request = vi.fn(() => response.promise);
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    c.view.draft.value = "保留的文本草稿";
    c.view.files.value = [{ id: "existing", name: "existing.txt", kind: "file" }];
    const uploading = c.view.selectFiles(fileSelection(["old.txt", "not-started.txt"]).event);
    await vue.nextTick();
    const current = c.view.state.snapshot!;
    c.view.state.snapshot = { ...current, conversation: { ...current.conversation, [field]: "another" } };
    response.resolve({ id: "old", name: "old.txt", kind: "file" });
    await uploading;
    expect(request).toHaveBeenCalledOnce();
    expect(c.view.files.value).toEqual([{ id: "existing", name: "existing.txt", kind: "file" }]);
    expect(c.view.draft.value).toBe("保留的文本草稿");
    expect(c.view.uploading.value).toBe(false);
    expect(c.toast).not.toHaveBeenCalled();
  } finally {
    c.dispose();
  }
});

it.each(["success", "failure"] as const)("ignores an attachment upload's late %s after unmount", async (result) => {
  const response = deferred<{ id: string; name: string; kind: string }>();
  const c = mount(() => response.promise, { data: snapshot([]) });
  c.view.uploadAvailable.value = c.view.fileUploads.value = true;
  const uploading = c.view.selectFiles(fileSelection().event);
  await vue.nextTick();
  c.dispose();
  if (result === "success") response.resolve({ id: "late", name: "late.txt", kind: "file" });
  else response.reject(new Error("offline"));
  await uploading;
  expect(c.view.files.value).toEqual([]);
  expect(c.toast).not.toHaveBeenCalled();
});

it("does not restore a partially uploaded batch after switching away and back to its conversation", async () => {
  const second = deferred<{ id: string; name: string; kind: string }>();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ id: "first", name: "first.txt", kind: "file" })
    .mockImplementationOnce(() => second.promise);
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    const uploading = c.view.selectFiles(fileSelection(["first.txt", "second.txt", "not-started.txt"]).event);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const original = c.view.state.snapshot!;
    c.view.state.snapshot = { ...original, conversation: { ...original.conversation, id: "another" } };
    c.view.state.snapshot = original;
    second.resolve({ id: "second", name: "second.txt", kind: "file" });
    await uploading;
    expect(request).toHaveBeenCalledTimes(2);
    expect(c.view.files.value).toEqual([]);
    expect(c.toast).not.toHaveBeenCalled();
  } finally {
    c.dispose();
  }
});

it("sends with Enter, keeps Shift+Enter and input-method Enter for typing, and never refills the input after a send", async () => {
  const calls: unknown[] = [];
  let fail = false;
  const { view } = mount(
    async (path, body) => {
      if (path.endsWith("/send")) {
        calls.push(body);
        if (fail) throw new ApiError(503, "runtime_not_ready");
        return { messageId: `m${calls.length}` };
      }
      return snapshot([]);
    },
    { data: snapshot([]) },
  );
  const press = (init: Partial<KeyboardEvent>) => {
    const preventDefault = vi.fn();
    view.keydown({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...init, preventDefault });
    return preventDefault;
  };
  view.draft.value = "第一行";
  expect(press({ shiftKey: true })).not.toHaveBeenCalled();
  expect(press({ isComposing: true })).not.toHaveBeenCalled();
  expect(press({ keyCode: 229 })).not.toHaveBeenCalled();
  expect(calls).toEqual([]);

  expect(press({})).toHaveBeenCalled();
  // Cleared before the server has answered.
  expect(view.draft.value).toBe("");
  await flush();
  expect(calls).toHaveLength(1);

  fail = true;
  view.draft.value = "这条会失败";
  await view.submit();
  expect(view.draft.value).toBe("");
  expect(view.messages.value.at(-1)).toMatchObject({ text: "这条会失败", status: "failed" });
});

it("clears the input at once while the request is still pending, and typing the next message is not blocked", async () => {
  let answer!: (value: unknown) => void;
  const { view } = mount((path) => (path.endsWith("/send") ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(snapshot([]))), {
    data: snapshot([]),
  });
  view.draft.value = "在吗";
  void view.submit();
  expect(view.draft.value).toBe("");
  expect(view.messages.value.at(-1)).toMatchObject({ text: "在吗", status: "sent" });
  view.draft.value = "再问一句";
  expect(view.draft.value).toBe("再问一句");
  await flush();
  answer({ messageId: "m1" });
  await flush();
  expect(view.draft.value).toBe("再问一句");
});

it("follows the live topic and marks the chat unavailable only while there is no snapshot", async () => {
  const { view, topicState } = mount(async () => snapshot([]), { unavailable: true });
  expect(view.state.unavailable).toBe(true);
  topicState.data = snapshot([{ id: "x", role: "bot", text: "上线了", at: 3 }]);
  topicState.unavailable = false;
  await vue.nextTick();
  expect(view.state.unavailable).toBe(false);
  expect(view.messages.value.map((message) => message.text)).toEqual(["上线了"]);
});

it("groups one side's messages within five minutes and puts a centred time at each new day and after fifteen quiet minutes", () => {
  const now = new Date();
  const today = (h: number, m: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime();
  const earlier = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3, 9, 0).getTime();
  const { view } = mount(async () => snapshot([]), {
    data: snapshot([
      { id: "old", role: "user", text: "前几天", at: earlier },
      { id: "u1", role: "user", text: "在吗", at: today(0, 10) },
      { id: "b1", role: "bot", text: "在", at: today(0, 11) },
      { id: "b2", role: "bot", text: "怎么了", at: today(0, 12) },
      { id: "b3", role: "bot", text: "过了十四分钟", at: today(0, 26) },
      { id: "b4", role: "bot", text: "又过了十五分钟", at: today(0, 41) },
    ]),
  });
  const day = new Date(earlier);
  const label = `${day.getMonth() + 1} 月 ${day.getDate()} 日`;
  expect(view.rows.value.map((row) => [row.message.id, row.first, row.last, row.stamp])).toEqual([
    ["old", true, true, `${day.getFullYear() === now.getFullYear() ? label : `${day.getFullYear()} 年 ${label}`} 09:00`],
    ["u1", true, true, "今天 00:10"],
    ["b1", true, false, ""],
    ["b2", false, true, ""],
    ["b3", true, true, ""],
    ["b4", true, true, "00:41"],
  ]);
  expect(view.time(today(0, 12))).toBe("00:12");
});

it("ignores an old-session snapshot arriving after a new web conversation", () => {
  const chat = createWebChat();
  const old = snapshot([{ id: "old", role: "bot", text: "旧会话", at: 1 }], true);
  chat.accept(old);
  chat.accept({ ...snapshot([]), conversation: { ...old.conversation, session: "20261112T120000Z.jsonl" } });
  chat.accept(old);
  expect(chat.messages.value).toEqual([]);
  expect(chat.typing.value).toBe(false);
  expect(chat.state.snapshot?.conversation.session).toBe("20261112T120000Z.jsonl");
});

// ---------- Dropping and pasting files ----------
function dragEvent(types: string[], files: File[] = []) {
  const dataTransfer = { types, files, dropEffect: "" };
  return { dataTransfer, preventDefault: vi.fn() };
}
const upload = (name: string) => ({ id: `id-${name}`, name, kind: "file" });

it("uploads dropped files through the same path as the file input, ending the drop state", async () => {
  const request = vi.fn(async (path: string) => upload(decodeURIComponent(path.split("name=")[1]!)));
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    const files = [new File(["a"], "one.txt"), new File(["b"], "two.png")];
    const enter = dragEvent(["Files"]);
    c.view.dragEnter(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(c.view.dragging.value).toBe(true);
    const over = dragEvent(["Files"]);
    c.view.dragOver(over);
    expect(over.dataTransfer.dropEffect).toBe("copy");
    const dropped = dragEvent(["Files"], files);
    c.view.drop(dropped);
    expect(dropped.preventDefault).toHaveBeenCalled();
    expect(c.view.dragging.value).toBe(false);
    await vi.waitFor(() => expect(c.view.files.value.map((file) => file.name)).toEqual(["one.txt", "two.png"]));
    expect(request.mock.calls).toEqual([
      ["/yesimbot/api/v1/chat/uploads?name=one.txt", undefined, { rawBody: files[0] }],
      ["/yesimbot/api/v1/chat/uploads?name=two.png", undefined, { rawBody: files[1] }],
    ]);
    expect(c.toast).not.toHaveBeenCalled();
  } finally {
    c.dispose();
  }
});

it("keeps the drop state across child elements with a depth counter and ignores drags that carry no files", async () => {
  const request = vi.fn();
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    c.view.dragEnter(dragEvent(["Files"]));
    c.view.dragEnter(dragEvent(["Files"]));
    c.view.dragLeave(dragEvent(["Files"]));
    expect(c.view.dragging.value).toBe(true);
    c.view.dragLeave(dragEvent(["Files"]));
    expect(c.view.dragging.value).toBe(false);

    for (const types of [["text/plain"], ["text/uri-list", "text/html"], []]) {
      const enter = dragEvent(types),
        over = dragEvent(types),
        dropped = dragEvent(types, [new File(["x"], "x.txt")]);
      c.view.dragEnter(enter);
      c.view.dragOver(over);
      expect(c.view.dragging.value).toBe(false);
      c.view.drop(dropped);
      for (const event of [enter, over, dropped]) expect(event.preventDefault).not.toHaveBeenCalled();
      expect(over.dataTransfer.dropEffect).toBe("");
    }
    expect(request).not.toHaveBeenCalled();
    expect(c.toast).not.toHaveBeenCalled();
  } finally {
    c.dispose();
  }
});

it("refuses a drop while uploads are unavailable: no upload, an explaining error, dropEffect none", async () => {
  const request = vi.fn();
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = false;
    const over = dragEvent(["Files"]);
    c.view.dragOver(over);
    expect(over.dataTransfer.dropEffect).toBe("none");
    c.view.drop(dragEvent(["Files"], [new File(["a"], "one.txt")]));
    expect(request).not.toHaveBeenCalled();
    expect(c.view.files.value).toEqual([]);
    expect(c.toast).toHaveBeenCalledExactlyOnceWith("现在不能上传：机器人还没准备好，请稍后再试。", "danger");
    expect(c.view.dragging.value).toBe(false);
  } finally {
    c.dispose();
  }
});

it("does not accept a drop while a batch is uploading (dropEffect none, nothing queued)", async () => {
  const first = deferred<ReturnType<typeof upload>>();
  const request = vi.fn(() => first.promise);
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    const uploading = c.view.selectFiles(fileSelection(["a.txt"]).event);
    const over = dragEvent(["Files"]);
    c.view.dragOver(over);
    expect(over.dataTransfer.dropEffect).toBe("none");
    c.view.drop(dragEvent(["Files"], [new File(["b"], "b.txt")]));
    expect(request).toHaveBeenCalledOnce();
    first.resolve(upload("a.txt"));
    await uploading;
    expect(c.view.files.value.map((file) => file.name)).toEqual(["a.txt"]);
  } finally {
    c.dispose();
  }
});

it("applies the same limits to dropped files as to selected ones", async () => {
  const request = vi.fn(async () => upload("x"));
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    c.view.drop(
      dragEvent(
        ["Files"],
        Array.from({ length: 9 }, (_, i) => new File(["x"], `${i}.txt`)),
      ),
    );
    c.view.drop(dragEvent(["Files"], [new File([], "empty.txt")]));
    await vue.nextTick();
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(c.toast).toHaveBeenCalledTimes(2);
  } finally {
    c.dispose();
  }
});

it("uploads files pasted into the textarea and leaves plain-text paste alone", async () => {
  const request = vi.fn(async () => upload("image.png"));
  const c = mount(request, { data: snapshot([]) });
  try {
    c.view.uploadAvailable.value = c.view.fileUploads.value = true;
    const text = { clipboardData: { files: [], types: ["text/plain"] }, preventDefault: vi.fn() };
    c.view.paste(text);
    c.view.paste({ clipboardData: null, preventDefault: text.preventDefault });
    expect(text.preventDefault).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    const image = new File(["png"], "image.png", { type: "image/png" });
    const pasted = { clipboardData: { files: [image], types: ["Files"] }, preventDefault: vi.fn() };
    c.view.paste(pasted);
    expect(pasted.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(c.view.files.value).toEqual([upload("image.png")]));
    expect(request).toHaveBeenCalledExactlyOnceWith("/yesimbot/api/v1/chat/uploads?name=image.png", undefined, { rawBody: image });
  } finally {
    c.dispose();
  }
});

it("sends a pasted image without a computer, but explains that another file needs one", async () => {
  const request = vi.fn(async () => ({ id: "id-image", name: "image.png", kind: "image" }));
  const created: Blob[] = [];
  const c = mount(
    request,
    { data: snapshot([]) },
    { URL: { createObjectURL: (blob: Blob) => (created.push(blob), "blob:preview"), revokeObjectURL: vi.fn() } },
  );
  try {
    c.view.uploadAvailable.value = true;
    c.view.fileUploads.value = false;
    const pdf = { clipboardData: { files: [new File(["%PDF"], "notes.pdf")], types: ["Files"] }, preventDefault: vi.fn() };
    c.view.paste(pdf);
    await flush();
    expect(pdf.preventDefault).toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(c.toast).toHaveBeenCalledWith(expect.stringContaining("先连接"), "danger");
    const image = new File(["png"], "image.png", { type: "image/png" });
    c.view.paste({ clipboardData: { files: [image], types: ["Files"] }, preventDefault: vi.fn() });
    await vi.waitFor(() => expect(c.view.files.value).toEqual([{ id: "id-image", name: "image.png", kind: "image" }]));
    // The composer shows the image itself, from the browser's own copy.
    expect(created).toEqual([image]);
    expect(c.view.previews.get("id-image")).toBe("blob:preview");
  } finally {
    c.dispose();
  }
});

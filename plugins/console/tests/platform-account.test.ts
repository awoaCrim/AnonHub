import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import { PLATFORMS } from "@yesimbot/contracts/platforms";
import * as reicon from "reicon-vue";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import { type api } from "../web/src/lib/api";
import * as pluginConfig from "../web/src/lib/plugin-config";
import * as autosave from "../web/src/state/autosave";
import * as fields from "../web/src/state/config-fields";
import { ui } from "./fixtures/ui";

interface ListDefinition {
  field: "allowedRooms" | "allowedPeers";
}
interface Bindings {
  editor: ReturnType<typeof fields.createConfigFieldsEditor>;
  autosave: ReturnType<typeof autosave.createAutosave>;
  LISTS: ListDefinition[];
  drafts: Record<string, string>;
  problems: Record<string, string>;
  add(list: ListDefinition): void;
  remove(list: ListDefinition, id: string): void;
  commit(label: string, changes: autosave.Change[]): void;
  toggle(): Promise<void>;
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function harness(platform = "wechat-bridge") {
  const unmount: (() => void)[] = [];
  const config = {
    allowedRooms: ["1@chatroom"],
    allowedPeers: ["wxid_a"],
    autoReply: { group: false, direct: true },
    endpoint: "http://127.0.0.1:6174",
    secret: { $secret: true },
  };
  const request = vi.fn(async (_path: string, body?: { config?: Record<string, unknown> }) =>
    body ? { revision: `r${request.mock.calls.length}` } : { config: structuredClone(config), revision: "r0" },
  );
  const api = vi.fn(async () => ({ path: "adapter-wechat-bridge:w" }));
  const toast = vi.fn();
  const props = vue.reactive({
    platform: PLATFORMS.find((item) => item.id === platform)!,
    entries: [{ path: "adapter-wechat-bridge:w", key: "w", name: "adapter-wechat-bridge", label: "", enabled: true, group: false, status: "active" }],
    adapters: [],
    writable: true,
  });
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/PlatformAccount.vue", import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: "platform-account" });
  const transpile = (source: string) =>
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => Bindings } } };
  runInNewContext(transpile(script.content), {
    module,
    exports: module.exports,
    require: (name: string) =>
      ({
        vue: { ...vue, onBeforeUnmount: (fn: () => void) => unmount.push(fn) },
        "reicon-vue": reicon,
        "../context": { useSession: () => ({ state: { features: { wechat: true } } }) },
        "../lib/api": { api },
        "../lib/dialog": { confirmDialog: async () => true },
        "../lib/plugin-config": pluginConfig,
        "../lib/toast": { toast, toastErrors() {} },
        "../pages/platforms-model": { ADAPTER_STATE: {}, platformTone: () => "idle" },
        "../state/autosave": autosave,
        "../state/config-fields": {
          createConfigFieldsEditor: (keys: string[]) => fields.createConfigFieldsEditor(keys, { request: request as unknown as typeof api }),
          readPath: fields.readPath,
        },
        "./PickerMenu.vue": { default: {} },
        "./WechatLogin.vue": { default: vue.defineComponent({ setup: () => () => vue.h("div", "WECHAT-LOGIN") }) },
      })[name] ?? ui(name),
  });
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: "PlatformAccount.vue",
    id: "platform-account",
    compilerOptions: { bindingMetadata: script.bindings },
  });
  expect(template.errors).toEqual([]);
  const renderModule = { exports: {} as { render: (...args: unknown[]) => vue.VNode } };
  runInNewContext(transpile(template.code), { module: renderModule, exports: renderModule.exports, require: () => vue });
  const scope = vue.effectScope();
  const state = scope.run(() => module.exports.default.setup(props, { expose() {}, emit() {} }))!;
  cleanups.push(() => {
    unmount.forEach((fn) => fn());
    scope.stop();
  });
  await vi.waitFor(() => expect(state.editor.state.config).toBeDefined());
  const writes = () => request.mock.calls.filter((call) => call[1]).map((call) => call[1]!.config!);
  const idle = () => vi.waitFor(() => expect(state.autosave.saving.value).toBe(false));
  return {
    state,
    api,
    toast,
    writes,
    idle,
    config,
    render: () => renderToString(vue.createSSRApp({ render: () => renderModule.exports.render({}, [], props, vue.proxyRefs(state as object)) })),
  };
}

it("lists WeChat's chats with their auto-reply in place, without a save bar or a form behind a row", async () => {
  const h = await harness();
  const html = await h.render();
  for (const text of ["群聊", "私聊", "自动回复", "1@chatroom", "wxid_a", "添加群聊", "添加私聊", "WECHAT-LOGIN"]) expect(html).toContain(text);
  expect(html).not.toContain("账号设置");
  expect(html).not.toContain("<textarea");
  expect(html).not.toMatch(/保存|放弃/);
});

it("adds and removes a chat at once, keeps other settings and secrets, and offers 撤销", async () => {
  const h = await harness();
  const [rooms, peers] = h.state.LISTS;
  h.state.drafts.allowedRooms = " 2@chatroom ";
  h.state.add(rooms!);
  expect(h.state.drafts.allowedRooms).toBe("");
  await h.idle();
  expect(h.writes()).toEqual([{ ...h.config, allowedRooms: ["1@chatroom", "2@chatroom"] }]);
  const [text, , , action] = h.toast.mock.calls.at(-1)!;
  expect([text, action.label]).toEqual(["已保存：添加 2@chatroom", "撤销"]);
  action.run();
  await h.idle();
  expect(h.writes().at(-1)).toEqual(h.config);

  h.state.remove(peers!, "wxid_a");
  await h.idle();
  expect(h.writes().at(-1)).toEqual({ ...h.config, allowedPeers: [] });
});

it("refuses an ID that does not belong in the list and says why", async () => {
  const h = await harness();
  const [rooms, peers] = h.state.LISTS;
  for (const [list, id, problem] of [
    [rooms!, "wxid_b", "群聊 ID 以 @chatroom 结尾。"],
    [rooms!, "1@chatroom", "已在列表中。"],
    [peers!, "3@chatroom", "这是群聊 ID，请添加到群聊。"],
    [peers!, "wxid b", "ID 不能含空格。"],
  ] as const) {
    h.state.drafts[list.field] = id;
    h.state.add(list);
    expect(h.state.problems[list.field]).toBe(problem);
    expect(h.state.drafts[list.field]).toBe(id);
  }
  expect(h.writes()).toEqual([]);
});

it("saves an auto-reply switch at once", async () => {
  const h = await harness();
  h.state.commit("群聊自动回复", [[["autoReply", "group"], true]]);
  await h.idle();
  expect(h.writes()).toEqual([{ ...h.config, autoReply: { group: true, direct: true } }]);
  expect(h.toast.mock.calls.at(-1)![0]).toBe("已保存：群聊自动回复");
});

it("turns the connection off with the config's revision", async () => {
  const h = await harness();
  await h.state.toggle();
  expect(h.api).toHaveBeenCalledWith("/yesimbot/api/v1/plugins/enabled", { path: "adapter-wechat-bridge:w", revision: "r0", enabled: false });
  expect(h.toast).toHaveBeenCalledWith("连接已停用");
});

it("shows another platform's account without editable fields", async () => {
  const h = await harness("onebot");
  const html = await h.render();
  expect(html).not.toContain("添加群聊");
  expect(html).not.toContain("账号设置");
  expect(html).toContain("连接");
});

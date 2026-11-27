import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import { editorValue } from "../web/src/lib/editor-value";
import { flattenPlugins, pluginError } from "../web/src/lib/plugin-config";

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);

function component(file: string) {
  const { descriptor } = parse(readFileSync(new URL(`../web/src/${file}`, import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: file });
  expect(compileTemplate({ source: descriptor.template!.content, filename: file, id: file }).errors).toEqual([]);
  // oxlint-disable-next-line typescript/no-explicit-any
  const module = { exports: {} as { default: { setup(...args: unknown[]): Record<string, any> } } };
  const dispose: Array<() => void> = [];
  const document = { querySelector: vi.fn((): object | null => null), removeEventListener() {} };
  const accountState = vue.reactive({
    busy: false,
    accounts: [],
    error: "",
    notice: "",
    share: null,
    pluginsId: "",
    pluginsDraft: [],
    resetId: "",
    resetPassword: "",
  });
  const accountView = { state: accountState, refresh() {}, dispose() {} };
  const models = { view: {}, state: vue.reactive({ draft: { roles: { chatModel: "" } } }), dirty: vue.ref(false), editable: vue.ref(true) };
  const defaults = { state: vue.reactive({ saved: {}, value: {}, config: {}, busy: false }), load() {}, dispose() {} };
  const confirmDiscard = vi.fn(async () => true);
  const request = vi.fn(async () => ({ revision: "r1", config: { selfId: "account" } }));
  const props = vue.reactive({
    account: { id: "friend", username: "friend", plugins: [] },
    view: accountView,
    platform: { id: "wechat-bridge", label: "微信", login: "device" },
    entries: [{ path: "adapter", enabled: true }],
    adapters: [],
    writable: true,
  });
  const imports: Record<string, unknown> = {
    vue: {
      ...vue,
      inject: () => models,
      onMounted() {},
      onActivated() {},
      onDeactivated() {},
      onBeforeUnmount: (fn: () => void) => dispose.push(fn),
    },
    "../context": { useSession: () => ({ state: { role: "owner", features: { accounts: true } } }) },
    "../lib/api": { api: request },
    "../lib/cache": { onCacheRefresh: () => () => {} },
    "../lib/dialog": { confirmDiscard },
    "../lib/devices": { isWorkspaceDevice: () => true },
    "../lib/editor-guard": { trackEditor() {} },
    "../lib/editor-value": { editorValue },
    "../lib/plugin-config": { flattenPlugins, pluginError },
    "../lib/route-state": { useRouteState: (_key: string, fallback: string) => vue.ref(fallback) },
    "../lib/toast": { toastErrors() {}, toastNotices() {} },
    "../lib/use-topic": { useTopic: () => ({ data: { tree: [] } }) },
    "../shell/page-crumb": { usePageCrumb() {} },
    "../state/accounts-state": { createAccountsState: () => accountView },
    "../state/config-fields": { createConfigFieldsEditor: () => defaults },
    "../../state/models-page": { MODELS_PAGE: Symbol("models") },
  };
  runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module,
    exports: module.exports,
    document,
    clearTimeout,
    require: (name: string) => imports[name] ?? { default: {} },
  });
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup(props, { expose() {} }))!;
  cleanups.push(() => {
    dispose.splice(0).forEach((fn) => fn());
    scope.stop();
  });
  return { view, props, document, request, confirmDiscard };
}

const cases = [
  { name: "create friend", file: "pages/Friends.vue", open: "openCreate", state: "creating", restore: "restoreCreateFocus" },
  { name: "friend grants", file: "components/AccountDetail.vue", open: "openPlugins", accountState: "pluginsId", restore: "restoreDialogFocus" },
  { name: "reset friend password", file: "components/AccountDetail.vue", open: "openReset", accountState: "resetId", restore: "restoreDialogFocus" },
  { name: "manage friend", file: "components/AccountDetail.vue", open: "openManagement", state: "managementOpen", restore: "restoreDialogFocus" },
];

it.each(cases)("returns the $name dialog to its mouse-clicked entry only when the entry remains available", (item) => {
  const h = component(item.file);
  let disabled = false;
  const target = { isConnected: true, matches: vi.fn(() => disabled), focus: vi.fn() };
  const click = { currentTarget: target };
  const close = { preventDefault: vi.fn() };
  if (item.detail) {
    h.view.devices.value = [{ deviceId: "computer" }];
    h.view[item.open]("computer", click);
  } else h.view[item.open](click);
  h.view[item.restore](close);
  expect(target.focus).not.toHaveBeenCalled();
  if (item.accountState) h.props.view.state[item.accountState as "pluginsId" | "resetId"] = "";
  else h.view[item.state!].value = item.detail ? "" : false;
  h.view[item.restore](close);
  expect(close.preventDefault).toHaveBeenCalled();
  expect(target.focus).toHaveBeenCalledOnce();
  disabled = true;
  h.view[item.restore](close);
  disabled = false;
  target.isConnected = false;
  h.view[item.restore](close);
  expect(target.focus).toHaveBeenCalledOnce();
});

it.each(cases)("does not steal focus from another open dialog after closing $name", (item) => {
  const h = component(item.file);
  const target = { isConnected: true, matches: () => false, focus: vi.fn() };
  if (item.detail) h.view[item.open]("computer", { currentTarget: target });
  else h.view[item.open]({ currentTarget: target });
  if (item.accountState) h.props.view.state[item.accountState as "pluginsId" | "resetId"] = "";
  else h.view[item.state!].value = item.detail ? "" : false;
  h.document.querySelector.mockReturnValue({});
  const event = { preventDefault: vi.fn() };
  h.view[item.restore](event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(target.focus).not.toHaveBeenCalled();
});

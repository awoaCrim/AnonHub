import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import { REPLY_TRIGGER_DEFAULTS, REPLY_TRIGGER_LABELS, REPLY_TRIGGER_PLATFORMS, type ReplyTriggerKey } from "@yesimbot/contracts/reply-triggers";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import { type api } from "../web/src/lib/api";
import * as pluginConfig from "../web/src/lib/plugin-config";
import * as autosave from "../web/src/state/autosave";
import * as fields from "../web/src/state/config-fields";
import { ui } from "./fixtures/ui";

interface Bindings {
  editor: ReturnType<typeof fields.createConfigFieldsEditor>;
  quiet: ReturnType<typeof fields.createConfigFieldsEditor>;
  busy: vue.ComputedRef<boolean>;
  select(platform: { id: string; label: string }): void;
  rule(key: ReplyTriggerKey, enabled: boolean): void;
  setDebounce(enabled: boolean): Promise<void>;
  setQuiet(event: Event): Promise<void>;
}

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function harness(options: { writable?: boolean; locked?: boolean } = {}) {
  const unmount: (() => void)[] = [];
  const config = { untouched: "preserved", replyTriggers: { platforms: ["onebot"], rules: { mention: false } } };
  const quietConfig = { quietSeconds: 10 };
  const request = vi.fn(async (path: string) => ({ config: path.includes("debounce") ? quietConfig : config, revision: "revision" }));
  const setFeatureEnabled = vi.fn(async () => ({ revision: "next" }));
  const plugins = vue.reactive({
    data: {
      revision: "plugins",
      writable: true,
      tree: [{ name: "yesimbot-message-debounce", path: "yesimbot-message-debounce:d", enabled: true, group: false }],
    },
  });
  const confirm = vi.fn(async () => true);
  const toast = vi.fn();
  const props = vue.reactive({ entry: { name: "yesimbot", path: "yesimbot:core", locked: options.locked }, writable: options.writable ?? true });
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/ReplyTriggers.vue", import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: "reply-triggers" });
  const transpile = (source: string) =>
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => Bindings } } };
  runInNewContext(transpile(script.content), {
    module,
    exports: module.exports,
    require: (name: string) =>
      ({
        vue: { ...vue, onBeforeUnmount: (fn: () => void) => unmount.push(fn) },
        "@yesimbot/contracts/reply-triggers": { REPLY_TRIGGER_DEFAULTS, REPLY_TRIGGER_LABELS, REPLY_TRIGGER_PLATFORMS },
        "../lib/dialog": { confirmDiscard: confirm },
        "../lib/editor-guard": { trackEditor() {} },
        "../lib/plugin-config": pluginConfig,
        "../lib/toast": { toast, toastErrors() {} },
        "../lib/features": { setFeatureEnabled },
        "../lib/use-topic": { useTopic: () => plugins.data && plugins },
        "../state/autosave": autosave,
        "../state/config-fields": {
          createConfigFieldsEditor: (keys: string[]) => fields.createConfigFieldsEditor(keys, { request: request as typeof api }),
          schemaDefault: fields.schemaDefault,
        },
        "../lib/api": { api: async () => ({ schema: { type: "object", dict: { quietSeconds: { type: "number", meta: { default: 15 } } } } }) },
      })[name] ?? ui(name),
  });
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: "ReplyTriggers.vue",
    id: "reply-triggers",
    compilerOptions: { bindingMetadata: script.bindings },
  });
  expect(template.errors).toEqual([]);
  const renderModule = { exports: {} as { render: (...args: unknown[]) => vue.VNode } };
  runInNewContext(transpile(template.code), { module: renderModule, exports: renderModule.exports, require: () => vue });
  const scope = vue.effectScope();
  const state = scope.run(() => module.exports.default.setup(props, { expose() {} }))!;
  cleanups.push(() => {
    unmount.forEach((fn) => fn());
    scope.stop();
  });
  await vi.waitFor(() => expect(state.editor.state.config).toBeDefined());
  const writes = () => request.mock.calls.filter((call) => (call as unknown[])[1]) as unknown as [string, { path: string; config: Record<string, unknown> }][];
  return {
    state,
    request,
    writes,
    config,
    props,
    plugins,
    setFeatureEnabled,
    confirm,
    toast,
    async render() {
      const context: { teleports?: Record<string, string> } = {};
      const app = vue.createSSRApp({ render: () => renderModule.exports.render({}, [], props, vue.proxyRefs(state as object)) });
      const list = await renderToString(app, context);
      return { list, dialog: context.teleports?.body ?? "" };
    },
  };
}

it("changes a rule or a platform in place, saves at once and offers 撤销", async () => {
  const h = await harness();
  const view = await h.render();
  for (const label of [...Object.values(REPLY_TRIGGER_LABELS), "QQ", "微信", "群聊合并等待"]) expect(view.list).toContain(label);
  expect(view.list).not.toMatch(/<(dialog|small|footer)[\s>]/);
  const key = Object.keys(REPLY_TRIGGER_DEFAULTS)[0] as ReplyTriggerKey;
  h.state.rule(key, true);
  await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
  await vi.waitFor(() => expect(h.state.busy.value).toBe(false));
  expect(h.writes()[0]).toEqual([
    "/yesimbot/api/v1/plugins/update",
    {
      path: "yesimbot:core",
      revision: "revision",
      config: { ...h.config, replyTriggers: { ...h.config.replyTriggers, rules: { mention: false, [key]: true } } },
    },
  ]);
  const [text, , , action] = h.toast.mock.calls.at(-1)!;
  expect([text, action.label]).toEqual([`已保存：${REPLY_TRIGGER_LABELS[key]}`, "撤销"]);
  action.run();
  await vi.waitFor(() => expect(h.writes()).toHaveLength(2));
  await vi.waitFor(() => expect(h.state.busy.value).toBe(false));
  expect(h.writes()[1][1].config.replyTriggers).toEqual(h.config.replyTriggers);
  h.state.select({ id: "wechat-bridge", label: "微信" });
  await vi.waitFor(() => expect(h.writes()).toHaveLength(3));
  expect(h.writes()[2][1].config.replyTriggers).toMatchObject({ platforms: ["onebot", "wechat-bridge"] });
});

it("turns the group wait on or off and saves its seconds in place", async () => {
  const h = await harness();
  await vi.waitFor(() => expect(h.state.quiet.state.config).toBeDefined());
  await vi.waitFor(() => expect(h.state.quietDefault.value).toBe("默认 15"));
  await h.state.setQuiet({ target: { value: "5" } } as unknown as Event);
  expect(h.writes().at(-1)).toEqual([
    "/yesimbot/api/v1/plugins/update",
    { path: "yesimbot-message-debounce:d", revision: "revision", config: { quietSeconds: 5 } },
  ]);
  await h.state.setDebounce(false);
  expect(h.setFeatureEnabled).toHaveBeenCalledWith("plugins", h.plugins.data.tree[0], false);
});

it.each([{ writable: false }, { locked: true }])("does not mutate or save read-only trigger rules: %j", async (options) => {
  const h = await harness(options);
  h.state.select({ id: "wechat-bridge", label: "微信" });
  h.state.rule(Object.keys(REPLY_TRIGGER_DEFAULTS)[0] as ReplyTriggerKey, true);
  await vue.nextTick();
  expect(h.state.editor.dirty.value).toBe(false);
  expect(h.writes()).toHaveLength(0);
});

it("uses the renamed core path after an external enable or disable without rereading", async () => {
  const h = await harness();
  h.request.mockClear();
  h.props.entry.path = "~yesimbot:core";
  await vue.nextTick();
  expect(h.request).not.toHaveBeenCalled();
  expect(h.state.editor.state.path).toBe("~yesimbot:core");
  h.state.select({ id: "wechat-bridge", label: "微信" });
  await vi.waitFor(() => expect(h.writes()).toHaveLength(1));
  expect(h.writes()[0][1]).toMatchObject({ path: "~yesimbot:core" });
});

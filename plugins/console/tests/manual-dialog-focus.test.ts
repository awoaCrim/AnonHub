import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import { ApiError } from "../web/src/lib/api";
import * as pluginConfig from "../web/src/lib/plugin-config";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function state<T>(file: string, props: Record<string, unknown>, imports: Record<string, unknown>) {
  const { descriptor } = parse(readFileSync(new URL(`../web/src/components/${file}.vue`, import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: file });
  expect(compileTemplate({ source: descriptor.template!.content, filename: `${file}.vue`, id: file }).errors).toEqual([]);
  const module = { exports: {} as { default: { setup(props: unknown, context: unknown): T } } };
  const unmount: Array<() => void> = [];
  const modules: Record<string, unknown> = {
    vue: {
      ...vue,
      onMounted() {},
      onBeforeUnmount: (callback: () => void) => unmount.push(callback),
      inject: (_key: unknown, fallback: unknown) => fallback,
    },
    "vue-router": { routeLocationKey: Symbol("route"), routerKey: Symbol("router"), onBeforeRouteUpdate() {} },
    "../lib/plugin-config": pluginConfig,
    "../lib/toast": { toast() {} },
    "../lib/editor-guard": { trackEditor() {} },
    ...imports,
  };
  runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    document: { visibilityState: "visible" },
    require: (name: string) => modules[name] ?? { default: {} },
  });
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup(props, { emit() {}, expose() {} }))!;
  const dispose = () => {
    unmount.splice(0).forEach((callback) => callback());
    scope.stop();
  };
  cleanups.push(dispose);
  return { view, dispose };
}

interface ExtensionView {
  busy: vue.Ref<boolean>;
  spec: vue.Ref<string>;
  installOpen: vue.Ref<boolean>;
  setInstallOpen(open: boolean): Promise<void>;
}

const extension = { name: "yesimbot-extension-example", version: "1.0.0", module: "example", status: "running" };
function extensions() {
  const request = vi.fn(async (_path: string, body?: unknown): Promise<unknown> => (body ? { ok: true } : { items: [extension] }));
  const confirmDiscard = vi.fn(async () => true);
  const h = state<ExtensionView>(
    "ExtensionsPanel",
    {},
    { "../lib/api": { api: request, ApiError }, "../lib/dialog": { confirmDiscard, confirmDialog: async () => true } },
  );
  return { ...h, request, confirmDiscard };
}

it("keeps the install page open while busy and clears a dirty one on close without asking", async () => {
  const h = extensions();
  await h.view.setInstallOpen(true);
  h.view.spec.value = "unfinished";
  h.view.busy.value = true;
  await h.view.setInstallOpen(false);
  expect(h.view.installOpen.value).toBe(true);
  h.view.busy.value = false;
  await h.view.setInstallOpen(false);
  expect(h.view.installOpen.value).toBe(false);
  expect(h.view.spec.value).toBe("");
  expect(h.confirmDiscard).not.toHaveBeenCalled();
});

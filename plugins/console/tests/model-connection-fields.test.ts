import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import type { ModelSettingsConnection } from "../src/model-settings-types";
import * as settings from "../web/src/state/model-settings-state";
import * as page from "../web/src/state/models-page";

interface Fields {
  changed(field: "baseURL" | "apiKey", label: string, event: Event): void;
  setMediaTypes(event: Event): void;
}

function connection(key: string, id: string): ModelSettingsConnection {
  return { key, id, enabled: true, type: "google", baseURL: "", hasApiKey: true, chatModels: [], embeddingModels: [], options: {} };
}

function editor() {
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/models/ConnectionEditor.vue", import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: "connection-editor" });
  const module = { exports: {} as { default: { setup(...args: unknown[]): Fields } } };
  const saved = connection("connection:0", "main");
  const state = vue.reactive({ draft: { connections: [saved], writable: true }, loading: false, saving: false });
  const creating = vue.ref<ModelSettingsConnection | undefined>(connection("new:1", "connection-1"));
  const setConnection = vi.fn(async () => true);
  const setOption = vi.fn(async () => true);
  const models = {
    view: {},
    state,
    selected: vue.computed(() => state.draft.connections[0]),
    creating,
    editable: vue.ref(true),
    tab: vue.ref("connection"),
    setConnection,
    setOption,
  };
  runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module,
    exports: module.exports,
    require: (name: string) =>
      ({
        vue: { ...vue, inject: () => models },
        "../../state/model-settings-state": settings,
        "../../state/models-page": page,
      })[name] ?? { default: {} },
  });
  const scope = vue.effectScope();
  const fields = scope.run(() => module.exports.default.setup({}, { expose() {} }))!;
  return { fields, saved, creating, setConnection, setOption, stop: () => scope.stop() };
}

const change = (value: string, key: string) => ({ target: { value, dataset: { connection: key } } }) as unknown as Event;

it("saves a field only to the service it was shown for, never to the one selected after its page closed", () => {
  const h = editor();
  try {
    // 添加服务 was closed with the key typed in: its late change event is dropped, not saved to the selected service.
    h.creating.value = undefined;
    h.fields.changed("apiKey", "API 密钥", change("typed-for-the-new-service", "new:1"));
    expect(h.setConnection).not.toHaveBeenCalled();
    h.fields.changed("apiKey", "API 密钥", change("  ", "connection:0"));
    expect(h.setConnection).not.toHaveBeenCalled();
    h.fields.changed("baseURL", "服务地址", change(" https://models.example/v1 ", "connection:0"));
    expect(h.setConnection).toHaveBeenCalledWith(h.saved, "服务地址", "baseURL", "https://models.example/v1");
    h.fields.setMediaTypes(change("image/png，image/webp", "connection:0"));
    expect(h.setOption).toHaveBeenCalledWith(h.saved, "图片结果格式", "imageToolResultMediaTypes", ["image/png", "image/webp"]);
  } finally {
    h.stop();
  }
});

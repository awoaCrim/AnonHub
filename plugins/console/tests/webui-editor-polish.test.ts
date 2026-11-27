import { expect, it } from "vitest";
import * as vue from "vue";

import type { ModelSettingsSnapshot } from "../src/model-settings-types";
import * as modelRoute from "../web/src/lib/model-route-state";
import { createModelSettingsState } from "../web/src/state/model-settings-state";
import { createModelsPage } from "../web/src/state/models-page";

it("模型刷新深链与浏览器查询变化恢复选择，且保留连接草稿", async () => {
  const connections = [
    { key: "a", id: "first", chatModels: [{ id: "chat-a" }, { id: "chat-b" }], embeddingModels: [{ id: "embed-a" }] },
    { key: "b", id: "draft-kept", chatModels: [{ id: "other" }], embeddingModels: [] },
  ];
  const state = vue.reactive({ draft: { connections, writable: true }, selectedKey: "a", busy: false });
  const query: Record<string, vue.Ref<string>> = {
    connection: vue.ref("a"),
    tab: vue.ref("chat"),
    chatModel: vue.ref("1:chat-b"),
    embeddingModel: vue.ref("0:embed-a"),
  };
  const scope = vue.effectScope();
  const routeState = (key: string, fallback: string) => query[key] ?? (query[key] = vue.ref(fallback));
  const view = { state, dirty: vue.ref(true), selected: vue.computed(() => state.draft.connections.find((v) => v.key === state.selectedKey)) };
  const model = scope.run(() => createModelsPage(view as never, routeState as never))!;
  expect(model.activeModel.value.id).toBe("chat-b");
  query.tab.value = "embedding";
  await vue.nextTick();
  expect(model.activeModel.value.id).toBe("embed-a");
  query.connection.value = "b";
  await vue.nextTick();
  expect(state.selectedKey).toBe("b");
  query.connection.value = "a";
  query.tab.value = "chat";
  await vue.nextTick();
  expect(state.draft.connections[1].id).toBe("draft-kept");
  expect(state.selectedKey).toBe("a");
  // The surviving row keeps its cached key when an earlier row is removed.
  // A new duplicate/unnamed row must still get its own selection identity.
  const survivorKey = model.rows.value[1].key;
  state.draft.connections[0].chatModels.splice(0, 1);
  state.draft.connections[0].chatModels.push({ id: "chat-b" });
  await vue.nextTick();
  expect(model.rows.value[0].key).toBe(survivorKey);
  expect(new Set(model.rows.value.map((row) => row.key)).size).toBe(2);
  query.chatModel.value = model.rows.value[1].key;
  await vue.nextTick();
  expect(model.activeModel.value).toBe(state.draft.connections[0].chatModels[1]);
  state.draft.connections[1].id = "roles";
  model.selectConnection("b");
  await vue.nextTick();
  expect(state.selectedKey).toBe("b");
  expect(query.connection.value).toBe("b");
  model.selectConnection("roles");
  await vue.nextTick();
  expect(state.selectedKey).toBe("roles");
  scope.stop();
});

it.each(["rename", "delete"] as const)("模型 %s 后刷新读取已保存模型而非未保存修改", async (action) => {
  const baseline: ModelSettingsSnapshot = {
    revision: "original",
    writable: true,
    roles: { chatModel: "", auxiliaryModel: "", visionModel: "", embeddingModel: "" },
    connections: [
      {
        key: "a",
        id: "main",
        type: "openai",
        enabled: true,
        baseURL: "",
        hasApiKey: false,
        chatModels: [{ id: "first" }, { id: "second" }, { id: "third" }],
        embeddingModels: [],
        options: {},
      },
    ],
  };
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const query: Record<string, vue.Ref<string>> = {
    connection: vue.ref("main"),
    tab: vue.ref("chat"),
    chatModel: vue.ref(action === "rename" ? "1:second" : "2:third"),
  };
  function open() {
    const view = createModelSettingsState(async () => structuredClone(baseline));
    const scope = vue.effectScope();
    const routeState = (key: string, fallback: string) => query[key] ?? (query[key] = vue.ref(fallback));
    const model = scope.run(() => createModelsPage(view, routeState as never))!;
    return {
      view,
      model,
      close: () => {
        scope.stop();
        view.dispose();
      },
    };
  }
  const first = open();
  await first.view.setVisible(true);
  await vue.nextTick();
  expect(first.model.activeModel.value.id).toBe(action === "rename" ? "second" : "third");
  if (action === "rename") first.model.activeModel.value.id = "renamed-draft";
  else first.view.state.draft!.connections[0].chatModels.splice(0, 1);
  await vue.nextTick();
  expect(query.chatModel.value).toBe(action === "rename" ? "1:second" : "2:third");
  first.close();
  const restored = open();
  await restored.view.setVisible(true);
  await vue.nextTick();
  expect(restored.model.activeModel.value.id).toBe(action === "rename" ? "second" : "third");
  expect(query.chatModel.value).toBe(action === "rename" ? "1:second" : "2:third");
  expect(restored.view.state.draft!.revision).toBe("original");
  restored.close();
});
it("模型URL只接受范围内的规范非负整数行号作为回退", () => {
  const rows = [{ key: "0:first" }, { key: "1:renamed" }];
  expect(modelRoute.resolveModelSelection("1:old", rows)).toBe("1:renamed");
  for (const invalid of ["-1:old", "01:old", "1.5:old", "2:old", "9007199254740993:old", "Infinity:old", "1"])
    expect(modelRoute.resolveModelSelection(invalid, rows)).toBe("0:first");
  expect(modelRoute.resolveModelSelection("1:old", [])).toBe("");
});

it("模型行移位优先匹配唯一非空ID；重复ID和空ID只做安全行号回退", () => {
  expect(modelRoute.resolveModelSelection("2:third:with:colon", [{ key: "0:second" }, { key: "1:third:with:colon" }])).toBe("1:third:with:colon");
  const duplicate = [{ key: "0:first" }, { key: "1:same" }, { key: "2:same" }];
  expect(modelRoute.resolveModelSelection("2:same", duplicate)).toBe("2:same");
  expect(modelRoute.resolveModelSelection("3:same", duplicate)).toBe("0:first");
  expect(modelRoute.resolveModelSelection("1:same", [{ key: "0:first" }, { key: "1:renamed" }, { key: "2:same" }, { key: "3:same" }])).toBe("1:renamed");
  expect(modelRoute.resolveModelSelection("2:", [{ key: "0:first" }, { key: "1:" }])).toBe("0:first");
  for (const invalid of ["01:third", "-1:third", "9007199254740993:third"])
    expect(modelRoute.resolveModelSelection(invalid, [{ key: "0:first" }, { key: "1:third" }])).toBe("0:first");
});

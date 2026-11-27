import * as serverRenderer from "@vue/server-renderer";
import { describe, expect, it, vi } from "vitest";
import * as vue from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const fixture = vi.hoisted(() => ({ view: undefined as unknown }));
// The page builds its own settings state; the test hands it the one it drives.
vi.mock("../web/src/state/model-settings-state", async (actual) => {
  const real = await actual<typeof import("../web/src/state/model-settings-state")>();
  return { ...real, createModelSettingsState: (...args: never[]) => (args.length ? real.createModelSettingsState(...args) : fixture.view) };
});
vi.mock("../web/src/context", () => ({
  useLive: () => ({ use: () => ({ state: { data: undefined }, release() {} }) }),
  useSession: () => ({ state: { role: "member", username: "fresh" } }),
}));
vi.mock("../web/src/lib/cache", () => ({ onCacheRefresh: () => () => {} }));
vi.mock("../web/src/lib/route-state", async () => {
  const { ref } = await import("vue");
  return { useRouteState: (_key: string, fallback: string) => ref(fallback) };
});

import { ModelService } from "../../../core/src/models/index.js";
import type { ModelSettingsSave, ModelSettingsSnapshot } from "../src/model-settings-types";
import { resolveConnectionSelection } from "../web/src/lib/model-route-state";
import BotModels from "../web/src/pages/BotModels.vue";
import { createModelSettingsState } from "../web/src/state/model-settings-state";
import { createModelsPage } from "../web/src/state/models-page";

type ModelView = ReturnType<typeof createModelSettingsState>;

function snapshot(models: string[] = [], chatModel = ""): ModelSettingsSnapshot {
  return {
    revision: "initial",
    writable: true,
    roles: { chatModel, auxiliaryModel: "", visionModel: "", embeddingModel: "" },
    connections: models.length
      ? [
          {
            key: "connection:0",
            id: "legacy-explicit",
            enabled: true,
            type: "openai",
            baseURL: "",
            hasApiKey: true,
            chatModels: models.map((id) => ({ id })),
            embeddingModels: [],
            options: {},
          },
        ]
      : [],
  };
}

/** A model-settings endpoint double: revisions advance per save, keys are renumbered, keys never come back. */
function server(initial: ModelSettingsSnapshot) {
  let saved = structuredClone(initial);
  let count = 0;
  let gate: Promise<void> | undefined;
  let refusal: string | undefined;
  const bodies: ModelSettingsSave[] = [];
  const request = vi.fn(async (body?: ModelSettingsSave) => {
    if (!body) return structuredClone(saved);
    bodies.push(structuredClone(body));
    await gate;
    if (refusal) {
      const message = refusal;
      refusal = undefined;
      throw new Error(message);
    }
    if (body.revision !== saved.revision) throw new Error("conflict");
    saved = {
      ...saved,
      revision: `saved-${++count}`,
      roles: structuredClone(body.roles),
      ...(body.taskModels ? { taskModels: [...body.taskModels] } : {}),
      connections: body.connections.map(({ apiKey, ...connection }, index) => ({
        ...structuredClone(connection),
        key: `connection:${index}`,
        hasApiKey: !!apiKey || connection.hasApiKey,
      })),
    };
    return structuredClone(saved);
  });
  const notify = vi.fn<(text: string, undo?: () => void) => void>();
  const view = createModelSettingsState(request, notify);
  return {
    view,
    request,
    notify,
    bodies,
    saved: () => saved,
    /** Holds saves until the returned function is called. */
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return () => {
        gate = undefined;
        release();
      };
    },
    refuse(message: string) {
      refusal = message;
    },
    settled: () => vi.waitFor(() => expect(view.state.saving).toBe(false)),
  };
}

function open(view: ModelView, query = new Map<string, vue.Ref<string>>()) {
  const routeState = (key: string, fallback: string) => {
    if (!query.has(key)) query.set(key, vue.ref(fallback));
    return query.get(key)!;
  };
  return createModelsPage(view, routeState as never);
}

async function rendered(view: ModelView) {
  fixture.view = view;
  const app = vue.createSSRApp(BotModels);
  app.component(
    "RouterLink",
    vue.defineComponent({
      setup:
        (_props, { slots }) =>
        () =>
          vue.h("a", slots.default?.()),
    }),
  );
  return serverRenderer.renderToString(app);
}

describe("model settings saved in place", () => {
  it("saves a purpose at once and offers 撤销, which saves the old choice back", async () => {
    const api = server(snapshot(["chat", "other"], "legacy-explicit:chat"));
    await api.view.setVisible(true);
    expect(await api.view.setRole("chatModel", "legacy-explicit:other", "对话")).toBe(true);
    expect(api.bodies).toHaveLength(1);
    expect(api.bodies[0]).toMatchObject({ revision: "initial", roles: { chatModel: "legacy-explicit:other" } });
    expect(api.view.state.draft!.revision).toBe("saved-1");
    const [text, undo] = api.notify.mock.calls.at(-1)!;
    expect(text).toBe("已保存：对话");
    undo!();
    await api.settled();
    expect(api.saved().roles.chatModel).toBe("legacy-explicit:chat");
    expect(api.notify.mock.calls.at(-1)).toEqual(["已撤销：对话"]);
  });

  it("sends changes made during a save together, replayed on the server's new copy", async () => {
    const api = server(snapshot(["chat", "other"], "legacy-explicit:chat"));
    await api.view.setVisible(true);
    const release = api.hold();
    const first = api.view.setRole("auxiliaryModel", "legacy-explicit:other", "辅助");
    const second = api.view.setRole("visionModel", "legacy-explicit:chat", "看图");
    const third = api.view.setTaskModels(["legacy-explicit:other"]);
    // Shown at once, before any answer.
    expect(api.view.state.draft!.roles).toMatchObject({ auxiliaryModel: "legacy-explicit:other", visionModel: "legacy-explicit:chat" });
    expect(api.bodies).toHaveLength(1);
    release();
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    await api.settled();
    expect(api.bodies).toHaveLength(2);
    expect(api.bodies[1]).toMatchObject({ revision: "saved-1", roles: { visionModel: "legacy-explicit:chat" }, taskModels: ["legacy-explicit:other"] });
    expect(api.notify.mock.calls.map(([text]) => text)).toEqual(["已保存：辅助", "已保存：看图、后台任务"]);
  });

  it("shows the server's copy again when a save is refused, and still saves later changes", async () => {
    const api = server(snapshot(["chat", "other"], "legacy-explicit:chat"));
    await api.view.setVisible(true);
    const release = api.hold();
    api.refuse("模型用途必须选择已启用连接中的对应模型。");
    const refused = api.view.setRole("auxiliaryModel", "gone:model", "辅助");
    const later = api.view.setRole("visionModel", "legacy-explicit:other", "看图");
    release();
    expect(await refused).toBe(false);
    expect(await later).toBe(true);
    await api.settled();
    expect(api.view.state.error).toBe("模型用途必须选择已启用连接中的对应模型。");
    expect(api.view.state.draft!.roles).toMatchObject({ auxiliaryModel: "", visionModel: "legacy-explicit:other" });
    expect(api.saved().roles.auxiliaryModel).toBe("");
    // The reread after a refusal bypasses the cached copy.
    expect(api.request.mock.calls.some(([body, fresh]) => body === undefined && fresh === true)).toBe(true);
  });

  it("saves the ordered background model list, marks its usage and clears it without changing chat roles", async () => {
    const initial = snapshot(["chat", "worker"], "legacy-explicit:chat");
    initial.taskModels = [];
    const api = server(initial);
    const scope = vue.effectScope();
    try {
      const page = scope.run(() => open(api.view))!;
      await api.view.setVisible(true);
      page.selectConnection("connection:0");
      page.tab.value = "chat";
      await api.view.setTaskModels(["legacy-explicit:worker", "legacy-explicit:chat"]);
      expect(api.bodies.at(-1)?.taskModels).toEqual(["legacy-explicit:worker", "legacy-explicit:chat"]);
      expect(page.usedFor(page.models.value[1]!)).toBe("后台任务");
      await api.view.setTaskModels([]);
      expect(api.bodies.at(-1)?.taskModels).toEqual([]);
      expect(api.view.state.draft!.roles.chatModel).toBe("legacy-explicit:chat");
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it("does not turn an omitted background list or image purpose from an older server into an explicit choice", async () => {
    const initial = snapshot(["chat"], "legacy-explicit:chat");
    initial.connections[0]!.imageModels = [{ id: "paint" }];
    const api = server(initial);
    await api.view.setVisible(true);
    await api.view.setRole("auxiliaryModel", "legacy-explicit:chat", "辅助");
    expect(api.bodies[0]).not.toHaveProperty("taskModels");
    expect(api.bodies[0]!.roles).not.toHaveProperty("imageModel");
    expect(api.bodies[0]!.roles).not.toHaveProperty("imageEditModel");
    await api.view.setRole("imageModel", "", "生图");
    expect(api.bodies[1]!.roles).toHaveProperty("imageModel", "");
  });

  it("keeps image models separate from chat and follows the endpoint", async () => {
    const saved = snapshot(["chat"], "legacy-explicit:chat");
    saved.connections[0]!.imageModels = [{ id: "paint" }, { id: "hidden-paint", hidden: true }];
    // Images follow the endpoint (user, 2026-11-23): Gemini draws too; Anthropic does not.
    saved.connections.push({ ...structuredClone(saved.connections[0]!), key: "google", id: "google", type: "google" });
    saved.connections.push({ ...structuredClone(saved.connections[0]!), key: "anthropic", id: "anthropic", type: "anthropic" });
    const api = server(saved);
    const scope = vue.effectScope();
    try {
      const page = scope.run(() => open(api.view))!;
      await api.view.setVisible(true);
      expect(api.view.modelChoices("image").map((choice) => choice.value)).toEqual(["legacy-explicit:paint", "google:paint"]);
      expect(api.view.modelChoices().map((choice) => choice.value)).toEqual(["legacy-explicit:chat", "google:chat", "anthropic:chat"]);
      page.selectConnection("connection:0");
      page.tab.value = "image";
      expect(page.models.value.map((model) => model.id)).toEqual(["paint", "hidden-paint"]);
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it("saves a service's address at once with 撤销, and its API key without one", async () => {
    const api = server(snapshot(["chat"], "legacy-explicit:chat"));
    const scope = vue.effectScope();
    try {
      const page = scope.run(() => open(api.view))!;
      await api.view.setVisible(true);
      page.selectConnection("connection:0");
      await page.setConnection(page.selected.value!, "服务地址", "baseURL", "https://new.example/v1");
      expect(api.saved().connections[0]!.baseURL).toBe("https://new.example/v1");
      expect(api.notify.mock.calls.at(-1)![1]).toBeTypeOf("function");
      await page.setConnection(page.selected.value!, "API 密钥", "apiKey", "fixture-only-key");
      expect(api.bodies.at(-1)!.connections[0]).toMatchObject({ apiKey: "fixture-only-key" });
      expect(api.notify.mock.calls.at(-1)).toEqual(["已保存：API 密钥", undefined]);
      // The key never comes back; the page shows that one is set.
      expect(page.selected.value).toMatchObject({ hasApiKey: true });
      expect(page.selected.value).not.toHaveProperty("apiKey");
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it("writes nothing for a service being added until 添加, and drops it when its page closes", async () => {
    const api = server(snapshot(["demo"]));
    const scope = vue.effectScope();
    try {
      const query = new Map<string, vue.Ref<string>>();
      const page = scope.run(() => open(api.view, query))!;
      await api.view.setVisible(true);
      page.startConnection();
      expect(page.mobileEditor.value).toBe(true);
      await page.setConnection(page.creating.value!, "服务地址", "baseURL", "https://new.example/v1");
      expect(page.creating.value!.baseURL).toBe("https://new.example/v1");
      page.closeConnection();
      await vue.nextTick();
      expect(api.bodies).toEqual([]);
      expect(page.creating.value).toBeUndefined();
      expect(api.view.state.draft!.connections).toHaveLength(1);
      expect(page.mobileEditor.value).toBe(false);
      expect(query.get("connection")!.value).toBe("");
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it("adds a service with a stable internal ID, opens it, and makes its first chat model the reply model", async () => {
    const api = server(snapshot());
    const scope = vue.effectScope();
    try {
      const query = new Map<string, vue.Ref<string>>();
      const page = scope.run(() => open(api.view, query))!;
      await api.view.setVisible(true);
      page.startConnection();
      const id = page.creating.value!.id;
      expect(id).toMatch(/^connection-[0-9a-f-]{36}$/);
      page.creating.value!.baseURL = "https://models.example/v1";
      page.creating.value!.apiKey = "fixture-only-key";
      expect(await page.addConnection()).toBe(true);
      expect(api.bodies[0]!.connections).toMatchObject([{ id, apiKey: "fixture-only-key" }]);
      await vue.nextTick();
      expect(page.creating.value).toBeUndefined();
      expect(query.get("connection")!.value).toBe(id);
      expect(page.selected.value).toMatchObject({ id, key: "connection:0", hasApiKey: true });
      page.tab.value = "chat";
      await page.addModels(["first-chat"]);
      const fullId = `${id}:first-chat`;
      expect(api.saved().roles.chatModel).toBe(fullId);
      expect(api.saved().connections[0]!.chatModels).toEqual([{ id: "first-chat", toolCall: true, reasoning: false }]);
      const html = await rendered(api.view);
      expect(html).toMatch(/class="truncate"[^>]*>对话</);
      expect(html).toMatch(/class="value truncate"[^>]*>first-chat · models\.example</);
      expect(html).not.toMatch(/有未保存的修改|>\s*保存\s*</);
      const registry = new ModelService({ baseDir: "/", emit: () => {} }, { basePath: "unused-fixture", logLevel: 0 });
      registry.register({
        id: api.saved().connections[0]!.id,
        capabilities: { chat: true, embedding: false },
        chatModels: () => api.saved().connections[0]!.chatModels,
        embeddingModels: () => [],
        chat: () => ({}) as never,
      });
      expect(registry.resolveChatModel(api.saved().roles.chatModel)).toMatchObject({ fullId, providerId: id, modelId: "first-chat" });
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it("keeps a refused new service on its form", async () => {
    const api = server(snapshot());
    const scope = vue.effectScope();
    try {
      const page = scope.run(() => open(api.view))!;
      await api.view.setVisible(true);
      page.startConnection();
      page.creating.value!.baseURL = "ftp://bad.example";
      api.refuse("API 地址必须是 HTTP(S) URL。");
      expect(await page.addConnection()).toBe(false);
      expect(page.creating.value).toMatchObject({ baseURL: "ftp://bad.example" });
      expect(api.view.state.draft!.connections).toEqual([]);
      expect(api.view.state.error).toBe("API 地址必须是 HTTP(S) URL。");
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it("renames a model and the purposes that use it together, and deletes a model or a service at once", async () => {
    const initial = snapshot(["chat", "spare"], "legacy-explicit:chat");
    initial.taskModels = ["legacy-explicit:chat"];
    const api = server(initial);
    const scope = vue.effectScope();
    try {
      const page = scope.run(() => open(api.view))!;
      await api.view.setVisible(true);
      page.selectConnection("connection:0");
      page.tab.value = "chat";
      expect(page.renameModel(page.models.value[0]!, "spare")).toBe("已有同名模型。");
      expect(page.renameModel(page.models.value[0]!, " ")).toBe("模型 ID 不能为空。");
      expect(page.renameModel(page.models.value[0]!, "chat-2")).toBe("");
      await api.settled();
      expect(api.saved().connections[0]!.chatModels.map((model) => model.id)).toEqual(["chat-2", "spare"]);
      expect(api.saved()).toMatchObject({ roles: { chatModel: "legacy-explicit:chat-2" }, taskModels: ["legacy-explicit:chat-2"] });
      await page.changeModel(page.models.value[1]!, "推理", (model) => (model.reasoning = true));
      expect(api.saved().connections[0]!.chatModels[1]).toMatchObject({ id: "spare", reasoning: true });
      await page.removeModel(page.models.value[1]!);
      expect(api.saved().connections[0]!.chatModels.map((model) => model.id)).toEqual(["chat-2"]);
      expect(api.notify.mock.calls.at(-1)).toEqual(["已保存：删除 spare", undefined]);
      api.refuse("后台任务模型必须选择已启用连接中的聊天模型。");
      expect(await page.removeConnection()).toBe(false);
      expect(page.mobileEditor.value).toBe(false);
      expect(api.view.state.draft!.connections).toHaveLength(1);
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it("closes a service's page and clears its query, staying on the overview after refreshing", async () => {
    const routeStateModule = await vi.importActual<typeof import("../web/src/lib/route-state")>("../web/src/lib/route-state");
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/settings/models", component: {} }] });
    await router.push({
      path: "/settings/models",
      query: { connection: "legacy-explicit", tab: "chat", chatModel: "0:chat", embeddingModel: "0:embed", keep: "yes" },
    });
    const api = server(snapshot(["chat"]));
    const navigations: Array<Promise<unknown>> = [];
    const routeState = (key: string, fallback: string) =>
      vue.computed({
        get: () => routeStateModule.readQuery(router.currentRoute.value.query, key, fallback, routeStateModule.stringCodec),
        set: (value) => {
          navigations.push(routeStateModule.writeQuery(router, key, value, fallback, routeStateModule.stringCodec));
        },
      });
    const scope = vue.effectScope();
    try {
      const page = scope.run(() => createModelsPage(api.view, routeState as never))!;
      await api.view.setVisible(true);
      await vue.nextTick();
      expect(page.mobileEditor.value).toBe(true);
      expect(page.selected.value?.id).toBe("legacy-explicit");
      page.closeConnection();
      await Promise.all(navigations.splice(0));
      await vue.nextTick();
      expect(router.currentRoute.value.query).toEqual({ keep: "yes" });
      expect(page.mobileEditor.value).toBe(false);
      const refreshed = scope.run(() => createModelsPage(api.view, routeState as never))!;
      expect(refreshed.mobileEditor.value).toBe(false);
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it.each([
    { models: ["first"], role: "", expected: "" },
    { models: ["first", "second"], role: "legacy-explicit:second", expected: "legacy-explicit:second" },
    { models: ["first"], role: "other:explicit-choice", expected: "other:explicit-choice" },
  ])("leaves an existing reply model choice alone with $models", async ({ models, role, expected }) => {
    const api = server(snapshot(models, role));
    const scope = vue.effectScope();
    try {
      const page = scope.run(() => open(api.view))!;
      await api.view.setVisible(true);
      expect(api.view.state.draft!.roles.chatModel).toBe(expected);
      page.selectConnection("connection:0");
      page.tab.value = "chat";
      await page.addModels(["third"]);
      expect(api.saved().roles.chatModel).toBe(expected);
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it("respects a cleared reply model and ignores disabled, blank and malformed provider choices", async () => {
    const api = server(snapshot(["first"], "legacy-explicit:first"));
    const scope = vue.effectScope();
    try {
      const page = scope.run(() => open(api.view))!;
      await api.view.setVisible(true);
      await api.view.setRole("chatModel", "", "对话");
      page.selectConnection("connection:0");
      page.tab.value = "chat";
      await page.addModels(["second"]);
      await page.removeModel(page.models.value[1]!);
      expect(api.saved().roles.chatModel).toBe("");
      const draft = api.view.state.draft!;
      draft.connections[0]!.enabled = false;
      expect(api.view.modelChoices()).toEqual([]);
      draft.connections[0]!.enabled = true;
      draft.connections[0]!.id = "https://models.example/";
      expect(api.view.modelChoices()).toEqual([]);
      draft.connections[0]!.id = "valid";
      draft.connections[0]!.chatModels[0]!.id = "  ";
      expect(api.view.modelChoices()).toEqual([]);
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });

  it("opens the first enabled connection, never a disabled one whose ID is still blank", async () => {
    const connections = [
      { key: "off", id: "", enabled: false },
      { key: "main", id: "main", enabled: true },
    ];
    expect(resolveConnectionSelection("", connections)).toBe("main");
    expect(resolveConnectionSelection("off", connections)).toBe("off");
    expect(resolveConnectionSelection("roles", connections)).toBe("roles");
    expect(resolveConnectionSelection("", [{ key: "off", id: "", enabled: false }])).toBe("off");
    expect(resolveConnectionSelection("", [])).toBe("roles");
    const base = snapshot(["first"]);
    const disabled = { ...base.connections[0]!, key: "connection:0", id: "", enabled: false };
    const api = server({ ...base, connections: [disabled, { ...base.connections[0]!, key: "connection:1" }] });
    const scope = vue.effectScope();
    try {
      scope.run(() => open(api.view));
      await api.view.setVisible(true);
      await vue.nextTick();
      expect(api.view.state.selectedKey).toBe("connection:1");
    } finally {
      scope.stop();
      api.view.dispose();
    }
  });
});

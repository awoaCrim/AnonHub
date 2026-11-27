import { describe, expect, it, vi } from "vitest";

import { moduleConfig as providerConfig } from "../../../providers/model-provider/src/index.js";
import { ModelSettingsStore } from "../src/model-settings.js";

function fixture(canonical = true) {
  const connection = {
    type: "openai",
    id: "shared",
    apiKey: "private-key",
    baseURL: "https://user:password@images.test/v1?token=private-query#private-fragment",
    chatModels: [{ id: "chat", toolCall: true, sdkOption: "chat-opaque" }],
    embeddingModels: [{ id: "embed" }],
    imageModels: [
      { id: "generate", name: "Generation", hidden: true, sdkOption: "image-opaque" },
      { id: "edit", sdkOption: "edit-opaque" },
    ],
    opaque: { secret: "connection-opaque" },
  };
  const inactive = { enabled: false, type: "openai", id: "inactive", apiKey: "inactive-key", imageModels: [{ id: "", sdkOption: "keep" }] };
  const config = {
    plugins: {
      "yesimbot-model-provider:p": { connections: [connection, inactive] },
      "yesimbot:core": {
        chatModel: "shared:chat",
        auxiliaryModel: "shared:chat",
        unrelated: { keep: true },
        ...(canonical ? { imageModel: "shared:generate", imageEditModel: "shared:edit" } : {}),
      },
    },
  };
  const reload = vi.fn(async (_parent: unknown, key: string, value: unknown) => {
    Object.assign(config.plugins, { [key]: structuredClone(value) });
    return { isActive: true };
  });
  const ctx = {
    lifecycle: { flush: vi.fn(async () => {}) },
    get: () => ({}),
    registry: { values: () => [] },
    loader: {
      config,
      writable: true,
      entry: { scope: { [Symbol.for("koishi.loader.record")]: {} } },
      isTruthyLike: () => true,
      writeConfig: vi.fn(async () => {}),
      reload,
      resolve: async () => ({ moduleConfig: providerConfig }),
    },
  };
  const native = () => config.plugins["yesimbot-model-provider:p"].connections[0];
  return { store: new ModelSettingsStore(ctx as never), config, reload, native };
}

describe("managed Images model settings", () => {
  it("projects a separate Images table with revision-bound identities and safe optional labels", () => {
    const { store } = fixture();
    const snapshot = store.read();
    expect(snapshot.connections[0].imageModels).toEqual([
      { id: "generate", name: "Generation", hidden: true, key: "model:connection:0:imageModels:0" },
      { id: "edit", key: "model:connection:0:imageModels:1" },
    ]);
    expect(snapshot.roles).toMatchObject({ imageModel: "shared:generate", imageEditModel: "shared:edit" });
    const json = JSON.stringify(snapshot);
    for (const secret of ["private-key", "password", "private-query", "private-fragment", "opaque"]) expect(json).not.toContain(secret);
  });

  it.each([true, false])("keeps canonical=%s Images settings as an exact GET/no-op save", async (canonical) => {
    const { store, config, reload } = fixture(canonical);
    const before = structuredClone(config);
    const draft = store.read();
    if (!canonical) {
      expect(draft.roles).not.toHaveProperty("imageModel");
      expect(draft.roles).not.toHaveProperty("imageEditModel");
    }
    await store.save(draft);
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("saves an explicit disabled main Images role", async () => {
    const { store, config, reload } = fixture(false);
    const draft = store.read();
    draft.roles.imageModel = "";
    const saved = await store.save(draft);
    expect(saved.roles.imageModel).toBe("");
    expect(config.plugins["yesimbot:core"]).toHaveProperty("imageModel", "");
    expect(reload.mock.calls.map(([, key]) => key)).toEqual(["yesimbot:core"]);
  });

  it("accepts Images roles on a connection without an explicit type (default OpenAI protocol)", async () => {
    const { store, native, config, reload } = fixture();
    delete (native() as Partial<ReturnType<typeof native>>).type;
    const before = structuredClone(config);
    await store.save(store.read());
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("preserves Images tables, credentials and choices when an older client edits a chat setting", async () => {
    const { store, native, config } = fixture();
    const before = structuredClone(config);
    const draft = store.read();
    for (const connection of draft.connections) delete connection.imageModels;
    delete draft.roles.imageModel;
    delete draft.roles.imageEditModel;
    draft.connections[0].chatModels[0].toolCall = false;
    await store.save(draft);
    expect(native()).toEqual({
      ...before.plugins["yesimbot-model-provider:p"].connections[0],
      chatModels: [{ id: "chat", toolCall: false, sdkOption: "chat-opaque" }],
    });
    expect(config.plugins["yesimbot:core"]).toEqual(before.plugins["yesimbot:core"]);
    expect(config.plugins["yesimbot-model-provider:p"].connections[1]).toEqual(before.plugins["yesimbot-model-provider:p"].connections[1]);
  });

  it("preserves native image options across rename and reorder without copying sanitized URLs", async () => {
    const { store, native } = fixture();
    const original = structuredClone(native());
    const draft = store.read();
    const models = draft.connections[0].imageModels!;
    models.reverse();
    models[1].id = "new-generate";
    models[1].name = "New label";
    models[1].hidden = false;
    draft.roles.imageModel = "shared:new-generate";
    const saved = await store.save(draft);
    expect(native()).toEqual({
      ...original,
      imageModels: [original.imageModels[1], { ...original.imageModels[0], id: "new-generate", name: "New label", hidden: false }],
    });
    expect(saved.roles).toMatchObject({ imageModel: "shared:new-generate", imageEditModel: "shared:edit" });
    expect(store.read()).toEqual(saved);
  });

  it.each(["chatModels", "embeddingModels"] as const)("rejects Images identities borrowed from the %s table", async (table) => {
    const { store, config, reload } = fixture();
    const before = structuredClone(config);
    const draft = store.read();
    draft.connections[0].imageModels![0].key = draft.connections[0][table][0].key;
    await expect(store.save(draft)).rejects.toMatchObject({ status: 400 });
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(["shared:chat", "shared:embed", "inactive:generate", "missing:generate"])("rejects non-Images or inactive main/edit role %s", async (selection) => {
    for (const role of ["imageModel", "imageEditModel"] as const) {
      const { store, config, reload } = fixture();
      const before = structuredClone(config);
      const draft = store.read();
      draft.roles[role] = selection;
      await expect(store.save(draft)).rejects.toMatchObject({ status: 400 });
      expect(config).toEqual(before);
      expect(reload).not.toHaveBeenCalled();
    }
  });

  it("accepts a hidden registered Images model and uses an explicit empty edit choice to follow main", async () => {
    const { store, config } = fixture();
    const draft = store.read();
    draft.roles.imageModel = "shared:edit";
    draft.roles.imageEditModel = "";
    await store.save(draft);
    const next = store.read();
    next.roles.imageModel = "shared:generate";
    const saved = await store.save(next);
    expect(saved.roles).toMatchObject({ imageModel: "shared:generate", imageEditModel: "" });
    expect(config.plugins["yesimbot:core"]).toMatchObject({ imageModel: "shared:generate", imageEditModel: "" });
  });

  it("requires a main Images choice before accepting a new independent editing role", async () => {
    const { store, config, reload } = fixture(false);
    const before = structuredClone(config);
    const draft = store.read();
    draft.roles.imageEditModel = "shared:edit";
    await expect(store.save(draft)).rejects.toMatchObject({ status: 400, message: "请先选择生图模型，再设置独立编辑模型。" });
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
    draft.roles.imageModel = "shared:generate";
    const saved = await store.save(draft);
    expect(saved.roles).toMatchObject({ imageModel: "shared:generate", imageEditModel: "shared:edit" });
  });

  it("accepts the ordinary empty editing default when no main Images model is chosen", async () => {
    const { store } = fixture(false);
    const draft = store.read();
    draft.roles.imageEditModel = "";
    const saved = await store.save(draft);
    expect(saved.roles.imageEditModel).toBe("");
    expect(saved.roles).not.toHaveProperty("imageModel");
  });

  it("allows an explicitly disabled main to retain its unchanged editing choice for later restoration", async () => {
    const { store, config } = fixture();
    const draft = store.read();
    draft.roles.imageModel = "";
    await store.save(draft);
    expect(config.plugins["yesimbot:core"]).toMatchObject({ imageModel: "", imageEditModel: "shared:edit" });
    const disabled = store.read();
    disabled.connections[0].chatModels[0].toolCall = false;
    await store.save(disabled);
    const changed = store.read();
    changed.roles.imageEditModel = "shared:generate";
    await expect(store.save(changed)).rejects.toMatchObject({ status: 400, message: "请先选择生图模型，再设置独立编辑模型。" });
    expect(config.plugins["yesimbot:core"]).toMatchObject({ imageModel: "", imageEditModel: "shared:edit" });
  });

  it.each(["shared:edit", ""])("preserves a preexisting partial editing role (%s) during unrelated saves and older-client omissions", async (existingEdit) => {
    const { store, config, reload } = fixture(false);
    Object.assign(config.plugins["yesimbot:core"], { imageEditModel: existingEdit });
    const before = structuredClone(config);
    await store.save(store.read());
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
    const draft = store.read();
    delete draft.roles.imageModel;
    delete draft.roles.imageEditModel;
    draft.connections[0].chatModels[0].toolCall = false;
    await store.save(draft);
    expect(config.plugins["yesimbot:core"]).toEqual(before.plugins["yesimbot:core"]);
  });

  // Images follow the endpoint (user, 2026-11-23: 「图片也需要看端点」): OpenAI's Images API or Gemini's own.
  it.each(["anthropic", "deepseek"])("never treats an image table on a %s endpoint as an active image route", async (type) => {
    const { store, native, config, reload } = fixture();
    native().type = type;
    const before = structuredClone(config);
    await expect(store.save(store.read())).rejects.toMatchObject({ status: 400 });
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("lets a Gemini endpoint serve the chosen image models", async () => {
    const { store, native, config } = fixture();
    native().type = "google";
    const draft = store.read();
    expect(draft.connections[0]!.imageModels?.map((model) => model.id)).toEqual(["generate", "edit"]);
    draft.roles.imageEditModel = "shared:generate";
    await store.save(draft);
    expect(config.plugins["yesimbot:core"]).toMatchObject({ imageModel: "shared:generate", imageEditModel: "shared:generate" });
  });

  it("creates an Images-only connection with empty chat and embedding tables", async () => {
    const { store, config } = fixture(false);
    const draft = store.read();
    draft.connections.push({
      key: "new:12345678-1234-4234-8234-123456789abc",
      id: "images",
      enabled: true,
      type: "openai",
      baseURL: "https://images.test/custom/v1",
      apiKey: "new-image-key",
      hasApiKey: false,
      chatModels: [],
      embeddingModels: [],
      imageModels: [{ id: "picture" }],
      options: {},
    });
    draft.roles.imageModel = "images:picture";
    const saved = await store.save(draft);
    expect(config.plugins["yesimbot-model-provider:p"].connections[2]).toEqual({
      id: "images",
      enabled: true,
      type: "openai",
      baseURL: "https://images.test/custom/v1",
      apiKey: "new-image-key",
      chatModels: [],
      embeddingModels: [],
      imageModels: [{ id: "picture" }],
    });
    expect(saved.connections[2]).toMatchObject({ chatModels: [], embeddingModels: [], imageModels: [{ id: "picture" }] });
    expect(JSON.stringify(saved)).not.toContain("new-image-key");
  });

  it.each([{ name: 42 }, { hidden: "false" }, { toolCall: true }, { sdkSecret: "incoming-secret" }])(
    "rejects unexpected or malformed public Images options: %j",
    async (patch) => {
      const { store, config, reload } = fixture();
      const before = structuredClone(config);
      const draft = store.read();
      Object.assign(draft.connections[0].imageModels![0], patch);
      await expect(store.save(draft)).rejects.toMatchObject({ status: 400 });
      expect(config).toEqual(before);
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it("retains omitted image choices during validation and rejects removal of their model", async () => {
    const { store, config, reload } = fixture();
    const before = structuredClone(config);
    const draft = store.read();
    delete draft.roles.imageModel;
    delete draft.roles.imageEditModel;
    draft.connections[0].imageModels = [];
    await expect(store.save(draft)).rejects.toMatchObject({ status: 400 });
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("rolls back both Images models and core roles after a later scope fails", async () => {
    const { store, native, config, reload } = fixture();
    const before = structuredClone(config);
    const originalReload = reload.getMockImplementation()!;
    let fail = true;
    reload.mockImplementation(async (parent, key, value) => {
      await originalReload(parent, key, value);
      if (key === "yesimbot:core" && fail) {
        fail = false;
        throw new Error("private-provider-error");
      }
      return { isActive: true };
    });
    const draft = store.read();
    draft.connections[0].imageModels![0].id = "replacement";
    draft.roles.imageModel = "shared:replacement";
    await expect(store.save(draft)).rejects.toMatchObject({ status: 503, message: "保存失败，已恢复之前的配置，请重试。" });
    expect(config).toEqual(before);
    expect(native().imageModels[0].id).toBe("generate");
    expect(reload.mock.calls.map(([, key]) => key)).toEqual(["yesimbot-model-provider:p", "yesimbot:core", "yesimbot:core", "yesimbot-model-provider:p"]);
  });
});

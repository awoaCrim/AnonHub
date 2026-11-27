import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { moduleConfig as providerConfig } from "../../../providers/model-provider/src/index.js";
import { ConfigStore } from "../src/config/store.js";
import { installModelSettings, ModelSettingsStore, readModelSettingsBody } from "../src/model-settings.js";

function fixture() {
  const connection = {
    type: "openai",
    id: "existing",
    apiKey: "private-api-key",
    baseURL: "https://example.test/v1",
    opaque: { credential: "opaque-secret" },
    chatModels: [{ id: "chat", toolCall: true, sdkSecret: "model-secret" }],
    embeddingModels: [{ id: "embed" }],
    format: "chat",
  };
  const config = {
    plugins: {
      "group:models": {
        "yesimbot-model-provider:provider": {
          connections: [
            connection,
            { enabled: false, id: "disabled", type: "openai", apiKey: "disabled-key", opaque: "disabled-secret", chatModels: [], embeddingModels: [] },
          ],
        },
      },
      "yesimbot:core": {
        chatModel: "existing:chat",
        auxiliaryModel: "existing:chat",
        unrelated: 42,
        session: { compact: { threshold: 123 } },
      },
      unrelated: { secret: "unrelated-secret" },
    },
  };
  const reload = vi.fn(async (parent: string, key: string, value: unknown) => {
    const target = parent ? config.plugins[`group:${parent}`] : config.plugins;
    target[key] = structuredClone(value);
  });
  const rootContext = { scope: { [Symbol.for("koishi.loader.record")]: {} } };
  const groupContext = { scope: { [Symbol.for("koishi.loader.record")]: {} } };
  rootContext.scope[Symbol.for("koishi.loader.record")]["group:models"] = { ctx: groupContext };
  const ctx = {
    lifecycle: { flush: vi.fn(async () => {}) },
    get: vi.fn(() => ({})),
    registry: { values: () => [] },
    loader: {
      config,
      writable: true,
      entry: rootContext,
      isTruthyLike: () => true,
      writeConfig: vi.fn(async () => {}),
      reload: async (parent: unknown, key: string, value: unknown) => {
        await reload(parent === groupContext ? "models" : "", key, value);
        return { isActive: true };
      },
      resolve: vi.fn(async () => ({ moduleConfig: providerConfig })),
    },
    console: { services: { config: { reload } } },
  };
  return { ctx, config, reload, store: new ModelSettingsStore(ctx as never), connection };
}

describe("managed model settings store", () => {
  it("lets members edit chat models; the history model is not a role of its own", async () => {
    const spy = vi.spyOn(ConfigStore.prototype, "allowed").mockReturnValue(new Set(["yesimbot", "yesimbot-model-provider", "yesimbot-memorizer"]));
    try {
      const { store } = fixture();
      const draft = store.read();
      expect(draft.contextManaged).toBe(true);
      expect(draft.roles).not.toHaveProperty("compactModel");
      const saved = await store.save({ ...draft, roles: { ...draft.roles, auxiliaryModel: "" } });
      expect(saved.roles.auxiliaryModel).toBe("");
    } finally {
      spy.mockRestore();
    }
  });
  it.each([true, false])("rejects URL provider IDs on new connections (enabled: %s) before writing", async (enabled) => {
    const { store, reload, config } = fixture();
    const before = structuredClone(config);
    const draft = store.read();
    draft.connections.push({
      ...draft.connections[0],
      key: "new:12345678-1234-4234-8234-123456789abc",
      enabled,
      id: "https://newapi.example/",
      apiKey: "fixture-key",
      chatModels: [{ id: "chat" }],
      embeddingModels: [],
    });
    await expect(store.save(draft)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("连接标识不能包含冒号") });
    expect(config).toStrictEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });
  it("preserves unchanged enabled and inactive legacy URL provider IDs without blocking other model edits", async () => {
    const { store, connection, config, reload } = fixture();
    connection.id = "https://newapi.example/";
    const core = config.plugins["yesimbot:core"];
    core.chatModel = core.auxiliaryModel = `${connection.id}:chat`;
    core.embeddingModel = `${connection.id}:embed`;
    config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[1].id = "https://inactive.example/";
    const before = structuredClone(config);
    await store.save(store.read());
    expect(config).toStrictEqual(before);
    expect(reload).not.toHaveBeenCalled();
    const draft = store.read();
    draft.connections.push({
      ...draft.connections[0],
      key: "new:12345678-1234-4234-8234-123456789abc",
      id: "usable",
      apiKey: "fixture-key",
      chatModels: [{ id: "chat" }],
      embeddingModels: [],
    });
    draft.roles.chatModel = "usable:chat";
    await store.save(draft);
    expect(config.plugins["group:models"]["yesimbot-model-provider:provider"].connections.slice(0, 2)).toStrictEqual(
      before.plugins["group:models"]["yesimbot-model-provider:provider"].connections,
    );
    expect(store.read().roles.chatModel).toBe("usable:chat");
  });
  it.each([
    ["https://google.example", "https://google.example/v1beta"],
    ["https://google.example/", "https://google.example/v1beta"],
    ["https://google.example/custom/google/", "https://google.example/custom/google/"],
    ["https://google.example/v1beta", "https://google.example/v1beta"],
  ])("saves Google service address %s as %s without changing other connection fields", async (baseURL, expected) => {
    const { store, config, connection } = fixture();
    const original = structuredClone(connection);
    const draft = store.read();
    draft.connections[0].type = "google";
    draft.connections[0].baseURL = baseURL;
    const saved = await store.save(draft);
    expect(saved.connections[0].baseURL).toBe(expected.replace(/\/$/, ""));
    expect(config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[0]).toEqual({ ...original, type: "google", baseURL: expected });
    expect(store.read()).toEqual(saved);
  });
  it("keeps an unchanged Google root address as a complete no-op", async () => {
    const { store, connection, config, reload } = fixture();
    connection.type = "google";
    connection.baseURL = "https://google.example/";
    const before = structuredClone(config);
    await store.save(store.read());
    expect(config).toStrictEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });
  it("configures a fresh account", async () => {
    const { store, config, reload } = fixture();
    const plugins = config.plugins as Record<string, unknown>;
    config.plugins["group:models"]["yesimbot-model-provider:provider"] = { connections: [] } as never;
    plugins["yesimbot:core"] = { chatModel: "", unrelated: 42 };
    const before = structuredClone(config);
    const draft = store.read();
    expect(draft).toMatchObject({ writable: true, connections: [], roles: { embeddingModel: "" } });
    await store.save(draft);
    expect(config).toStrictEqual(before);
    expect(reload).not.toHaveBeenCalled();
    // No connection offers this model yet.
    await expect(store.save({ ...draft, roles: { ...draft.roles, embeddingModel: "new:embed" } })).rejects.toMatchObject({ status: 400 });
    expect(config).toStrictEqual(before);
    expect(reload).not.toHaveBeenCalled();
    draft.connections.push({
      key: "new:12345678-1234-4234-8234-123456789abc",
      enabled: true,
      type: "openai",
      id: "new",
      baseURL: "",
      hasApiKey: false,
      apiKey: "new-account-key",
      chatModels: [{ id: "chat" }],
      embeddingModels: [],
      options: {},
    });
    draft.roles.chatModel = "new:chat";
    const saved = await store.save(draft);
    expect(saved).toMatchObject({ writable: true, roles: { chatModel: "new:chat", embeddingModel: "" } });
    expect(store.read()).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain("new-account-key");
    const expected = structuredClone(before);
    expected.plugins["group:models"]["yesimbot-model-provider:provider"] = {
      connections: [{ enabled: true, type: "openai", id: "new", apiKey: "new-account-key", chatModels: [{ id: "chat" }], embeddingModels: [] }],
    } as never;
    expected.plugins["yesimbot:core"].chatModel = "new:chat";
    expect(config).toStrictEqual(expected);
    expect(reload.mock.calls.map(([, key]) => key)).toEqual(["yesimbot-model-provider:provider", "yesimbot:core"]);
  });
  it("writes the vector model to the shared core setting only", async () => {
    const { store, config, reload } = fixture();
    const draft = store.read();
    expect(draft.roles.embeddingModel).toBe("");
    draft.roles.embeddingModel = "existing:embed";
    await store.save(draft);
    expect(store.read().roles.embeddingModel).toBe("existing:embed");
    expect(config.plugins["yesimbot:core"]).toMatchObject({ embeddingModel: "existing:embed" });
    expect(reload.mock.calls.map(([, key]) => key)).toEqual(["yesimbot:core"]);
  });
  it.each(["yesimbot:core", "yesimbot-model-provider:provider"])("keeps disabled, scoped and duplicate %s entries read-only", async (key) => {
    for (const mode of ["disabled", "scoped", "duplicate"]) {
      const { store, config, reload } = fixture();
      const parent = key === "yesimbot:core" ? config.plugins : config.plugins["group:models"];
      if (mode === "disabled") {
        parent[`~${key}`] = parent[key];
        delete parent[key];
      } else if (mode === "scoped") parent[key].$filter = {};
      else parent[`${key}-second`] = structuredClone(parent[key]);
      const before = structuredClone(config);
      expect(store.read().writable).toBe(false);
      await expect(store.save(store.read())).rejects.toMatchObject({ status: 400 });
      expect(config).toStrictEqual(before);
      expect(reload).not.toHaveBeenCalled();
    }
  });
  it("allows benign provider labels and preserves them on a no-op save", async () => {
    const { store, config, reload } = fixture();
    const provider = config.plugins["group:models"]["yesimbot-model-provider:provider"];
    provider["$label"] = "模型连接";
    const before = structuredClone(config);
    const snapshot = store.read();
    expect(snapshot.writable).toBe(true);
    await store.save(snapshot);
    expect(config).toEqual(before);
    expect(provider["$label"]).toBe("模型连接");
    expect(reload).not.toHaveBeenCalled();
  });
  it("preserves benign ancestor labels but makes semantic ancestor metadata read-only", async () => {
    for (const metadata of ["$isolate", "$inject", "$if", "$filter", "$futureSemanticOption"]) {
      const { store, config, reload } = fixture();
      const group = config.plugins["group:models"];
      group["$label"] = "模型分组";
      group["$description"] = "保留说明";
      expect(store.read().writable).toBe(true);
      group[metadata] = {};
      const snapshot = store.read();
      expect(snapshot.writable).toBe(false);
      await expect(store.save(snapshot)).rejects.toMatchObject({ status: 400 });
      expect(reload).not.toHaveBeenCalled();
    }
  });
  it("keeps a no-op semantically identical, including absent native defaults", async () => {
    const { store, config, reload } = fixture();
    const before = structuredClone(config);
    await store.save(store.read());
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
    const draft = store.read();
    draft.connections[0].apiKey = "replacement";
    await store.save(draft);
    expect(config.plugins["yesimbot:core"]).toEqual(before.plugins["yesimbot:core"]);
    const clear = store.read();
    clear.connections[0].baseURL = "";
    await store.save(clear);
    expect(config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[0]).not.toHaveProperty("baseURL");
  });
  it("redacts every opaque field and retains credentials/options in edited and disabled connections", async () => {
    const { store, config, connection } = fixture();
    const draft = store.read();
    expect(JSON.stringify(draft)).not.toMatch(/private-api-key|opaque-secret|model-secret|disabled-key|disabled-secret|unrelated-secret/);
    expect(draft.connections[0].hasApiKey).toBe(true);
    expect(draft.connections[0]).not.toHaveProperty("apiKey");
    draft.connections[0].chatModels[0].reasoning = true;
    const saved = await store.save(draft);
    const provider = config.plugins["group:models"]["yesimbot-model-provider:provider"] as { connections: (typeof connection)[] };
    expect(provider.connections[0]).toMatchObject({
      apiKey: "private-api-key",
      opaque: connection.opaque,
      chatModels: [{ sdkSecret: "model-secret", reasoning: true }],
    });
    expect(provider.connections[1]).toMatchObject({ enabled: false, apiKey: "disabled-key", opaque: "disabled-secret" });
    expect(config.plugins["yesimbot:core"].unrelated).toBe(42);
    expect(saved.revision).not.toBe(draft.revision);
  });
  it("preserves incomplete disabled SDK fields and notices a native editor change during asynchronous schema resolution", async () => {
    const { store, ctx, config } = fixture();
    const disabled = config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[1];
    disabled.chatModels = [{ privateSDKConfig: "private-retained" }] as never;
    disabled["thinkingLevelMap"] = { custom: "opaque" };
    const before = structuredClone(disabled);
    const draft = store.read();
    draft.connections[0].apiKey = "changed";
    await store.save(draft);
    expect(config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[1]).toEqual(before);
    const current = store.read();
    current.connections[0].apiKey = "racing";
    ctx.loader.resolve.mockImplementationOnce(async () => {
      config.plugins["yesimbot:core"].unrelated++;
      return { moduleConfig: providerConfig };
    });
    await expect(store.save(current)).rejects.toMatchObject({ status: 409 });
    expect(config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[0].apiKey).toBe("changed");
  });
  it("preserves opaque native model fields across rename and rejects reused or foreign model identities", async () => {
    const { store, config } = fixture();
    const draft = store.read();
    draft.connections[0].chatModels[0].id = "renamed";
    draft.roles.chatModel = "existing:renamed";
    draft.roles.auxiliaryModel = "existing:renamed";
    await store.save(draft);
    const saved = config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[0].chatModels[0];
    expect(saved).toMatchObject({ id: "renamed", sdkSecret: "model-secret", toolCall: true });
    expect(saved).not.toHaveProperty("key");
    const duplicated = store.read();
    duplicated.connections[0].chatModels.push({ ...duplicated.connections[0].chatModels[0], id: "another" });
    await expect(store.save(duplicated)).rejects.toMatchObject({ status: 400 });
    const foreign = store.read();
    foreign.connections[1].chatModels.push({ ...foreign.connections[0].chatModels[0] });
    await expect(store.save(foreign)).rejects.toMatchObject({ status: 400 });
    const wrongTable = store.read();
    wrongTable.connections[0].embeddingModels[0].key = wrongTable.connections[0].chatModels[0].key;
    await expect(store.save(wrongTable)).rejects.toMatchObject({ status: 400 });
  });
  it("adds a credential explicitly, enables real native schema validation and rejects incompatible references", async () => {
    const { store, config } = fixture();
    const draft = store.read();
    draft.connections.push({
      key: "new:12345678-1234-1234-1234-123456789012",
      enabled: true,
      type: "anthropic",
      id: "new-provider",
      baseURL: "",
      hasApiKey: false,
      apiKey: "new-private-key",
      chatModels: [{ id: "claude" }],
      embeddingModels: [],
      options: {},
    });
    draft.roles.chatModel = "new-provider:claude";
    await store.save(draft);
    expect(config.plugins["yesimbot:core"].chatModel).toBe("new-provider:claude");
    const next = store.read();
    next.connections[0].apiKey = "replacement";
    await store.save(next);
    expect(config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[0].apiKey).toBe("replacement");
    const invalid = store.read();
    invalid.roles.embeddingModel = "new-provider:claude";
    await expect(store.save(invalid)).rejects.toMatchObject({ status: 400 });
    invalid.roles.embeddingModel = "";
    invalid.connections[0].options.format = "bad" as never;
    await expect(store.save(invalid)).rejects.toMatchObject({ status: 400 });
  });
  it("rejects stale revisions, ID changes, duplicates, disabled references and unsupported scopes", async () => {
    const { store, config } = fixture();
    const draft = store.read();
    config.plugins["yesimbot:core"].unrelated++;
    await expect(store.save(draft)).rejects.toMatchObject({ status: 409 });
    const next = store.read();
    next.connections[0].id = "renamed";
    await expect(store.save(next)).rejects.toMatchObject({ status: 400 });
    next.connections[0].id = "existing";
    next.connections[0].enabled = false;
    await expect(store.save(next)).rejects.toMatchObject({ status: 400 });
    next.connections[0].enabled = true;
    next.connections[0].chatModels.push({ id: "chat" });
    await expect(store.save(next)).rejects.toMatchObject({ status: 400 });
    config.plugins["group:models"]["$filter"] = { platform: "onebot" };
    expect(store.read()).toMatchObject({ writable: false, reason: expect.any(String) });
  });
  it("serializes writes through core replacement and rolls back every attempted scope", async () => {
    const { store, ctx, reload, config } = fixture();
    const before = structuredClone(config);
    const native = reload.getMockImplementation()!;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    reload.mockImplementationOnce(async (...args) => {
      await waiting;
      await native(...args);
    });
    const draft = store.read();
    draft.connections[0].apiKey = "changed";
    draft.roles.visionModel = "existing:chat";
    const pending = store.save(draft);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    await expect(store.save(draft)).rejects.toMatchObject({ status: 409 });
    reload.mockImplementationOnce(async () => {
      throw new Error("secret upstream failure");
    });
    release();
    await expect(pending).rejects.toMatchObject({ status: 503, message: expect.not.stringContaining("secret") });
    expect(ctx.loader.config).toEqual(before);
    expect(reload.mock.calls.map(([parent, key]) => `${parent}/${key}`)).toEqual([
      "models/yesimbot-model-provider:provider",
      "/yesimbot:core",
      "/yesimbot:core",
      "models/yesimbot-model-provider:provider",
    ]);
  });
});

describe("managed model HTTP boundary", () => {
  it("registers only in managed mode and enforces owner and origin before parsing", async () => {
    const { ctx } = fixture();
    const routes: Record<string, Function> = {};
    const server = { get: (path: string, cb: Function) => (routes[`GET ${path}`] = cb), post: (path: string, cb: Function) => (routes[`POST ${path}`] = cb) };
    const auth = {
      config: { enabled: false },
      requireOwner: (http: { status: number; owner: boolean }) => {
        if (http.owner) return true;
        http.status = 401;
        return false;
      },
      sameOrigin: (http: { same: boolean }) => http.same,
    };
    installModelSettings({ ...ctx, server } as never, auth as never);
    expect(routes).toEqual({});
    auth.config.enabled = true;
    installModelSettings({ ...ctx, server } as never, auth as never);
    const anonymous = { owner: false, status: 200 };
    routes["GET /yesimbot/model-settings"](anonymous);
    expect(anonymous.status).toBe(401);
    await routes["POST /yesimbot/model-settings"](anonymous);
    expect(anonymous.status).toBe(401);
    const foreign = { owner: true, same: false, status: 200 };
    await routes["POST /yesimbot/model-settings"](foreign);
    expect(foreign.status).toBe(403);
    const owner = { owner: true, body: undefined };
    routes["GET /yesimbot/model-settings"](owner);
    expect(owner.body).toHaveProperty("connections");
  });
  it("reads bounded raw JSON and rejects malformed, oversized and non-JSON bodies", async () => {
    const http = (raw: string, headers: Record<string, string> = {}) => ({
      request: {},
      req: Readable.from([raw]),
      get: (name: string) => headers[name] ?? (name === "content-type" ? "application/json" : ""),
    });
    expect(await readModelSettingsBody(http('{"revision":"x"}') as never)).toEqual({ revision: "x" });
    await expect(readModelSettingsBody(http("{}", { "content-type": "text/plain" }) as never)).rejects.toThrow();
    await expect(readModelSettingsBody(http("{}", { "content-length": "524289" }) as never)).rejects.toThrow();
    await expect(readModelSettingsBody(http('"' + "a".repeat(524288) + '"') as never)).rejects.toThrow();
    await expect(readModelSettingsBody(http("{") as never)).rejects.toThrow();
  });
});

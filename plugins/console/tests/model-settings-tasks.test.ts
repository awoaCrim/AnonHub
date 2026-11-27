import { describe, expect, it, vi } from "vitest";

import { moduleConfig as providerConfig } from "../../../providers/model-provider/src/index.js";
import { ModelSettingsStore } from "../src/model-settings.js";

function fixture(taskModels?: string[]) {
  const core: Record<string, unknown> = { chatModel: "main:chat", unrelated: { keep: true }, ...(taskModels ? { taskModels } : {}) };
  const connection = {
    id: "main",
    type: "openai",
    apiKey: "private-key",
    baseURL: "https://models.test/v1",
    chatModels: [{ id: "chat", toolCall: true, opaque: "preserved" }, { id: "worker" }, { id: "other" }],
    embeddingModels: [{ id: "vector" }],
    imageModels: [{ id: "image" }],
    opaque: { keep: true },
  };
  const config = {
    plugins: {
      "yesimbot:core": core,
      "yesimbot-model-provider:p": { connections: [connection, { id: "disabled", type: "openai", enabled: false, chatModels: [{ id: "worker" }] }] },
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
  return { store: new ModelSettingsStore(ctx as never), config, reload, connection };
}

describe("managed background-task models", () => {
  it("returns an empty list without adding native configuration or reloading on an unchanged save", async () => {
    const { store, config, reload } = fixture();
    const before = structuredClone(config);
    expect(store.read().taskModels).toEqual([]);
    await store.save(store.read());
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps ordered refs isolated from credentials, native options and mutable snapshots", async () => {
    const { store, config, reload } = fixture(["main:worker", "main:other"]);
    const before = structuredClone(config);
    const snapshot = store.read();
    expect(snapshot.taskModels).toEqual(["main:worker", "main:other"]);
    expect(JSON.stringify(snapshot)).not.toContain("private-key");
    snapshot.taskModels!.reverse();
    expect(store.read().taskModels).toEqual(["main:worker", "main:other"]);
    await store.save(store.read());
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("changes only the Core list and preserves its order and unrelated configuration", async () => {
    const { store, config, reload } = fixture();
    const before = structuredClone(config);
    const saved = await store.save({ ...store.read(), taskModels: ["main:other", "main:worker"] });
    expect(saved.taskModels).toEqual(["main:other", "main:worker"]);
    expect(config.plugins["yesimbot:core"]).toEqual({ ...before.plugins["yesimbot:core"], taskModels: ["main:other", "main:worker"] });
    expect(config.plugins["yesimbot-model-provider:p"]).toEqual(before.plugins["yesimbot-model-provider:p"]);
    expect(reload.mock.calls.map(([, key]) => key)).toEqual(["yesimbot:core"]);
  });

  it("preserves omitted lists for old clients and distinguishes an explicit empty list", async () => {
    const { store, config, connection } = fixture(["main:worker", "main:other"]);
    const before = structuredClone(config.plugins["yesimbot:core"]);
    const draft = store.read();
    delete draft.taskModels;
    draft.connections[0].chatModels[0].toolCall = false;
    await store.save(draft);
    expect(config.plugins["yesimbot:core"]).toEqual(before);
    expect(connection.apiKey).toBe("private-key");
    await store.save({ ...store.read(), taskModels: [] });
    expect(store.read().taskModels).toEqual([]);
    expect(config.plugins["yesimbot:core"]).toEqual({ ...before, taskModels: [] });
  });

  it("preserves unchanged stale native references for no-op and old-client saves without silently repairing them", async () => {
    const { store, config, reload } = fixture(["missing:worker", "disabled:worker"]);
    const before = structuredClone(config);
    await store.save(store.read());
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
    const draft = store.read();
    delete draft.taskModels;
    draft.connections[0].chatModels.push({ id: "new" });
    await store.save(draft);
    expect(store.read().taskModels).toEqual(["missing:worker", "disabled:worker"]);
    await expect(store.save({ ...store.read(), taskModels: ["disabled:worker", "missing:worker"] })).rejects.toMatchObject({ status: 400 });
    expect((await store.save({ ...store.read(), taskModels: [] })).taskModels).toEqual([]);
  });

  it.each([
    null,
    "main:worker",
    [""],
    [" "],
    [1],
    ["x".repeat(513)],
    ["main:worker", "main:worker"],
    Array(101).fill("main:worker"),
    ["main:vector"],
    ["main:image"],
    ["disabled:worker"],
    ["missing:worker"],
  ])("rejects invalid task list %j before any write", async (taskModels) => {
    const { store, config, reload } = fixture();
    const before = structuredClone(config);
    await expect(store.save({ ...store.read(), taskModels })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("后台任务模型") });
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(["remove-model", "remove-connection", "disable"])("rejects %s while an omitted old-client list still references the model", async (action) => {
    const { store, config, reload } = fixture(["main:worker"]);
    const before = structuredClone(config);
    const draft = store.read();
    delete draft.taskModels;
    // Keep all scalar roles valid so this is specifically the task reference guard.
    draft.roles.chatModel = "";
    if (action === "remove-model") draft.connections[0].chatModels = draft.connections[0].chatModels.filter((m) => m.id !== "worker");
    if (action === "remove-connection") draft.connections.shift();
    if (action === "disable") draft.connections[0].enabled = false;
    await expect(store.save(draft)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("请先移除") });
    expect(config).toEqual(before);
    expect(reload).not.toHaveBeenCalled();
  });

  it("allows removal and explicit cleanup in the same revision and keeps other refs ordered", async () => {
    const { store } = fixture(["main:worker", "main:other"]);
    const draft = store.read();
    draft.connections[0].chatModels = draft.connections[0].chatModels.filter((m) => m.id !== "worker");
    draft.taskModels = ["main:other"];
    expect((await store.save(draft)).taskModels).toEqual(["main:other"]);
  });

  it("keeps independent runtime instances' task policies separate", async () => {
    const first = fixture(["main:worker"]),
      second = fixture(["main:other"]);
    await first.store.save({ ...first.store.read(), taskModels: [] });
    expect(first.store.read().taskModels).toEqual([]);
    expect(second.store.read().taskModels).toEqual(["main:other"]);
    expect(second.reload).not.toHaveBeenCalled();
  });
});

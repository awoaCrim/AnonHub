import { describe, expect, it, vi } from "vitest";

import { moduleConfig as providerConfig } from "../../../providers/model-provider/src/index.js";
import { ModelSettingsStore } from "../src/model-settings.js";
import { selectModelThinkingLevel } from "../web/src/lib/model-thinking";

function fixture(type = "openai", model: Record<string, unknown> = {}) {
  const connection = {
    type,
    id: "existing",
    apiKey: "private-key",
    opaque: { retained: "private" },
    chatModels: [{ id: "model", reasoning: true, toolCall: true, sdkSecret: "keep", ...model }],
    embeddingModels: [],
  };
  const disabled = { enabled: false, type: "custom", id: "disabled", thinkingLevel: "opaque", thinkingLevelMap: { custom: "keep" } };
  const config = {
    plugins: {
      "group:models": { "yesimbot-model-provider:provider": { connections: [connection, disabled] } },
      "yesimbot:core": { chatModel: "existing:model", auxiliaryModel: "existing:model" },
    },
  };
  const group = { scope: { [Symbol.for("koishi.loader.record")]: {} } };
  const root = { scope: { [Symbol.for("koishi.loader.record")]: { "group:models": { ctx: group } } } };
  const reload = vi.fn(async (_parent: unknown, key: string, value: unknown) => {
    config.plugins["group:models"][key] = structuredClone(value);
    return { isActive: true };
  });
  const ctx = {
    get: () => ({}),
    registry: { values: () => [] },
    lifecycle: { flush: async () => {} },
    loader: {
      config,
      writable: true,
      entry: root,
      isTruthyLike: () => true,
      writeConfig: vi.fn(),
      reload,
      resolve: async () => ({ moduleConfig: providerConfig }),
    },
  };
  const native = () => config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[0];
  return { store: new ModelSettingsStore(ctx as never), config, reload, native };
}

describe("managed thinking settings", () => {
  it.each(["openai", "anthropic", "deepseek"])("round-trips explicit xhigh/max selections through the actual %s schema", async (protocol) => {
    const { store, native, config } = fixture(protocol);
    for (const level of ["xhigh", "max"] as const) {
      const draft = store.read();
      selectModelThinkingLevel(protocol, draft.connections[0].chatModels[0], level);
      const saved = await store.save(draft);
      expect(saved.connections[0].chatModels[0]).toMatchObject({ thinkingLevel: level, thinkingLevelMap: { [level]: level } });
      expect(native().chatModels[0]).toMatchObject({ thinkingLevel: level, thinkingLevelMap: { [level]: level }, sdkSecret: "keep" });
      expect(native()).toMatchObject({ apiKey: "private-key", opaque: { retained: "private" } });
      expect(config.plugins["group:models"]["yesimbot-model-provider:provider"].connections[1]).toEqual({
        enabled: false,
        type: "custom",
        id: "disabled",
        thinkingLevel: "opaque",
        thinkingLevelMap: { custom: "keep" },
      });
      expect(store.read()).toEqual(saved);
    }
  });

  it.each(["xhigh", "max"])("keeps an old unmapped %s configuration as an exact no-op", async (level) => {
    const { store, config, reload } = fixture("openai", { thinkingLevel: level });
    const original = structuredClone(config);
    expect(store.read().connections[0].chatModels[0]).toMatchObject({ thinkingLevel: level });
    await store.save(store.read());
    expect(config).toEqual(original);
    expect(reload).not.toHaveBeenCalled();
  });

  it("preserves extended custom maps, null markers and opaque native fields through no-op and an unrelated model edit", async () => {
    const { store, config, reload, native } = fixture("google", { thinkingLevel: "xhigh", thinkingLevelMap: { xhigh: "high", max: null } });
    const original = structuredClone(config);
    const draft = store.read();
    expect(draft.connections[0].chatModels[0].thinkingLevelMap).toEqual({ xhigh: "high", max: null });
    await store.save(draft);
    expect(config).toEqual(original);
    expect(reload).not.toHaveBeenCalled();
    draft.connections[0].chatModels[0].toolCall = false;
    await store.save(draft);
    expect(native().chatModels[0]).toMatchObject({
      toolCall: false,
      thinkingLevel: "xhigh",
      thinkingLevelMap: { xhigh: "high", max: null },
      sdkSecret: "keep",
    });
  });

  it("rejects a Google native extended value without writing configuration", async () => {
    const { store, config, reload } = fixture("google");
    const original = structuredClone(config);
    const draft = store.read();
    draft.connections[0].chatModels[0].thinkingLevel = "max";
    draft.connections[0].chatModels[0].thinkingLevelMap = { max: "max" };
    await expect(store.save(draft)).rejects.toMatchObject({ status: 400 });
    expect(config).toEqual(original);
    expect(reload).not.toHaveBeenCalled();
  });

  it("continues rejecting unknown thinking levels", async () => {
    const { store, config, reload } = fixture();
    const original = structuredClone(config);
    const draft = store.read();
    Object.assign(draft.connections[0].chatModels[0], { thinkingLevel: "ultra" });
    await expect(store.save(draft)).rejects.toMatchObject({ status: 400 });
    expect(config).toEqual(original);
    expect(reload).not.toHaveBeenCalled();
  });
});

import { expect, it } from "vitest";

import { modelPickers, type ModelLists } from "../src/config/model-pickers.js";

it("builds one picker per model list from the registry, hiding hidden models", () => {
  const models: ModelLists = {
    listChatModels: () => [
      { fullId: "fake:main", config: {} },
      { fullId: "fake:hidden", config: { hidden: true } },
    ],
    listEmbeddingModels: () => [{ fullId: "fake:embed", config: {} }],
    listImageModels: () => [],
  };
  const pickers = modelPickers(models);
  expect(Object.keys(pickers)).toEqual(["registry.chatModels", "registry.embeddingModels", "registry.imageModels"]);
  const choice = (value: string) => ({ type: "const", meta: { description: value }, value });
  expect(pickers["registry.chatModels"]).toEqual({
    type: "union",
    meta: { default: "" },
    list: [choice("fake:main"), { type: "string", meta: { description: "Custom model (provider:model)" } }],
  });
  expect(pickers["registry.embeddingModels"]).toEqual({
    type: "union",
    meta: { default: "" },
    list: [choice("fake:embed"), { type: "string", meta: { description: "Custom model (provider:model)" } }],
  });
  expect(pickers["registry.imageModels"]).toEqual({
    type: "union",
    meta: {},
    list: [{ type: "string", meta: { description: "Custom Images model (provider:model)" } }],
  });
});

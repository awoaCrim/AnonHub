import type { PluginSchemaNode } from "../shared/plugin-config.js";

/** What the pickers read of Core's model registry. */
export interface ModelLists {
  listChatModels(): ReadonlyArray<{ fullId: string; config: { hidden?: boolean } }>;
  listEmbeddingModels(): ReadonlyArray<{ fullId: string; config: { hidden?: boolean } }>;
  listImageModels(): ReadonlyArray<{ fullId: string; config: { hidden?: boolean } }>;
}

/**
 * The model pickers of config forms (`registry.*` dynamic schemas) as form nodes. Read afresh, so they follow the registry.
 */
export function modelPickers(models: ModelLists): Record<string, PluginSchemaNode> {
  const choices = (list: ReturnType<ModelLists["listChatModels"]>, custom: string): PluginSchemaNode[] => [
    ...list.filter((model) => !model.config.hidden).map((model) => ({ type: "const", meta: { description: model.fullId }, value: model.fullId })),
    { type: "string", meta: { description: custom } },
  ];
  return {
    "registry.chatModels": { type: "union", meta: { default: "" }, list: choices(models.listChatModels(), "Custom model (provider:model)") },
    "registry.embeddingModels": { type: "union", meta: { default: "" }, list: choices(models.listEmbeddingModels(), "Custom model (provider:model)") },
    // No default: an absent image role stays distinguishable from an explicitly disabled one.
    "registry.imageModels": { type: "union", meta: {}, list: choices(models.listImageModels(), "Custom Images model (provider:model)") },
  };
}

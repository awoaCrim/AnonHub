import { EphemeralImageProjectionStore, type AgentPlugin } from "@yesimbot/agent-runtime";
import { errorFields, logger, parseConfig } from "@yesimbot/foundation";
import { type CoreService, defineExtension, protectPluginTools, type ImageModelAdapter } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { createEditImageTool } from "./image-edit.js";
import { createGenerateImageTool } from "./image-generation.js";
import { ImageOutputBudget } from "./image-output.js";

/** Image generation and editing tools for chats; the Images models come from the model purposes. */
export const extension = defineExtension({
  moduleConfig,
  parse: (raw) => parseConfig(moduleConfig, raw ?? {}),
  start: (ctx) => registerTools(ctx.core),
});

/** Timeout for generation requests (including their reference reads) and edit provider requests. */
const IMAGE_REQUEST_TIMEOUT_MS = 120_000;

const log = logger("yesimbot.image-tools");

function registerTools(core: CoreService): (() => void) | undefined {
  const selectedModel = core.config?.imageModel;
  if (!selectedModel?.trim()) return undefined;

  const disposeAgentPlugin = core.agent.use({
    id: "yesimbot-image-tools",
    async setup(scope, _bot, runtime) {
      const modelId = selectedModel.trim();
      const editModelId = core.config.imageEditModel?.trim() || modelId;
      let generation: ImageModelAdapter;
      let editing: ImageModelAdapter;
      try {
        generation = core.model.resolveImage(modelId);
        editing = editModelId === modelId ? generation : core.model.resolveImage(editModelId);
      } catch (cause) {
        // An unavailable Images connection must not break ordinary chat or use a chat fallback.
        log.warn("image_tools.model_unavailable", { model: modelId, editModel: editModelId, ...errorFields(cause) });
        return null;
      }
      const resources = await core.resource.get(scope);
      const imageProjection = runtime?.imageProjection ?? new EphemeralImageProjectionStore();
      const budget = new ImageOutputBudget();
      const logFailure = (detail: string) => log.warn("image_tools.request_failed", { detail });
      return protectPluginTools(
        {
          name: "image-tools",
          tools: () => [
            createGenerateImageTool({
              imageModel: generation.model,
              modelId,
              referenceModelId: editModelId,
              edit: editing.edit,
              timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
              resources,
              imageProjection,
              budget,
              logFailure,
            }),
            createEditImageTool({
              modelId: editModelId,
              edit: editing.edit,
              timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
              resources,
              imageProjection,
              budget,
              logFailure,
            }),
          ],
          onTurnFinish: (_result, context) => {
            budget.clearTurn(context.turnId);
            imageProjection.clearTurn(context.turnId);
          },
          stop: () => {
            budget.clearAll();
            imageProjection.clearAll();
          },
        } satisfies AgentPlugin,
        await core.identity.conversation({ ...scope, selfId: scope.selfId ?? _bot.selfId }),
        moduleConfig.id,
      );
    },
  });

  return disposeAgentPlugin;
}

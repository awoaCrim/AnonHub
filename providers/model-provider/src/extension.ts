import { AppError, checkConfig } from "@yesimbot/foundation";
import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { createAnthropicProvider } from "./anthropic.js";
import { moduleConfig } from "./config.js";
import { activeConnections, type Config, type ProtocolConfig } from "./connections.js";
import { createDeepSeekProvider } from "./deepseek.js";
import { MODEL_PROVIDER_ERRORS } from "./errors.js";
import { createGoogleProvider } from "./google.js";
import { createOpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./provider.js";

/** Every active connection registers its provider with Core's model registry. */
export const extension = defineExtension({
  moduleConfig,
  parse(raw) {
    // Diagnostics may contain input values, including credentials: no cause, no detail (so not `parseConfig`).
    const checked = checkConfig(moduleConfig.schema, raw ?? {});
    if (!checked.ok) throw new AppError(MODEL_PROVIDER_ERRORS.model_provider_config_invalid, { effect: "none" });
    // The protocol interfaces (what the providers accept) describe the parsed value; zod's inferred intersections do not narrow to them.
    const config = checked.value as Config;
    activeConnections(config);
    return config;
  },
  start(ctx) {
    const disposers: Array<() => void> = [];
    const undo = () => {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    };
    try {
      for (const connection of activeConnections(ctx.config)) disposers.push(ctx.core.model.register(createProvider(connection)));
    } catch (error) {
      undo();
      throw error;
    }
    return undo;
  },
});

function createProvider(config: ProtocolConfig): ModelProvider {
  switch (config.type) {
    case "openai":
      return createOpenAIProvider(config);
    case "anthropic":
      return createAnthropicProvider(config);
    case "google":
      return createGoogleProvider(config);
    case "deepseek":
      return createDeepSeekProvider(config);
  }
}

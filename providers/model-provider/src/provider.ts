import type { CoreService } from "koishi-plugin-yesimbot/kernel";

/** One connection as Core's model registry takes it. */
export type ModelProvider = Parameters<CoreService["model"]["register"]>[0];

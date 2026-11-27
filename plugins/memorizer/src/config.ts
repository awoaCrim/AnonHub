import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const moduleConfig = defineModuleConfig("yesimbot-memorizer", z.looseObject({}));

export type MemorizerConfig = Config;

export type Config = z.output<typeof moduleConfig.schema>;

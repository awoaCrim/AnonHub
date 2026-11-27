import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const moduleConfig = defineModuleConfig("yesimbot-schedule", z.looseObject({}));

export type Config = z.output<typeof moduleConfig.schema>;

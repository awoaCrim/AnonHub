import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

/** The plugin has no operator settings; history, window and refresh timing are fixed. */
export const moduleConfig = defineModuleConfig("yesimbot-usage", z.looseObject({}));

export type Config = z.output<typeof moduleConfig.schema>;

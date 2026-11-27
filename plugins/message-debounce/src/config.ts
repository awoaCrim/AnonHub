import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const moduleConfig = defineModuleConfig(
  "yesimbot-message-debounce",
  z.looseObject({
    quietSeconds: z.number().min(0.1).max(3_600).default(15).meta({ title: "对方停下多少秒后再回（秒）" }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

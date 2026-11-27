import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

/** The library is edited on the role page (cards by id under `data/yesimbot/characters`), never in this form. */
const moduleConfig = defineModuleConfig(
  "yesimbot-roleplay",
  z.looseObject({
    characterCard: z.string().optional().meta({ title: "全平台默认角色卡", hidden: true }),
    characterCards: z.array(z.string()).default([]).meta({ title: "角色库", hidden: true }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

export { moduleConfig };

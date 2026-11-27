import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

/**
 * `config/adapter-onebot.json`: the module ID Koishi's adapter had, so the stage-7 split's file is this connector's
 * config as it stands. NapCat dials `path` (a bearer secret: 64 hex characters on a managed install, `/onebot` on old
 * ones); `token`, when set, must also come as `Authorization: Bearer`. `selfId` admits only that QQ (an account the
 * runtime manager bound); without it the connector takes the QQ NapCat signed in to.
 */
export const moduleConfig = defineModuleConfig(
  "adapter-onebot",
  z.looseObject({
    selfId: z
      .string()
      .regex(/^[1-9][0-9]{4,14}$/)
      .optional()
      .meta({ title: "QQ 号", hidden: true }),
    protocol: z.literal("ws-reverse").default("ws-reverse").meta({ hidden: true }),
    path: z
      .string()
      .regex(/^\/[!-~]{1,255}$/)
      .default("/onebot")
      .meta({ title: "反向连接路径", secret: true, hidden: true }),
    token: z.string().optional().meta({ title: "访问令牌", secret: true, hidden: true }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

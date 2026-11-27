import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const moduleConfig = defineModuleConfig(
  "yesimbot-sticker-manager",
  z.looseObject({
    scope: z
      .union([z.literal("global").meta({ title: "本机器人共用" }), z.literal("channel").meta({ title: "按会话隔离" })])
      .default("channel")
      .meta({ title: "表情库范围\n选择所有会话共用，或每个会话独立收藏。" }),
    tagMode: z.boolean().default(false).meta({ title: "自动标签\n实验性：收藏时自动标注，支持按标签查询和筛选，默认关闭。" }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

export type StickerConfig = Config;

export type StickerScopeMode = Config["scope"];

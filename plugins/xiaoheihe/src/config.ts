import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const moduleConfig = defineModuleConfig(
  "yesimbot-xiaoheihe",
  z.looseObject({
    selfId: z.string().meta({ title: "绑定账号\n小黑盒账号 userid；登录账号不匹配时拒绝使用" }),
    nativeEmojis: z.boolean().default(true).meta({ title: "使用小黑盒表情\n允许在发布的内容里自然使用小黑盒原生表情；目录不可用时退回纯文字" }),
    dailyPostLimit: z.number().int().min(0).max(1000).default(1).meta({ title: "每日发帖上限\n0 禁止发帖；Asia/Shanghai 自然日重置", unit: "篇" }),
    dailyInteractionLimit: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(10)
      .meta({ title: "每日评论和回复上限\n评论和回复合计，0 禁止互动；结果不确定的尝试也占额度", unit: "条" }),
    communities: z.array(z.string()).default([]).meta({ title: "发帖社区\n完整社区名；空数组使用上游的小黑盒动态区默认值" }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

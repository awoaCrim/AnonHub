import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const moduleConfig = defineModuleConfig(
  "yesimbot-onebot-utils",
  z.looseObject({
    moderationGroups: z.array(z.string()).default([]).meta({
      title: "允许群管理的群\n填群号。在这些群里，群主或管理员可以让它禁言、解禁或移出成员；普通群员的要求不执行。它自己也需要是该群管理员。",
      widget: "table",
    }),
    encourageReactions: z
      .boolean()
      .default(false)
      .meta({ title: "鼓励贴表情回应\n收到消息后，鼓励模型按语境给原消息贴表情，也可代替不必要的文字确认；不是每条自动贴，需要允许使用表态工具。" }),
    quoteReplyAfterMessages: z.number().min(0).default(5).meta({
      title: "引用原消息的间隔\nQQ 群聊中，待回复消息之后已有至少多少条可见消息时，要求引用原消息。0 表示关闭；仅按模型当前可见消息判断。",
      unit: "条",
    }),
    parseImages: z.boolean().default(false).meta({ title: "读取转发图片信息\n把转发记录里的图片交给模型时附带文件名和大小；关闭时显示为 [图片]。" }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

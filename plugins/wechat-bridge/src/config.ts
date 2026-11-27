import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

const moduleConfig = defineModuleConfig(
  "adapter-wechat-bridge",
  z.looseObject({
    allowedRooms: z.array(z.string()).default([]).meta({ title: "允许接入的群", description: "填写群 ID，如 123456789@chatroom。" }),
    allowedPeers: z.array(z.string()).default([]).meta({ title: "允许私聊的联系人", description: "填写对方 wxid；空列表不接受私聊。" }),
    autoReply: z
      .looseObject({
        group: z.boolean().default(false).meta({ title: "群聊自动回复" }),
        direct: z.boolean().default(false).meta({ title: "私聊自动回复" }),
      })
      .prefault({})
      .meta({ title: "自动回复", description: "群聊与私聊分别开启，且必须在上述允许范围内。" }),
    /** The agent-wechat daemon in the same runtime container. */
    endpoint: z.string().default("http://127.0.0.1:6174").meta({ title: "agent-wechat 服务地址", hidden: true }),
    /** Its owner token, relative to the state base directory. */
    tokenFile: z.string().default("data/agent-wechat/api-token").meta({ title: "agent-wechat 访问令牌文件", hidden: true }),
    /** The daemon account (ID or alias) this adapter speaks for. */
    account: z.string().default("bot").meta({ title: "agent-wechat 账号", hidden: true }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

/** A WeChat group's thread ID ends like this; every other thread is a direct chat with that peer. */
export function isGroupThread(threadId: string): boolean {
  return threadId.endsWith("@chatroom");
}

export { moduleConfig };

import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const moduleConfig = defineModuleConfig(
  "yesimbot-console",
  z.looseObject({
    admin: z
      .looseObject({
        enabled: z.boolean().default(false).meta({ title: "使用单管理员登录替代 Koishi 多用户认证" }),
        credentialFile: z.string().default("data/console-admin/credential.json").meta({ title: "管理员密码摘要文件，由安装器创建", hidden: true }),
        sessionHours: z.number().min(1).max(168).default(168).meta({ title: "管理员登录有效小时数" }),
        publicOrigin: z.string().default("").meta({ title: "HTTPS 反向代理的公开来源，例如 https://bot.example.com；直接访问时留空" }),
        additionalOrigins: z.array(z.string()).default([]).meta({ title: "额外允许的精确 HTTP(S) 来源，例如 http://192.168.1.10:5140；需要配置 publicOrigin" }),
      })
      .prefault({})
      .meta({ title: "管理员登录" }),
    accounts: z
      .looseObject({
        enabled: z.boolean().default(false).meta({ title: "为客户创建独立的机器人运行实例，由宿主运行管理器启动" }),
        // Written by the account-manager installer; not edited in forms.
        usersFile: z.string().default("data/console-admin/accounts.json").meta({ hidden: true }),
        managerEndpoint: z.string().default("").meta({ hidden: true }),
        managerKeyFile: z.string().default("data/console-admin/runtime-manager.key").meta({ hidden: true }),
        ownerRuntimeId: z.string().optional().meta({ title: "管理员自己的 bot 运行实例 ID；配置后机器人页面由该实例提供", hidden: true }),
        ownerOneBotPath: z.string().optional().meta({ title: "保留原 QQ 反向连接路径，用于本机实例转接", hidden: true }),
      })
      .prefault({})
      .meta({ title: "独立账户" }),
    napcat: z
      .looseObject({
        enabled: z.boolean().default(false).meta({ title: "在后台管理同容器内的 NapCat 登录" }),
        endpoint: z.string().default("http://127.0.0.1:6099").meta({ title: "NapCat WebUI 的容器内回环地址", hidden: true }),
        webuiConfigFile: z.string().default("/app/napcat/config/webui.json").meta({ title: "NapCat WebUI 配置文件，仅由服务端读取", hidden: true }),
      })
      .prefault({})
      .meta({ title: "QQ 接入" }),
    wechat: z
      .looseObject({
        enabled: z.boolean().default(false).meta({ title: "在后台管理同容器内的微信登录" }),
        endpoint: z.string().default("http://127.0.0.1:6174").meta({ title: "agent-wechat 的容器内回环地址", hidden: true }),
        tokenFile: z.string().default("data/agent-wechat/api-token").meta({ title: "agent-wechat 访问令牌文件，仅由服务端读取", hidden: true }),
        account: z.string().default("bot").meta({ title: "agent-wechat 账号", hidden: true }),
      })
      .prefault({})
      .meta({ title: "微信接入" }),
    webui: z
      .looseObject({
        enabled: z.boolean().default(false).meta({ title: "启用独立 WebUI（接管根路径 /），需要单管理员登录" }),
        koishiPath: z.string().default("/koishi").meta({ title: "Koishi 原生控制台的 uiPath，WebUI 不接管该路径", hidden: true }),
        contactEmail: z.string().trim().max(254).default("").meta({ title: "公开页面的联系邮箱" }),
      })
      .prefault({})
      .meta({ title: "独立 WebUI" }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

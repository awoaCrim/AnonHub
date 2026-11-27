/** Core's settings: the zod definition of `koishi.yml`'s `yesimbot` entry and the plain shapes the kernel reads. */
import { REPLY_TRIGGER_DEFAULTS, REPLY_TRIGGER_PLATFORMS } from "@yesimbot/contracts/reply-triggers";
import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

const moduleConfig = defineModuleConfig(
  "yesimbot",
  z.looseObject({
    basePath: z.string().default("data/yesimbot").meta({ title: "数据存储目录", widget: "path", group: "基础配置" }),
    chatModel: chatModel("默认对话模型").meta({ group: "基础配置" }),
    taskModels: z
      .array(z.string().meta({ optionsSource: "models.chat" }))
      .default([])
      .meta({ title: "后台任务可用模型，按顺序以首个为默认；留空使用当前会话的有效模型", group: "基础配置" }),
    auxiliaryModel: chatModel("所有非主对话用途的辅助模型；缺失或不可用时辅助任务失败，不回退到主模型").meta({ group: "基础配置" }),
    visionModel: chatModel("图片理解使用的模型；选择即启用该模型的图片输入，可与默认对话模型相同；留空关闭独立识图").meta({ group: "基础配置" }),
    embeddingModel: z
      .string()
      .optional()
      .meta({ title: "向量检索模型；长期记忆按含义检索时使用，留空则只按关键词", optionsSource: "models.embedding", group: "基础配置" }),
    imageModel: z.string().optional().meta({ title: "图片生成模型；留空关闭生图工具", optionsSource: "models.image", group: "基础配置" }),
    imageEditModel: z.string().optional().meta({ title: "参考图生成与编辑模型；留空使用图片生成模型", optionsSource: "models.image", group: "基础配置" }),
    logLevel: z
      .union([
        z.literal(0).meta({ title: "None" }),
        z.literal(1).meta({ title: "Error" }),
        z.literal(2).meta({ title: "Info" }),
        z.literal(3).meta({ title: "Debug" }),
      ])
      .default(2)
      .meta({ title: "日志级别", group: "基础配置" }),
    allowedChannels: z
      .array(
        z.looseObject({
          platform: z.string().optional().meta({ title: "平台名称；* 匹配任意平台" }),
          channelId: z.string().optional().meta({ title: "频道 ID；* 匹配任意频道" }),
          isDirect: z.boolean().optional().meta({ title: "是否仅匹配私聊；留空则不限制" }),
        }),
      )
      .default([])
      .meta({ title: "允许接收消息的频道；默认拒绝全部频道", widget: "table", group: "基础配置" }),
    admins: z
      .array(z.looseObject({ platform: z.string().meta({ title: "平台" }), userId: z.string().meta({ title: "账号 ID（QQ 号、微信 ID 等）" }) }))
      .default([])
      .meta({ title: "管理员：只有这些账号能让 bot 调用敏感工具；网页对话里登录的人始终是管理员", widget: "table", group: "基础配置" }),
    replyTriggers: z
      .looseObject({
        platforms: z.array(z.enum(REPLY_TRIGGER_PLATFORMS.map((platform) => platform.id) as [string, ...string[]])).default([]),
        rules: z.looseObject(Object.fromEntries(Object.entries(REPLY_TRIGGER_DEFAULTS).map(([key, value]) => [key, z.boolean().default(value)]))).prefault({}),
      })
      .prefault({})
      .meta({ title: "固定回复触发规则", group: "模型输入与资源读取" }),
    imageInput: z.boolean().default(true).meta({ title: "允许支持图片输入的模型直接接收当前消息图片，并通过 read 工具读取图片", group: "模型输入与资源读取" }),
    videoInput: z.boolean().default(false).meta({
      title: "为当前默认对话模型启用 MP4 视频输入；请确认模型支持视频；原件最多 200 MiB，超过 50 MiB 时自动压缩并保留原件；默认关闭",
      group: "模型输入与资源读取",
    }),
    modelRetries: z.number().min(0).max(5).default(3).meta({
      title: "模型请求（对话和后台任务）遇到 HTTP 408、429、5xx、临时网络故障或响应中途断流时的最大重试次数；仅重试尚未提交的模型步骤，不重复执行已完成的工具",
      group: "模型输入与资源读取",
    }),
    maxSteps: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(100)
      .meta({ title: "单轮最多调用工具的步数；用完后让模型简短告诉对方做到哪里、还差什么，再结束本轮", group: "模型输入与资源读取" }),
    resourceReadTimeout: z.number().min(1).default(30).meta({ title: "上传图片/文件下载及资源读取的超时时间（秒）", group: "模型输入与资源读取" }),
    pacing: z
      .looseObject({
        charactersPerSecond: z.number().min(1).default(8).meta({ title: "send_message 相邻消息之间的发送速度（字符/秒）" }),
        maxTotalDelayMs: z.number().min(1).default(60_000).meta({ title: "单次 send_message 调用的最大累计延迟（毫秒）" }),
      })
      .prefault({})
      .meta({ title: "消息发送节奏" }),
    customInnerThought: z
      .boolean()
      .default(false)
      .meta({ title: "为 send_message 和 finish 提供 inner_thought 字段，记录不发送的简短行为判断（包括为什么不说话）；默认关闭" }),
    session: z
      .looseObject({
        archive: z
          .looseObject({
            maxKB: z
              .number()
              .min(0)
              .default(5 * 1024)
              .meta({ title: "单个会话文件归档上限（KB）；0 = 禁用" }),
          })
          .prefault({})
          .meta({ title: "自动归档" }),
        magicContext: z
          .looseObject({
            // The minimum equals MIN_CONTEXT_TRIGGER_TOKENS (runtimes/context-policy.ts); a test keeps them equal.
            triggerTokens: z.number().int().min(8000).optional().meta({
              title: "开始整理的长度（Token）；留空为 100000。主模型实际输入达到它时后台整理，整理目标为它的 80%；这是唯一的长度设置，模型容量据此推算",
            }),
          })
          .prefault({})
          .meta({ title: "Magic Context" }),
      })
      .prefault({})
      .meta({ title: "会话管理" }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

/** A row of `allowedChannels`; a row missing `platform` or `channelId` matches nothing. */
export type ChannelAllowRule = Config["allowedChannels"][number];

export type PacingConfig = Config["pacing"];

/** `triggerTokens`: actual main-model input that starts background summaries; unset means 100000. */
export type MagicContextConfig = Config["session"]["magicContext"];

/** Who may have the bot run sensitive tools, per platform (user, 2026-11-18). The web chat's login always may. */
export type AdminAccount = Config["admins"][number];

function chatModel(title: string) {
  return z.string().optional().meta({ title, optionsSource: "models.chat" });
}

export { moduleConfig };

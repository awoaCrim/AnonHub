import { defineModuleConfig } from "@yesimbot/foundation";
import { thinkingLevelMapConfig, THINKING_LEVELS } from "koishi-plugin-yesimbot/kernel";
import { z } from "zod/v4";

import { defaultImageToolResultMediaTypes } from "./google.js";

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const OPENAI_CHAT_MODELS = [
  { id: "gpt-4o", toolCall: true, reasoning: true },
  { id: "gpt-5.4", toolCall: true, reasoning: true },
  { id: "gpt-5.5", toolCall: true, reasoning: true },
  { id: "gpt-5.6-luna", toolCall: true, reasoning: true },
];

const openaiShape = {
  ...common("openai"),
  imageToolResultSupport: z
    .union([
      z.literal("native").meta({ title: "原生结构化图片工具结果" }),
      z.literal("unsupported").meta({ title: "不支持原生图片工具结果，读取时明确返回图片不可用" }),
      z.literal("unknown").meta({ title: "能力未知，按不支持处理" }),
    ])
    .optional()
    .meta({ title: "图片工具结果能力覆盖；留空时按 API 格式推导" }),
  imageToolResultPlacement: z
    .union([z.literal("tool-output").meta({ title: "图片保留在工具结果中" }), z.literal("user-message").meta({ title: "图片提升为当前请求的临时用户消息" })])
    .default("tool-output")
    .meta({ title: "原生图片工具结果的请求位置" }),
  chatModels: chatModels(
    OPENAI_CHAT_MODELS,
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    "使用 OpenAI 默认行为",
    "逐模型覆写通用等级到 OpenAI reasoningEffort；null 表示该等级不可用",
  ),
  embeddingModels: modelTable()
    .default([{ id: "text-embedding-3-small" }, { id: "text-embedding-3-large" }])
    .meta({ title: "可用嵌入模型列表" }),
  imageModels: modelTable().default([]).meta({ title: "图片生成与编辑模型列表（Images API）" }),
};

const anthropicShape = {
  ...common("anthropic"),
  webSearch: z.boolean().default(false).meta({ title: "启用原生 Web 搜索" }),
  chatModels: chatModels(
    [
      { id: "claude-opus-4-6", toolCall: true, reasoning: true },
      { id: "claude-sonnet-4-6", toolCall: true, reasoning: true },
      { id: "claude-haiku-4-5-20251001", toolCall: true, reasoning: true },
    ],
    ["low", "medium", "high", "xhigh", "max"],
    "使用 Anthropic 默认行为",
    "逐模型覆写通用等级到 Anthropic effort；null 表示该等级不可用，off 固定映射为 thinking disabled",
  ),
};

const googleShape = {
  ...common("google"),
  imageToolResultMediaTypes: z
    .array(z.enum(IMAGE_MEDIA_TYPES))
    .default([...defaultImageToolResultMediaTypes])
    .meta({ title: "原生图片工具结果允许的 MIME 类型；未验证的网关线路不要加入 WebP" }),
  chatModels: chatModels(
    [
      { id: "gemini-2.5-flash", toolCall: true, reasoning: true },
      { id: "gemini-2.5-pro", toolCall: true, reasoning: true },
      { id: "gemini-3.1-pro-preview", toolCall: true, reasoning: true },
      { id: "gemini-3.5-flash", toolCall: true, reasoning: true },
    ],
    ["minimal", "low", "medium", "high"],
    "使用 Google 默认行为",
    "逐模型覆写通用等级到 Google 原生 thinkingLevel 值；null 表示该等级不可用",
  ),
  embeddingModels: modelTable().default([]).meta({ title: "可用嵌入模型列表" }),
  imageModels: modelTable().default([]).meta({ title: "图片生成与编辑模型列表（Gemini 原生接口）" }),
};

const deepseekShape = {
  ...common("deepseek"),
  thinking: z
    .union([
      z.literal("auto").meta({ title: "自适应" }),
      z.literal("none").meta({ title: "关闭" }),
      z.literal("low").meta({ title: "低" }),
      z.literal("medium").meta({ title: "中" }),
      z.literal("high").meta({ title: "高" }),
      z.literal("xhigh").meta({ title: "极高" }),
      z.literal("max").meta({ title: "最大" }),
    ])
    .default("high")
    .meta({ title: "默认思考等级（模型 ID 可用 :level 覆盖；模型行 thinkingLevel 优先于本项）" }),
  chatModels: chatModels(
    [
      { id: "deepseek-v4-flash", toolCall: true, reasoning: true },
      { id: "deepseek-v4-pro", toolCall: true, reasoning: true },
    ],
    ["low", "medium", "high", "xhigh", "max"],
    "使用上方默认思考等级",
    "逐模型覆写通用等级到 DeepSeek reasoningEffort；null 表示该等级不可用，off 固定映射为 thinking disabled",
  ),
};

const typeChoice = z
  .union([
    z.literal("openai").meta({ title: "OpenAI / OpenAI-compatible" }),
    z.literal("anthropic").meta({ title: "Anthropic" }),
    z.literal("google").meta({ title: "Google" }),
    z.literal("deepseek").meta({ title: "DeepSeek" }),
  ])
  .default("openai")
  .meta({ title: "API 协议；与提供商标识独立，同一协议可配置多个连接" });

/** The settings of one connection by protocol (the part after the protocol choice). */
const protocols = z
  .union([
    z.intersection(
      z.looseObject({ type: z.literal("openai").default("openai") }),
      z.intersection(
        z.looseObject({ ...openaiShape, format: z.enum(["chat", "responses"]).default("chat").meta({ title: "API 格式" }) }),
        z.union([
          z.looseObject({ format: z.literal("chat").optional() }),
          z.looseObject({ format: z.literal("responses").optional(), webSearch: z.boolean().default(false).meta({ title: "启用原生 Web 搜索" }) }),
        ]),
      ),
    ),
    z.intersection(z.looseObject({ type: z.literal("anthropic") }), z.looseObject(anthropicShape)),
    z.intersection(z.looseObject({ type: z.literal("google") }), z.looseObject(googleShape)),
    z.intersection(z.looseObject({ type: z.literal("deepseek") }), z.looseObject(deepseekShape)),
  ])
  .meta({ title: "连接与模型" });

const settings = z.intersection(z.looseObject({ type: typeChoice }).meta({ title: "协议选择" }), protocols);

const connection = z.intersection(
  z.looseObject({ enabled: z.boolean().default(true).meta({ title: "启用连接" }) }),
  z.union([
    z.intersection(z.looseObject({ enabled: z.literal(true).default(true) }), settings).meta({ title: "启用连接设置" }),
    z.looseObject({ enabled: z.literal(false) }).meta({ title: "已停用（保留设置）" }),
  ]),
);

const moduleConfig = defineModuleConfig(
  "yesimbot-model-provider",
  z.looseObject({ connections: z.array(connection).meta({ title: "模型连接" }) }).default({ connections: [] }),
);

function modelId() {
  return z.string().meta({ title: "模型 ID" });
}

function modelTable() {
  return z.array(z.looseObject({ id: modelId() })).meta({ widget: "table" });
}

function chatModels(
  defaults: readonly { id: string; toolCall: boolean; reasoning: boolean }[],
  native: readonly string[],
  defaultBehavior: string,
  mapNote: string,
) {
  return (
    z
      .array(
        z.looseObject({
          id: modelId(),
          toolCall: z.boolean().default(true).meta({ title: "工具调用" }),
          reasoning: z.boolean().default(false).meta({ title: "推理" }),
          thinkingLevel: z
            .enum(THINKING_LEVELS)
            .optional()
            .meta({ title: `思考等级；留空时${defaultBehavior}` }),
          thinkingLevelMap: thinkingLevelMapConfig(native).default({}).meta({ title: mapNote }),
        }),
      )
      // Koishi filled each default entry through the item schema; spelling that out keeps the parsed value the same.
      .default(defaults.map((entry) => ({ ...entry, thinkingLevelMap: {} })))
      .meta({ title: "可用聊天模型列表", widget: "table" })
  );
}

/** The fields every connection of any protocol has. */
function common(id: string) {
  return {
    id: z.string().default(id).meta({ title: "提供商标识" }),
    apiKey: z.string().meta({ title: "API Key", secret: true }),
    baseURL: z.string().optional().meta({ title: "API Base URL" }),
  };
}

export { moduleConfig };

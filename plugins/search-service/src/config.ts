import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

const tavilyConfig = z
  .looseObject({
    apiKey: z.string().optional().meta({ title: "API Key\nTavily 搜索与网页提取共用。先用它，直到额度用完或失效，再按顺序换用下面的备用 Key。", secret: true }),
    apiKeys: z
      .array(z.string().meta({ secret: true }))
      .default([])
      .meta({ title: "备用 API Key\n上面的 Key 用完后按顺序使用：一个用完再换下一个，不会轮流使用。" }),
  })
  .meta({ title: "Tavily 连接" });

const searxngConfig = z.intersection(
  z.intersection(
    z
      .looseObject({
        endpoint: z.string().meta({ title: "实例地址\nSearXNG 实例根地址或 /search 地址；网页与图片搜索共用。" }),
        username: z.string().optional().meta({ title: "用户名\n实例启用 HTTP Basic 认证时使用；与密码同时填写。" }),
        password: z.string().optional().meta({ title: "密码\n实例的 HTTP Basic 密码；只发往搜索实例，不发往参考图片站点。", secret: true }),
      })
      .meta({ title: "SearXNG 连接" }),
    z
      .looseObject({
        language: z.string().optional().meta({ title: "默认语言\n网页与图片搜索的默认语言；网页搜索可在单次调用中覆盖。" }),
        safeSearch: z
          .union([z.literal(0).meta({ title: "关闭" }), z.literal(1).meta({ title: "适中" }), z.literal(2).meta({ title: "严格" })])
          .optional()
          .meta({ title: "安全过滤\n网页与图片搜索的安全过滤等级；实际效果取决于实例。" }),
      })
      .meta({ title: "搜索偏好" }),
  ),
  z
    .looseObject({
      engines: z.array(z.string()).default([]).meta({ title: "默认引擎\n仅网页搜索；图片搜索使用实例中已启用的图片引擎，不继承此列表。" }),
      categories: z.array(z.string()).default([]).meta({ title: "默认分类\n仅网页搜索；图片搜索固定使用 images 分类，不继承此列表。" }),
    })
    .meta({ title: "仅网页搜索默认值" }),
);

const moduleConfig = defineModuleConfig(
  "yesimbot-search-service",
  z.intersection(
    z.intersection(
      z
        .looseObject({
          provider: z
            .union([z.literal("tavily").meta({ title: "Tavily" }), z.literal("searxng").meta({ title: "SearXNG" })])
            .default("tavily")
            .meta({ title: "搜索服务\n网页搜索与图片搜索共用的后端；只需填写选中后端的配置。" }),
        })
        .meta({ title: "搜索后端" }),
      z
        .union([
          z.looseObject({ provider: z.literal("tavily").optional(), tavily: tavilyConfig.prefault({}) }),
          z.looseObject({ provider: z.literal("searxng"), searxng: searxngConfig.prefault({} as never) }),
        ])
        .meta({ title: "后端配置" }),
    ),
    z
      .looseObject({
        blacklist: z
          .array(z.string())
          .default([])
          .meta({ title: "屏蔽网址\n搜索候选 URL 过滤正则；同时过滤图片 URL 及已知来源页，不是下载器的网络访问白名单。" }),
      })
      .meta({ title: "结果过滤" }),
  ),
);

export type Config = z.output<typeof moduleConfig.schema>;

export type TavilyConfig = z.output<typeof tavilyConfig>;

export type SearXNGConfig = z.output<typeof searxngConfig>;

export type SearchProviderName = "tavily" | "searxng";

export type SearXNGSafeSearch = 0 | 1 | 2;

export { moduleConfig };

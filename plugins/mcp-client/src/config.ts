import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

const keyValueTable = z.record(z.string(), z.string()).meta({ title: "逐项填写", widget: "table" });

const remoteFields = {
  url: z.string().meta({ title: "地址" }),
  headers: z
    .union([keyValueTable, z.string().meta({ title: "整段文本\n每行一个 KEY: VALUE", widget: "textarea" })])
    .optional()
    .meta({ title: "请求头\n可选，例如 Authorization" }),
  /** Owner-only file holding a Bearer token. Mutually exclusive with an explicit `Authorization` header. */
  bearerTokenFile: z
    .string()
    .optional()
    .meta({ title: "令牌文件\n服务器上只有主人能读（600）的文件，内容是一行 Bearer 令牌；和 Authorization 请求头二选一，读不到时拒绝连接" }),
};

const mcpServer = z.intersection(
  z.looseObject({
    enable: z.boolean().default(true).meta({ title: "启用" }),
    /** Defaults to true; false bypasses confirmation for this server's tools. */
    requireConfirmation: z.boolean().default(true).meta({ title: "调用前先问我\n有外部影响或风险未知的工具，先问你再执行；关掉则直接执行" }),
    type: z
      .union([
        z.literal("stdio").meta({ title: "本地命令" }),
        z.literal("http").meta({ title: "HTTP（远程服务）" }),
        z.literal("sse").meta({ title: "SSE（远程服务）" }),
      ])
      .optional()
      .meta({ title: "连接方式" }),
  }),
  z.union([
    z.looseObject({
      type: z.literal("stdio"),
      command: z.string().meta({ title: "命令" }),
      args: z.array(z.string()).default([]).meta({ title: "命令参数", widget: "table" }),
      env: z
        .union([keyValueTable, z.string().meta({ title: "整段文本\n每行一个 KEY=VALUE", widget: "textarea" })])
        .optional()
        .meta({ title: "环境变量" }),
    }),
    z.looseObject({ type: z.literal("http"), ...remoteFields }),
    z.looseObject({ type: z.literal("sse"), ...remoteFields }),
  ]),
);

const moduleConfig = defineModuleConfig(
  "yesimbot-mcp-client",
  z.looseObject({
    mcpServers: z.record(z.string(), mcpServer).default({}).meta({ title: "MCP 服务器" }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

export { moduleConfig };

import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const moduleConfig = defineModuleConfig(
  "yesimbot-device-connection",
  z.looseObject({
    gateway: z.string().optional().meta({ title: "远程设备网关的 HTTPS 地址", hidden: true }),
    localGateway: z.string().optional().meta({ title: "同一台服务器上的设备网关内网地址；连不上时改用公网地址", hidden: true }),
    credentialFile: z.string().optional().meta({ title: "此运行实例的设备网关凭证文件；由部署配置提供", hidden: true }),
    localConfigFile: z.string().optional().meta({ title: "本机运行配置文件；本机操作直接执行", hidden: true }),
    allowLoopback: z.boolean().default(false).meta({ hidden: true }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

export const moduleConfig = defineModuleConfig(
  "yesimbot-google",
  z.looseObject({
    clientId: z.string().optional().meta({ title: "Google Cloud 中 Web 应用的 OAuth Client ID" }),
    clientSecret: z.string().optional().meta({ title: "该 OAuth 应用的 Client Secret；保留在服务器，不会发给模型", secret: true }),
    redirectUri: z.string().optional().meta({ title: "Google 登记的完整回调地址：https://你的域名/yesimbot/api/v1/connectors/google/callback" }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

export type GoogleConfig = Pick<Config, "clientId" | "clientSecret" | "redirectUri">;

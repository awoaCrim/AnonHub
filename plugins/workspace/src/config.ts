import { defineModuleConfig } from "@yesimbot/foundation";
import { z } from "zod/v4";

// Connections are configured here; platform/context capability declarations decide tool eligibility.
const computer = z
  .looseObject({
    deviceId: z.string().default("").meta({ title: "默认电脑", description: "已绑定设备 ID；留空使用内置沙箱。" }),
    desktopModel: z.string().optional().meta({ title: "视觉操作模型", optionsSource: "models.chat" }),
  })
  .optional()
  .meta({ title: "自己的电脑", description: "选择已绑定的设备；命令和桌面操作拥有该设备登录用户的权限。" });

const moduleConfig = defineModuleConfig(
  "yesimbot-workspace",
  z.looseObject({
    storage: z
      .looseObject({
        kind: z.enum(["conversation", "shared", "device"]).default("conversation"),
        deviceId: z.string().optional().meta({ title: "文件保存在设备时，填写自己的设备 ID；只需开启文件能力" }),
        spaceId: z.string().optional().meta({ title: "显式共享空间 ID；必须是 UUID" }),
        path: z.string().optional().meta({ title: "共享空间的存储路径；不会自动导入旧文件", widget: "path" }),
      })
      .prefault({})
      .meta({ title: "文件空间", description: "会话空间相互隔离；共享空间须明确指定，不能自动读取私聊文件。" }),
    computer,
    htmlRendererUrl: z.string().optional().meta({ title: "独立 HTML-to-PNG 渲染服务的 HTTP(S) 地址；配置后可将网页内容渲染为图片，不操作桌面" }),
    bash: z
      .looseObject({
        mounts: z
          .array(
            z.looseObject({
              source: z.string().min(1).meta({ title: "宿主机目录" }),
              target: z.string().min(1).meta({ title: "沙盒内目录" }),
              mode: z
                .union([z.literal("rw").meta({ title: "读写" }), z.literal("ro").meta({ title: "只读" }), z.literal("overlay").meta({ title: "临时写入" })])
                .meta({ title: "访问方式" }),
            }),
          )
          .default([])
          .meta({ title: "Sandbox 挂载声明", widget: "table" }),
        enableNetwork: z.boolean().default(false).meta({ title: "启用网络访问（仅拒绝私有地址，不设 URL 白名单）" }),
        // Python/JavaScript run in just-bash's wasm worker; the workspace loads just-bash's ESM bundle on purpose
        // (its CJS bundle has esbuild turn `import.meta` into {} and the worker path fails with "Invalid URL").
        enablePython: z.boolean().default(false).meta({ title: "启用 Python 执行" }),
        enableJavascript: z.boolean().default(false).meta({ title: "启用 JavaScript 执行" }),
      })
      .prefault({})
      .meta({ title: "Bash 沙箱配置" }),
    skillPaths: z
      .array(z.string().meta({ widget: "path" }))
      .default([])
      .meta({ title: "技能文件或目录" }),
  }),
);

export type Config = z.output<typeof moduleConfig.schema>;

export { moduleConfig };

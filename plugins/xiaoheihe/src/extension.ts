import { defineExtension, protectPluginTools } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { XiaoheiheService } from "./service.js";
import { createXiaoheihePlugin } from "./tools.js";

/**
 * Xiaoheihe as an extension (user, 2026-11-18: 「小黑盒改成拓展，供其他平台调用的，不再作为单个平台」). Reading posts
 * works in every conversation; publishing only for admins and only on request. No polling,
 * no rounds, no autonomous activity; the QR login lives in the console's 服务连接 page.
 */
export const extension = defineExtension({
  moduleConfig,
  async start(ctx) {
    const service = new XiaoheiheService({ baseDir: ctx.baseDir, clock: ctx.clock }, ctx.config);
    ctx.provide("yesimbotXiaoheihe", service);
    const unregisterTools = ctx.core.agent.use({
      id: moduleConfig.id,
      async setup(scope, bot, runtime) {
        const conversation = await ctx.core.identity.conversation({ ...scope, selfId: scope.selfId ?? bot.selfId });
        // The emoji list serves posting; a task that cannot post does not need it.
        const posts = !runtime?.executionRole || runtime.executionRole === "main" || runtime.executionRole === "service";
        return protectPluginTools(
          createXiaoheihePlugin(
            {
              requireAccount: () => service.requireAccount(),
              assets: async () => {
                const resources = await ctx.core.resource.get(scope);
                return (bytes) => resources.assets.put(bytes);
              },
            },
            scope,
            async () => (posts ? ((await service.account?.nativeEmojiPrompt()) ?? "") : ""),
          ),
          conversation,
          moduleConfig.id,
        );
      },
    });
    await service.connect();
    return async () => {
      unregisterTools();
      await service.stop();
    };
  },
});

import { defineExtension } from "koishi-plugin-yesimbot/kernel";

import { moduleConfig } from "./config.js";
import { SEARCH_SERVICE_ID, SearchService } from "./service.js";

/** Web search and page fetching: one agent plugin registered with Core. */
export const extension = defineExtension({
  moduleConfig,
  start(ctx) {
    const service = new SearchService(
      ctx.config,
      {
        resources: (scope) => ctx.core.resource.get(scope),
        conversation: (scope) => ctx.core.identity.conversation(scope),
      },
      ctx.clock,
    );
    service.start();
    const unregister = ctx.core.agent.use({
      id: SEARCH_SERVICE_ID,
      setup: (scope, account, runtime) => service.setup(scope, account, runtime),
    });
    return () => {
      unregister();
      service.stop();
    };
  },
});

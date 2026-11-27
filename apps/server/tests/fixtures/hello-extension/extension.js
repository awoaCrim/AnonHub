// An installed extension as the host loads it (apps/server/tests/installs.test.ts): no import of the host but its zod.
import { z } from "zod/v4";

export const extension = {
  moduleConfig: {
    id: "hello-extension",
    schema: z.object({ greeting: z.string().default("你好").meta({ title: "问候语" }) }),
  },
  start(ctx) {
    ctx.provide("helloExtension", { greeting: ctx.config.greeting });
  },
};

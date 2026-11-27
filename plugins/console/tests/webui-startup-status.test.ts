import { renderToString } from "@vue/server-renderer";
import { expect, it, vi } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";
import { createMemoryHistory } from "vue-router";

import App from "../web/src/App.vue";
import { liveKey, sessionKey } from "../web/src/context";
import { createLiveClient } from "../web/src/lib/live";
import { createSession } from "../web/src/lib/session";
import { createAppRouter } from "../web/src/router";

it("renders neutral startup feedback during the first auth guard without mounting protected subscriptions", async () => {
  let finishBootstrap!: (response: Response) => void;
  const session = createSession(
    () =>
      new Promise<Response>((resolve) => {
        finishBootstrap = resolve;
      }),
  );
  const live = createLiveClient({ createSource: () => ({ readyState: 1, addEventListener() {}, close() {} }) });
  const subscribe = vi.spyOn(live, "use");
  const protectedSetup = vi.fn();
  const router = createAppRouter(session, createMemoryHistory(), [
    {
      path: "/",
      meta: { title: "概览" },
      component: defineComponent({
        setup() {
          protectedSetup();
          return () => h("p", "protected-page");
        },
      }),
    },
  ]);
  const app = createSSRApp(App).provide(sessionKey, session).provide(liveKey, live).use(router);
  const navigation = router.push("/");
  try {
    await vi.waitFor(() => expect(finishBootstrap).toBeTypeOf("function"));
    const pending = await renderToString(app);
    expect(pending).toContain('role="status"');
    expect(pending).toContain("正在连接后台…");
    expect(pending).not.toContain('class="shell"');
    expect(pending).not.toContain("protected-page");
    expect(protectedSetup).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    finishBootstrap(
      new Response(JSON.stringify({ authenticated: true, features: {}, session: { username: "owner", role: "owner", expiresAt: Date.now() + 60_000 } })),
    );
    await navigation;
    const ready = await renderToString(app);
    expect(ready).not.toContain("正在连接后台…");
    expect(ready).toContain('class="shell"');
    expect(ready).toContain("protected-page");
    expect(protectedSetup).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith("panel");
  } finally {
    live.stop();
  }
});

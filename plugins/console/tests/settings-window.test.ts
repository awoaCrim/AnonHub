import { expect, it } from "vitest";
import { createSSRApp, h, nextTick, reactive, ref } from "vue";
import { createMemoryHistory, START_LOCATION, useRoute, type RouteLocationNormalizedLoaded } from "vue-router";
import { renderToString } from "vue/server-renderer";

import { createSession } from "../web/src/lib/session";
import { createAppRouter } from "../web/src/router";
import { createSubpageHost } from "../web/src/shell/settings-subpages";
import { RouteScope, settingsBackground } from "../web/src/shell/settings-window";

// 设置 is a window over the page the user was on (user, 2026-11-22: 「整个设置页面也做成弹窗」).

function appRouter() {
  const session = createSession();
  Object.assign(session.state, { loaded: true, authenticated: true, expiresAt: Date.now() + 60_000 });
  return createAppRouter(session, createMemoryHistory(), [
    { path: "/", component: {} },
    { path: "/conversations", component: {} },
    { path: "/instances", component: {} },
    { path: "/terms", component: {}, meta: { public: true } },
    { path: "/settings/models", component: {}, meta: { settings: true } },
    { path: "/settings/platforms", component: {}, meta: { settings: true } },
  ]);
}

it("opens 设置 over the last page and keeps that page's scroll position through open, moves and close", async () => {
  const router = appRouter();
  const behavior = router.options.scrollBehavior!;
  await router.push("/conversations?c=a");
  let from = router.currentRoute.value;
  await router.push("/settings/models");
  expect(settingsBackground.value).toBe("/conversations?c=a");
  expect(await behavior(router.currentRoute.value, from, null)).toBe(false);

  from = router.currentRoute.value;
  await router.push("/settings/platforms");
  expect(settingsBackground.value).toBe("/conversations?c=a");
  expect(await behavior(router.currentRoute.value, from, null)).toBe(false);

  // Closing returns onto the page under the window.
  from = router.currentRoute.value;
  await router.push(settingsBackground.value);
  expect(await behavior(router.currentRoute.value, from, null)).toBe(false);

  // Leaving the window for another page starts that page at its top.
  await router.push("/settings/models");
  from = router.currentRoute.value;
  await router.push("/instances");
  expect(settingsBackground.value).toBe("/instances");
  expect(await behavior(router.currentRoute.value, from, null)).toEqual({ top: 0 });

  // Signing out forgets the page: the next session's window opens over home.
  await router.push("/terms");
  expect(settingsBackground.value).toBe("/");
});

it("lets the page under the window keep reading its own route while the window's pages read the real one", async () => {
  const location = (fullPath: string, query: Record<string, string> = {}) =>
    reactive({ ...START_LOCATION, path: fullPath.split("?")[0]!, fullPath, query }) as RouteLocationNormalizedLoaded;
  const Reader = {
    props: { label: { type: String, required: true } },
    setup(props: { label: string }) {
      const route = useRoute();
      return () => h("span", `${props.label}=${route.fullPath}|${String(route.query.c ?? "")};`);
    },
  };
  const page = location("/conversations?c=a", { c: "a" });
  const current = location("/settings/models");
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(RouteScope, { route: page }, () => [h(Reader, { label: "page" }), h(RouteScope, { route: current }, () => h(Reader, { label: "window" }))]),
    }),
  );
  expect(html).toContain("page=/conversations?c=a|a;");
  expect(html).toContain("window=/settings/models|;");
});

// Inside the window, what a page opens is a page of the window under a breadcrumb (user, 2026-11-23: 「最忌弹窗套弹窗」).
it("stacks the window's subpages, goes back innermost first and returns each level to where it was", async () => {
  const focused: string[] = [];
  const scroller = { scrollTop: 0, focus: () => focused.push("page") } as unknown as HTMLElement;
  const host = createSubpageHost(ref(scroller), ref());
  const closed: string[] = [];
  scroller.scrollTop = 420;
  const service = host.open(
    () => "newapi",
    () => closed.push("newapi"),
  );
  await nextTick();
  // A subpage starts at its top.
  expect(scroller.scrollTop).toBe(0);
  scroller.scrollTop = 80;
  const model = host.open(
    () => "gpt-5.5",
    () => closed.push("gpt-5.5"),
  );
  expect(host.stack.map((page) => page.title())).toEqual(["newapi", "gpt-5.5"]);

  // The breadcrumb's first part asks every level to close, the innermost first.
  host.back(0);
  expect(closed).toEqual(["gpt-5.5", "newapi"]);
  host.back(1);
  expect(closed).toEqual(["gpt-5.5", "newapi", "gpt-5.5"]);

  // Closing the shown level brings back the level under it as it was.
  host.remove(model);
  await nextTick();
  expect(scroller.scrollTop).toBe(80);
  host.remove(service);
  await nextTick();
  expect(scroller.scrollTop).toBe(420);
  expect(host.stack).toEqual([]);
  expect(focused.length).toBeGreaterThan(0);
});

it("leaves the shown level alone when a level under it goes away", async () => {
  const scroller = { scrollTop: 0, focus() {} } as unknown as HTMLElement;
  const host = createSubpageHost(ref(scroller), ref());
  const outer = host.open(
    () => "outer",
    () => {},
  );
  host.open(
    () => "inner",
    () => {},
  );
  await nextTick();
  scroller.scrollTop = 300;
  host.remove(outer);
  await nextTick();
  expect(scroller.scrollTop).toBe(300);
  expect(host.stack.map((page) => page.title())).toEqual(["inner"]);
});

it("returns to the category page as it was when a subpage closes with the one it opened, and to nothing after a category change", async () => {
  const scroller = { scrollTop: 0, focus() {} } as unknown as HTMLElement;
  const host = createSubpageHost(ref(scroller), ref());
  scroller.scrollTop = 500;
  const service = host.open(
    () => "service",
    () => {},
  );
  scroller.scrollTop = 120;
  const model = host.open(
    () => "model",
    () => {},
  );
  // Closing the service first unmounts the model opened inside it.
  host.remove(service);
  host.remove(model);
  await nextTick();
  expect(scroller.scrollTop).toBe(500);

  host.open(
    () => "service",
    () => {},
  );
  const again = host.stack[0]!.id;
  scroller.scrollTop = 0;
  host.reset();
  host.remove(again);
  await nextTick();
  expect(scroller.scrollTop).toBe(0);
});

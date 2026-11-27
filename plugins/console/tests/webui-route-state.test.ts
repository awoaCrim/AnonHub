import { expect, it, vi } from "vitest";
import { createRenderer, defineComponent, h, nextTick, type WritableComputedRef } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import { numberCodec, useRouteState } from "../web/src/lib/route-state";

type HostNode = { text: string; children: HostNode[]; parent?: HostNode };
const node = (text = ""): HostNode => ({ text, children: [] });

it("mounted route state keeps rendering consecutive query edits and merges same-tick fields", async () => {
  // A real renderer runs the component's render effect without requiring a DOM
  // dependency. The composable uses Vue Router's actual injected reactive route.
  const { createApp } = createRenderer<HostNode, HostNode>({
    createElement: () => node(),
    createText: (text) => node(text),
    createComment: (text) => node(text),
    setText: (target, text) => {
      target.text = text;
    },
    setElementText: (target, text) => {
      target.text = text;
    },
    parentNode: (target) => target.parent ?? null,
    nextSibling: () => null,
    patchProp: () => {},
    insert(target, parent) {
      target.parent = parent;
      parent.children.push(target);
    },
    remove(target) {
      const children = target.parent?.children;
      if (children) children.splice(children.indexOf(target), 1);
    },
  });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: {} }] });
  await router.push("/?page=3");
  let type!: WritableComputedRef<string>;
  let page!: WritableComputedRef<number>;
  let search!: WritableComputedRef<string>;
  const app = createApp(
    defineComponent({
      setup() {
        type = useRouteState("type", "all");
        page = useRouteState("page", 1, numberCodec);
        search = useRouteState("q", "");
        return () => h("output", `${type.value}/${page.value}/${search.value}`);
      },
    }),
  );
  app.use(router);
  const root = node();
  app.mount(root);
  try {
    expect(root.children[0].text).toBe("all/3/");
    for (const filter of ["guild", "channel", "direct", "all", "guild"]) {
      type.value = filter;
      page.value = 1;
      search.value = `search-${filter}`;
      await vi.waitFor(() => {
        expect(router.currentRoute.value.query.type ?? "all").toBe(filter);
        expect(router.currentRoute.value.query.q).toBe(`search-${filter}`);
      });
      await nextTick();
      expect(router.currentRoute.value.query.page).toBeUndefined();
      expect(root.children[0].text).toBe(`${filter}/1/search-${filter}`);
    }
    await router.replace("/?type=direct&page=2&q=browser-navigation");
    await nextTick();
    expect(root.children[0].text).toBe("direct/2/browser-navigation");
  } finally {
    app.unmount();
  }
});

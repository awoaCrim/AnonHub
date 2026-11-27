import { renderToString } from "@vue/server-renderer";
import { describe, expect, it, vi } from "vitest";
import { computed, createSSRApp, defineComponent, h, reactive } from "vue";

import type { ModelSettingsSnapshot } from "../src/model-settings-types";

const fixture = vi.hoisted(() => ({ view: undefined as unknown }));
vi.mock("../web/src/state/model-settings-state", async (actual) => ({
  ...(await actual<typeof import("../web/src/state/model-settings-state")>()),
  createModelSettingsState: () => fixture.view,
}));
vi.mock("../web/src/context", () => ({
  useLive: () => ({ use: () => ({ state: { data: undefined }, release() {} }) }),
  useSession: () => ({ state: { role: "owner", username: "test", features: {} } }),
}));
vi.mock("../web/src/lib/cache", () => ({ onCacheRefresh: () => () => {} }));
vi.mock("./legacy-draft-fixture", () => ({ createDraft: () => ({}) }));
vi.mock("../web/src/lib/route-state", async () => {
  const { ref } = await import("vue");
  return { useRouteState: (_key: string, fallback: string) => ref(fallback) };
});

import Models from "../web/src/pages/BotModels.vue";

describe("model purpose availability", () => {
  it("shows the three models first and every other use beside them, without a dialog", async () => {
    const draft: ModelSettingsSnapshot = {
      revision: "fresh",
      writable: true,
      connections: [],
      roles: { chatModel: "", auxiliaryModel: "", visionModel: "", embeddingModel: "" },
    };
    const state = reactive({ draft, selectedKey: "roles", loading: false, saving: false, query: "", error: "" });
    fixture.view = {
      state,
      selected: computed(() => undefined),
      connections: computed(() => []),
      modelChoices: () => [],
    };
    const app = createSSRApp(Models);
    app.component(
      "RouterLink",
      defineComponent({
        setup:
          (_props, { slots }) =>
          () =>
            h("a", slots.default?.()),
      }),
    );
    const html = await renderToString(app);
    const pickers = [...html.matchAll(/<button([^>]*data-slot="select-trigger"[^>]*)>/g)].map((match) => match[1]);
    // 对话, 辅助, 生图; then 看图, 改图, 检索记忆 (user, 2026-11-21: three models, the rest follow).
    expect(pickers).toHaveLength(6);
    expect(pickers.every((attributes) => !/(?:^|\s)disabled(?:=|\s|$)/.test(attributes))).toBe(true);
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).not.toMatch(/<button[^>]*aria-label="新建连接"[^>]*disabled/);
    expect(html).toContain("其余用途");
    expect(html).not.toContain("其他模型用途");
    expect(html).not.toContain('data-slot="collapsible"');
    expect(state.draft.roles).toHaveProperty("embeddingModel", "");
    // Each choice saves at once (user, 2026-11-26): no save bar.
    expect(html).not.toMatch(/>\s*保存\s*</);
    expect(html).not.toContain("有未保存的修改");
  });
});

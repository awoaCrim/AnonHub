import { renderToString } from "@vue/server-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";

import type { PanelPayload } from "../src/shared/panel";
import type { PluginsSnapshot } from "../src/shared/plugin-config";
import BotStatus from "../web/src/components/BotStatus.vue";
import Overview from "../web/src/pages/Home.vue";

const fixture = vi.hoisted(() => ({
  features: { napcat: false, usage: false, tenant: true, accounts: false },
  catalog: undefined as PluginsSnapshot | undefined,
  panel: undefined as PanelPayload | undefined,
  chat: {
    conversation: { platform: "web", channel: "web:bot:owner", session: "s1.jsonl" },
    messages: [{ id: "m1", role: "bot", text: "你好，我在。", at: 1_762_470_000_000, status: "sent" }],
    typing: false,
  },
  topics: [] as string[],
  api: vi.fn(async (url: string) =>
    url.includes("/schema?") ? { schema: { type: "object", dict: {} }, dynamics: {}, usage: "" } : { revision: "r1", config: {} },
  ),
}));
vi.mock("../web/src/context", () => ({
  useSession: () => ({ state: { role: "member", username: "member", features: fixture.features } }),
  useLive: () => ({ use: () => ({ state: { data: fixture.catalog }, release: () => {} }) }),
}));
vi.mock("../web/src/lib/use-topic", () => ({
  useTopic: (name: string, enabled = () => true) => {
    if (enabled()) fixture.topics.push(name);
    if (name === "chat") return { data: fixture.chat, unavailable: false };
    return { data: name === "panel" ? fixture.panel : undefined, unavailable: true };
  },
}));
vi.mock("../web/src/lib/api", () => ({ api: fixture.api, ApiError: class extends Error {} }));
vi.mock("../web/src/lib/cache", () => ({ onCacheRefresh: () => () => {} }));
vi.mock("./legacy-draft-fixture", () => ({ createDraft: () => ({ load: () => undefined, clearOwned: () => {} }) }));
vi.mock("../web/src/lib/route-state", async () => {
  const { ref } = await import("vue");
  return { useRouteState: (key: string) => ref(key === "plugin" ? "yesimbot-model-provider:main" : "") };
});
vi.mock("../web/src/shell/TopicFeedback.vue", () => ({ default: { render: () => null } }));
vi.mock("vue-router", () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: () => {}, push: () => {} }) }));
afterEach(() => {
  fixture.api.mockClear();
  fixture.topics.length = 0;
});

function render(component: typeof Overview | typeof BotStatus, props?: Record<string, unknown>) {
  const app = createSSRApp(component, props);
  app.component(
    "RouterLink",
    defineComponent({
      props: ["to"],
      setup:
        (props, { slots }) =>
        () =>
          h("a", { href: props.to }, slots.default?.()),
    }),
  );
  return renderToString(app);
}

it("renders only reachable overview links and subscribes to usage when its grant becomes available", async () => {
  fixture.panel = {
    generatedAt: new Date().toISOString(),
    adapters: [],
    plugins: [],
    attention: [],
    recent: [],
    health: { online: true, botCount: 0, botErrorCount: 0, uptimeSeconds: 0, memory: { app: 0, total: 0 } },
    model: { chatModel: null, providers: [], chatModels: 0 },
    config: { allowedChannels: 0 },
    onboarding: {
      complete: false,
      steps: [
        { id: "adapter", done: false },
        { id: "model", done: false },
        { id: "channels", done: false },
      ],
    },
  } as PanelPayload;
  fixture.features.usage = false;
  // 对话 is the conversations and the chat: no status rail or usage.
  const html = await render(Overview);
  // Web chat subscribes only to its own conversation and role library.
  expect(fixture.topics).toEqual(["chat", "plugins", "chat"]);
  expect(html).toContain("你好，我在。");
  expect(html).toMatch(/<textarea[^>]*id="web-chat-input"/);
  expect(html).not.toMatch(/<textarea[^>]*\sdisabled(?:=|\s|>)/);
  expect(html).not.toContain('href="/?c=web%3Abot%3Aowner"');
  // Conversation management is separate; the chat has no conversation switcher.
  expect(html).not.toContain('aria-label="切换会话"');
  expect(html).not.toContain("全局大脑");
  expect(html).not.toContain("网页对话还在开发中");
  expect(html).not.toContain("进程内存");
  expect(html).not.toContain('href="/settings/models"');
  // Only what blocks talking to it: the unfinished setup.
  expect(html).not.toContain('href="/setup"');
  expect(html).not.toContain("还差几步就能用了");

  // The status moved to 设置 → 系统. Members do not see host memory or delivery failures there.
  const status = await render(BotStatus, { panel: fixture.panel });
  expect(status).toContain('href="/settings/platforms"');
  expect(status).toContain('href="/settings/models"');
  expect(status).not.toContain("进程内存");
  expect(status).not.toContain("发送失败");
});

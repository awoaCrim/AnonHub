import { expect, it } from "vitest";
import { createMemoryHistory } from "vue-router";

import type { PanelPayload } from "../src/shared/panel";
import type { WebUIFeatures } from "../src/shared/webui";
import { createSession } from "../web/src/lib/session";
import { sessionTopics, visibleGroups, visibleSettings } from "../web/src/nav";
import { onboardingSteps, statusRows } from "../web/src/pages/overview-model";
import { createAppRouter, createRoutes } from "../web/src/router";

const features: WebUIFeatures = { napcat: false, accounts: false, tenant: true, usage: false };
const routes = () => createRoutes().map((route) => ({ ...route, component: { render: () => null } }) as never);
function session(role: "member" | "owner" = "member", available = features) {
  const result = createSession();
  Object.assign(result.state, { loaded: true, authenticated: true, expiresAt: Date.now() + 60_000, role, features: available, memberRuntime: "running" });
  return result;
}

it("keeps member links, direct routes, detail pages and subscriptions consistent with grants", async () => {
  const current = session();
  const router = createAppRouter(current, createMemoryHistory(), routes());
  // Use apart from configuration: the sidebar holds what is used day to day, 设置 holds the rest.
  expect(visibleGroups(features, "member").map((group) => [group.label, group.items.map((item) => `${item.path} ${item.label}`)])).toEqual([
    ["", ["/ 对话", "/conversations 会话管理", "/settings 设置"]],
  ]);
  expect(visibleSettings(features, "member").map((item) => `${item.path} ${item.label}`)).toEqual([
    "/settings/platforms 平台",
    "/settings/reply 对话",
    "/settings/extensions 能力",
    "/settings/models 模型",
    "/settings/system 系统",
  ]);
  expect(sessionTopics(features)).toEqual(["panel", "plugins"]);
  for (const path of ["/settings/friends", "/friends", "/admin/accounts"]) {
    await router.push(path);
    expect(router.currentRoute.value.path, path).toBe("/");
  }
  // Chat history is part of 对话 now: old history links open the chat there.
  await router.push("/history/123/history.jsonl");
  expect(router.currentRoute.value.fullPath).toBe("/conversations?c=123");
  for (const path of ["/settings/system", "/settings/platforms", "/settings/reply", "/settings/extensions", "/settings/models"]) {
    await router.push(path);
    expect(router.currentRoute.value.path).toBe(path);
    // 设置 stays highlighted in the sidebar for every category.
    if (path.startsWith("/settings")) expect(router.currentRoute.value.meta.nav).toBe("settings");
  }
  current.state.features = { ...features, usage: true, napcat: true };
  expect(sessionTopics(current.state.features)).not.toContain("usage");
  await router.push("/settings/platforms");
  expect(router.currentRoute.value.fullPath).toBe("/settings/platforms");
  // The old Xiaoheihe activity pages are gone; their links open 会话管理, where its old records are only read.
  for (const path of ["/history?platform=xiaoheihe", "/xiaoheihe"]) {
    await router.push(path);
    expect(router.currentRoute.value.fullPath, path).toBe("/conversations");
  }
});

it("gives owners friends, and keeps every previous path working", async () => {
  const all: WebUIFeatures = { napcat: true, accounts: true, tenant: false, usage: true };
  // Daily navigation remains short; administrators retain their account-management entry.
  expect(visibleGroups(all, "owner").flatMap((group) => group.items.map((item) => item.path))).toEqual(["/", "/conversations", "/settings", "/instances"]);
  expect(visibleGroups({ ...all, accounts: false }, "owner").flatMap((group) => group.items.map((item) => item.path))).not.toContain("/instances");
  expect(visibleSettings(all, "owner").map((item) => item.label)).toEqual(["平台", "对话", "能力", "模型", "系统"]);
  const owner = createAppRouter(session("owner", all), createMemoryHistory(), routes());
  const moved: [string, string][] = [
    ["/settings", "/settings/platforms"],
    ["/platforms?platform=xiaoheihe", "/settings/platforms?platform=xiaoheihe"],
    ["/connect?platform=xiaoheihe", "/settings/platforms?platform=xiaoheihe"],
    ["/qq", "/settings/platforms"],
    ["/channels", "/settings/platforms"],
    ["/bot/scope", "/settings/platforms"],
    ["/role", "/?panel=files&document=role"],
    ["/bot", "/?panel=files&document=role"],
    ["/bot/role", "/?panel=files&document=role"],
    ["/bot/behavior", "/settings/reply"],
    ["/settings/reply", "/settings/reply"],
    ["/settings/role?tab=memory", "/?panel=files&document=memory"],
    ["/settings/role?tab=prompt", "/settings/system?section=prompt"],
    // What moved out of 回复偏好 (user, 2026-11-17): the prompt to 系统, tools to 能力.
    ["/settings/reply?section=prompt", "/settings/system?section=prompt"],
    ["/settings/reply?section=yesimbot-sticker-manager", "/settings/extensions?section=yesimbot-sticker-manager"],
    ["/settings/reply?section=yesimbot-message-debounce", "/settings/reply?section=yesimbot-message-debounce"],
    ["/settings/role?edit=card-1", "/?edit=card-1&panel=files&document=role"],
    // 电脑 and 服务连接 are cards in 能力 now (user, 2026-11-21); the Google sign-in result still arrives.
    ["/computer", "/settings/extensions?section=yesimbot-workspace"],
    ["/devices", "/settings/extensions?section=yesimbot-workspace"],
    ["/settings/computer", "/settings/extensions?section=yesimbot-workspace"],
    ["/settings/connections?google=ok", "/settings/extensions?google=ok&section=yesimbot-google"],
    ["/models?connection=a&tab=chat", "/settings/models?connection=a&tab=chat"],
    ["/bot/models?connection=a", "/settings/models?connection=a"],
    // There is no plugin page: a plugin link opens where that feature is set, a tool under 平台.
    ["/plugins?plugin=yesimbot-usage&view=settings", "/settings/system?tab=usage"],
    ["/settings/plugins?plugin=yesimbot-memorizer", "/settings/extensions?section=yesimbot-memorizer"],
    ["/settings/plugins?plugin=~yesimbot-workspace:a", "/settings/extensions?section=yesimbot-workspace"],
    ["/settings/plugins?plugin=group%2F~yesimbot-workspace:a", "/settings/extensions?section=yesimbot-workspace"],
    ["/advanced/plugins?plugin=x%3Ay&q=role", "/settings/extensions?q=role"],
    ["/plugins?plugin=yesimbot-memorizer&view=access&platform=onebot", "/settings/extensions?platform=onebot&section=yesimbot-memorizer"],
    ["/tools?toolPlugin=yesimbot-usage", "/settings/system?tab=usage"],
    ["/tools?toolPlugin=yesimbot-usage&view=settings", "/settings/system?tab=usage"],
    ["/settings/features?tool=computer", "/settings/extensions?section=yesimbot-workspace"],
    ["/settings/features?tool=yesimbot-google", "/settings/extensions?section=yesimbot-google"],
    ["/settings/features?tool=yesimbot-image-tools", "/settings/extensions?section=yesimbot-image-tools"],
    ["/settings/features?tool=yesimbot-search-service", "/settings/extensions?section=yesimbot-search-service"],
    ["/settings/features?tool=reply-triggers", "/settings/reply?section=reply-triggers"],
    ["/system", "/settings/system"],
    ["/screen", "/?panel=computer"],
    ["/settings/friends?account=a", "/instances?account=a"],
    ["/friends?account=owner", "/instances?account=owner"],
    ["/admin/accounts?account=a", "/instances?account=a"],
    ["/accounts", "/instances"],
    ["/admin/system?level=error", "/settings/system?level=error"],
    ["/settings/system?level=error", "/settings/system?level=error"],
    ["/usage", "/settings/system?tab=usage"],
    ["/history?q=1&expanded=%5B%5D", "/conversations"],
    ["/conversations?q=1&expanded=%5B%5D", "/conversations?q=1&expanded=%5B%5D"],
    ["/history/onebot%3A1/20261029T023056Z.jsonl?returnTo=%2Fhistory", "/conversations?c=onebot:1"],
    ["/conversations/onebot%3A1/20261029T023056Z.jsonl?returnTo=%2Fconversations", "/conversations?c=onebot:1"],
    ["/history?platform=xiaoheihe&page=2", "/conversations"],
    ["/xiaoheihe?view=activity&page=2", "/conversations"],
  ];
  for (const [from, to] of moved) {
    await owner.push(from);
    expect(owner.currentRoute.value.fullPath, from).toBe(to);
  }
  await owner.push("/instances");
  expect(owner.currentRoute.value.path).toBe("/instances");
  // Owners may open the wizard for their own bot; the old member portal path leads there too.
  await owner.push("/account");
  expect(owner.currentRoute.value.path).toBe("/setup");
});

it("keeps unavailable members on the setup portal, including old links", async () => {
  const current = session("member", { ...features, accounts: true });
  current.state.memberRuntime = "unavailable";
  const member = createAppRouter(current, createMemoryHistory(), routes());
  for (const path of ["/settings/models", "/bot/models", "/models", "/account", "/"]) {
    await member.push(path);
    expect(member.currentRoute.value.path, path).toBe("/setup");
  }
});

it("links the platforms status even without QR login, and omits the unreachable QQ setup step", () => {
  const panel = {
    adapters: [],
    plugins: [],
    model: { chatModel: null, providers: [], chatModels: 0 },
    config: { allowedChannels: 0 },
    onboarding: {
      complete: false,
      steps: [
        { id: "adapter", target: "/plugins/legacy-adapter" },
        { id: "model", target: "/plugins/mna2kh" },
        { id: "channels", target: "/plugins/mna2kh" },
      ],
    },
  } as PanelPayload;
  expect(statusRows(panel, features).map((row) => row.to)).toEqual(["/settings/platforms", "/settings/models"]);
  // The computer line appears only once the device list is known.
  expect(statusRows(panel, features, []).map((row) => [row.to, row.value, row.tone])).toEqual([
    ["/settings/platforms", "还没有接入", "warn"],
    ["/settings/models", "还没有选择", "warn"],
    ["/settings/extensions?section=yesimbot-workspace", "还没有接入", ""],
  ]);
  expect(onboardingSteps(panel, features).map((step) => step.to)).toEqual(["/setup?step=model", "/settings/platforms?section=scope"]);
});

it("keeps web chat independent of previous management selections", async () => {
  const { setCacheOwner, clearCaches } = await import("../web/src/lib/cache");
  const { vi } = await import("vitest");
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
  try {
    setCacheOwner("conversation-test");
    const router = createAppRouter(session(), createMemoryHistory(), routes());
    await router.push("/?c=anon");
    await router.push("/settings/computer");
    await router.push("/");
    expect(router.currentRoute.value.path).toBe("/");
    expect(router.currentRoute.value.query.c).toBeUndefined();
    await router.push("/?c=other");
    await router.push("/settings/role");
    await router.push("/");
    expect(router.currentRoute.value.query.c).toBeUndefined();
    await router.push("/");
    expect(router.currentRoute.value.query.c).toBeUndefined();
    await router.push("/settings/role");
    await router.push("/");
    expect(router.currentRoute.value.query.c).toBeUndefined();
  } finally {
    clearCaches();
    vi.unstubAllGlobals();
  }
});

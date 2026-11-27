import { createRouter, createWebHistory, type RouteLocation, type RouteRecordRaw, type RouterHistory } from "vue-router";

import type { WebUIFeatures } from "../../src/shared/webui";
import { editorRegistry } from "./lib/editor-guard";
import { featureLink } from "./lib/features";
import type { Session } from "./lib/session";
import { safeReturnPath } from "./lib/session";
import { pages, settingsPages, type NavItem } from "./nav";
import BotModels from "./pages/BotModels.vue";
import Conversations from "./pages/Conversations.vue";
import Features from "./pages/Features.vue";
import Friends from "./pages/Friends.vue";
import Home from "./pages/Home.vue";
import Login from "./pages/Login.vue";
import NotFound from "./pages/NotFound.vue";
import Platforms from "./pages/Platforms.vue";
import ReplyPreferences from "./pages/ReplyPreferences.vue";
import Settings from "./pages/Settings.vue";
import Setup from "./pages/Setup.vue";
import SystemSettings from "./pages/SystemSettings.vue";
import { keepsPageScroll, rememberBackground } from "./shell/settings-window";

declare module "vue-router" {
  interface RouteMeta {
    title?: string;
    /** The page renders its own heading (detail views with breadcrumbs). */
    header?: boolean;
    public?: boolean;
    shell?: boolean;
    nav?: string;
    ownerOnly?: boolean;
    feature?: keyof WebUIFeatures;
    /** `form`: a 960px reading column for settings pages; every tab of a page shares its parent's width. */
    width?: "form";
    /** Rendered inside 设置, which draws the category list and the page heading itself. */
    settings?: boolean;
  }
}

const meta = (item: NavItem) => ({ title: item.label, nav: item.name, ownerOnly: item.ownerOnly, feature: item.feature });
/** A 设置 category keeps 设置 highlighted in the sidebar. */
const setting = (item: NavItem, width?: "form") => ({ ...meta(item), nav: pages.settings.name, settings: true, ...(width ? { width } : {}) });
const moved =
  (path: string | ((to: RouteLocation) => string), query: Record<string, string> = {}) =>
  (to: RouteLocation) => ({ path: typeof path === "string" ? path : path(to), query: { ...to.query, ...query }, hash: to.hash });
/**
 * Chat history opens in 会话管理: a chat's record is `?c=<channel>`. The
 * old page's own list state (search, page, expanded rows) has no meaning there and is dropped.
 */
const toTalk = (to: RouteLocation) => {
  const channel = typeof to.params.channel === "string" ? to.params.channel : "";
  return { path: "/conversations", query: channel ? { c: channel } : {}, hash: to.hash };
};
/** Every legacy capability link resolves to its sole editor. Access is automatic. */
function toPlugins(to: RouteLocation) {
  const { toolPlugin, view: _view, plugin: _plugin, tool: _tool, ...query } = to.query;
  const plugin = String(to.query.plugin ?? toolPlugin ?? to.query.tool ?? "");
  const key = plugin
    .split("/")
    .at(-1)!
    .replace(/^~/, "")
    .split(":")[0]!
    .replace(/^koishi-plugin-/, "");
  const name = plugin === "computer" ? "yesimbot-workspace" : key;
  const target = featureLink(name) ?? { path: settingsPages.extensions.path };
  return { path: target.path, query: { ...query, ...target.query }, hash: to.hash };
}

/** Links into 回复偏好 for what moved out of it (user, 2026-11-17): the prompt to 系统, tools to 能力. */
function fromReply(to: RouteLocation) {
  const section = typeof to.query.section === "string" ? to.query.section : "";
  if (section === "prompt") return { path: settingsPages.system.path, query: to.query, hash: to.hash };
  const target = section ? featureLink(section) : undefined;
  if (target && target.path !== settingsPages.reply.path) return { path: target.path, query: { ...to.query, ...target.query }, hash: to.hash };
  return true;
}

/** Card documents replaced the old four-tab role page. */
function toRole(to: RouteLocation) {
  const { tab, ...query } = to.query;
  if (tab === "prompt") return { path: settingsPages.system.path, query: { ...query, section: "prompt" }, hash: to.hash };
  if (tab === "speaking") return { path: settingsPages.reply.path, query, hash: to.hash };
  return { path: pages.home.path, query: { ...query, panel: "files", document: tab === "memory" ? "memory" : "role" }, hash: to.hash };
}

// Keep the small standalone app in the initial bundle: public links can have
// multi-second latency, so a first visit must not wait for a route chunk.
export function createRoutes(): RouteRecordRaw[] {
  return [
    { path: "/conversations", name: "conversations", component: Conversations, meta: meta(pages.conversations) },
    { path: "/login", name: "login", component: Login, meta: { title: "登录", public: true, shell: false } },
    { path: "/setup", name: "setup", component: Setup, meta: { title: "设置你的机器人", shell: false } },
    { path: "/", name: "home", component: Home, meta: { ...meta(pages.home), header: false } },
    { path: pages.friends.path, name: pages.friends.name, component: Friends, meta: meta(pages.friends) },
    {
      path: pages.settings.path,
      component: Settings,
      meta: { title: pages.settings.label, nav: pages.settings.name, header: false, settings: true },
      children: [
        { path: "", name: "settings", redirect: { name: settingsPages.platforms.name } },
        { path: "extensions", name: settingsPages.extensions.name, component: Features, meta: setting(settingsPages.extensions, "form") },
        { path: "reply", name: settingsPages.reply.name, component: ReplyPreferences, meta: setting(settingsPages.reply, "form"), beforeEnter: fromReply },
        { path: "platforms", name: settingsPages.platforms.name, component: Platforms, meta: setting(settingsPages.platforms, "form") },
        { path: "role", redirect: toRole },
        { path: "features", redirect: toPlugins },
        { path: "system", name: settingsPages.system.name, component: SystemSettings, meta: setting(settingsPages.system, "form") },
        // 电脑 and 服务连接 became cards in 能力 (user, 2026-11-21); the Google sign-in still returns here.
        { path: "computer", redirect: moved(settingsPages.extensions.path, { section: "yesimbot-workspace" }) },
        { path: "connections", redirect: moved(settingsPages.extensions.path, { section: "yesimbot-google" }) },
        { path: "models", name: settingsPages.models.name, component: BotModels, meta: setting(settingsPages.models, "form") },
      ],
    },

    // Paths from earlier navigations stay valid: bookmarks, returnTo values and shared links.
    { path: "/account", redirect: moved("/setup") },
    ...["/platforms", "/connect", "/qq", "/channels", "/bot/scope"].map((path) => ({ path, redirect: moved(settingsPages.platforms.path) })),
    ...["/role", "/bot", "/bot/role"].map((path) => ({ path, redirect: toRole })),
    { path: "/bot/behavior", redirect: moved(settingsPages.reply.path) },
    ...["/computer", "/devices"].map((path) => ({ path, redirect: moved(settingsPages.extensions.path, { section: "yesimbot-workspace" }) })),
    ...["/plugins", "/tools", "/advanced/plugins", "/settings/plugins"].map((path) => ({ path, redirect: toPlugins })),
    { path: "/screen", redirect: moved("/", { panel: "computer" }) },
    ...["/bot/models", "/models"].map((path) => ({ path, redirect: moved(settingsPages.models.path) })),
    ...["/friends", "/settings/friends", "/admin/accounts", "/accounts"].map((path) => ({ path, redirect: moved(pages.friends.path) })),
    ...["/system", "/admin/system"].map((path) => ({ path, redirect: moved(settingsPages.system.path) })),
    { path: "/usage", redirect: moved(pages.system.path, { tab: "usage" }) },
    ...["/history", "/xiaoheihe"].map((path) => ({ path, redirect: toTalk })),
    ...["/history/:channel/:session", "/history/xiaoheihe/:channel/:session", "/conversations/:channel/:session", "/xiaoheihe/:channel/:session"].map(
      (path) => ({ path, redirect: toTalk }),
    ),

    { path: "/:pathMatch(.*)*", name: "not-found", component: NotFound, meta: { title: "页面不存在" } },
  ];
}

export function createAppRouter(session: Session, history: RouterHistory = createWebHistory(), routes: RouteRecordRaw[] = createRoutes()) {
  const router = createRouter({
    history,
    routes,
    // The 设置 window opens over the page and closes back onto it: that page keeps its scroll position.
    scrollBehavior: (to, from, saved) => saved ?? (to.path === from.path || keepsPageScroll(to, from) ? false : { top: 0 }),
  });
  router.beforeEach(async (to, from) => {
    const authenticated = await session.ensure();
    if (to.meta.public) return authenticated && to.name === "login" ? safeReturnPath(to.query.returnTo) : true;
    if (!authenticated)
      return {
        name: "login",
        query: to.fullPath === "/" ? {} : { returnTo: to.fullPath },
      };
    if (to.name === settingsPages.platforms.name && to.query.tool) return toPlugins(to);
    const member = session.state.role === "member";
    // A member without a running bot only has the setup portal.
    if (member && session.state.memberRuntime === "unavailable") return to.name === "setup" ? true : { name: "setup" };
    if (to.matched.some((record) => record.meta.ownerOnly) && member) return { name: "home" };
    if (to.meta.feature && !session.state.features[to.meta.feature]) return { name: "home" };
    if (to.name === "home" && typeof to.query.c === "string") return { path: "/conversations", query: { c: to.query.c } };
    return true;
  });
  router.beforeEach((to, from) => {
    if (!session.state.authenticated) return true;
    const sameEditor =
      to.path === from.path &&
      // Model services, model rows and purposes all edit the same retained draft.
      // Their query navigation does not leave that editor, including adding a new service.
      (to.name === settingsPages.models.name ||
        ["plugin", "platform", "account", "view", "tool", "tab", "document", "edit"].every(
          (key) => JSON.stringify(to.query[key]) === JSON.stringify(from.query[key]),
        ));
    return sameEditor || editorRegistry.leave();
  });
  router.afterEach((to, _from, failure) => {
    if (failure) return;
    rememberBackground(to);
    if (typeof document === "undefined") return;
    document.title = to.meta.title ? `${to.meta.title} · AnonHub` : "AnonHub";
  });
  return router;
}

<template>
  <div class="shell" :class="{ open: drawer, 'chat-shell': fullPage }">
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <Sheet :open="mobile && drawer" @update:open="drawer = $event">
      <component
        :is="mobile ? SheetContent : 'aside'"
        v-bind="mobile ? { side: 'left', hideClose: true, 'aria-describedby': undefined } : {}"
        @close-auto-focus="menuButton?.focus()"
        id="app-navigation"
        ref="sidebar"
        class="sidebar"
        :class="mobile ? 'w-[min(280px,86vw)] h-dvh gap-0 overflow-y-auto bg-[var(--sidebar)] px-3 pt-4 pb-3' : undefined"
        aria-label="导航"
      >
        <SheetTitle v-if="mobile" class="sr-only">导航</SheetTitle>
        <div class="brand">
          <!-- The product, not the role: the bot's own name and face belong to the chat. -->
          <RouterLink class="bot" to="/" :title="`AnonHub · ${statusLabel}`" @click="drawer = false">
            <span class="logo" aria-hidden="true"><BrandMark /><span v-if="liveClass !== 'ok'" class="logo-dot" :class="liveClass"></span></span>
            <span class="bot-text"
              ><strong class="product">AnonHub</strong
              ><small class="live" :class="liveClass"><span v-if="liveClass !== 'ok'" class="dot" />{{ statusLabel }}</small></span
            >
          </RouterLink>
          <Button variant="ghost" size="icon-sm" class="close" aria-label="关闭导航" @click="drawer = false"><Icon name="close" /></Button>
        </div>
        <nav>
          <section v-for="(group, index) in groups" :key="index">
            <h2 v-if="group.label">{{ group.label }}</h2>
            <Button v-for="item in group.items" :key="item.name" as-child :variant="route.meta.nav === item.name ? 'secondary' : 'ghost'" class="justify-start"
              ><RouterLink
                :to="item.path"
                class="nav-item"
                :class="{ active: route.meta.nav === item.name }"
                :title="marks[item.name] ? `${item.label} · ${marks[item.name]!.label}` : item.label"
                @click="drawer = false"
              >
                <Icon :name="item.icon" />
                <span class="nav-label">{{ item.label }}</span>
                <span v-if="marks[item.name]" class="mark" :class="marks[item.name]!.tone" :title="marks[item.name]!.label"
                  ><span class="sr-only">{{ marks[item.name]!.label }}</span></span
                >
              </RouterLink></Button
            >
          </section>
        </nav>
        <footer>
          <span class="avatar" :title="`${session.state.username || '管理员'} · ${session.state.role === 'member' ? '成员' : '所有者'}`" aria-hidden="true">{{
            (session.state.username || "管").slice(0, 1).toUpperCase()
          }}</span>
          <div class="who">
            <strong class="truncate">{{ session.state.username || "管理员" }}</strong>
            <span>{{ session.state.role === "member" ? "成员" : "所有者" }}</span>
          </div>
          <Button v-if="installPlace" variant="ghost" size="icon-sm" aria-label="安装 App" title="安装 App" @click="openInstall"><Icon name="app" /></Button>
          <Button variant="ghost" size="icon-sm" :aria-label="themeLabel" :title="themeLabel" @click="cycleTheme">
            <Icon :name="theme === 'dark' ? 'moon' : 'sun'" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="退出登录" title="退出登录" @click="signOut"><Icon name="logout" /></Button>
        </footer> </component
    ></Sheet>
    <div class="main">
      <header class="topbar">
        <Button variant="ghost" class="h-auto min-h-9 whitespace-normal" as-child
          ><button
            ref="menuButton"
            class="menu"
            :class="buttonVariants({ variant: 'ghost', size: 'icon' })"
            aria-label="打开导航"
            aria-controls="app-navigation"
            :aria-expanded="drawer"
            @click="drawer = true"
          >
            <Icon name="menu" /></button
        ></Button>
        <span class="topbar-title" :class="{ quiet: headingInView }" :aria-hidden="headingInView || undefined">{{ topbarTitle }}</span>
        <span class="live" :class="liveClass"><span v-if="liveClass !== 'ok'" class="dot" />{{ statusLabel }}</span>
        <!-- A page's own control for the phone bar (the chat's side panel toggle). -->
        <div id="topbar-actions" class="topbar-actions"></div>
      </header>
      <main id="main-content" class="content" :class="{ form: route.meta.width === 'form' && !widePage, full: fullPage }" tabindex="-1">
        <header v-if="route.meta.header !== false" class="page-head">
          <div class="page-heading">
            <Breadcrumb v-if="pageCrumb">
              <BreadcrumbList class="crumbs">
                <BreadcrumbItem class="shrink-0">
                  <BreadcrumbLink as-child
                    ><Button variant="ghost" class="h-auto min-h-9 whitespace-normal" as-child
                      ><button type="button" class="crumb-root" @click="pageCrumb.back()">{{ route.meta.title }}</button></Button
                    ></BreadcrumbLink
                  >
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem class="min-w-0 flex-1">
                  <BreadcrumbPage class="min-w-0"
                    ><h1 ref="heading" class="truncate">{{ pageCrumb.label }}</h1></BreadcrumbPage
                  >
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <template v-else>
              <h1 ref="heading">{{ route.meta.title }}</h1>
            </template>
          </div>
          <!-- While the 设置 window is open, its own header is where its pages put their actions. -->
          <div :id="settingsOpen ? undefined : 'page-actions'" class="page-actions"></div>
        </header>
        <div :key="route.matched[0]?.path" class="page-enter"><slot /></div>
      </main>
    </div>
    <Toasts />
    <ConfirmDialog />
    <InstallApp v-if="installPlace" v-model:open="installOpen" :place="installPlace" />
    <ReconnectOverlay :reconnecting="reconnecting" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { PanelPayload } from "../../../src/shared/panel";
import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import InstallApp from "../components/InstallApp.vue";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "../components/ui/breadcrumb";
import { Button, buttonVariants } from "../components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet";
import { useLive, useSession } from "../context";
import { installPlace as placeFor } from "../lib/android-app";
import { confirmDialog } from "../lib/dialog";
import { editorRegistry } from "../lib/editor-guard";
import { flattenPlugins } from "../lib/plugin-config";
import { useTopic } from "../lib/use-topic";
import { sessionTopics, visibleGroups } from "../nav";
import { platformSummary, presentPlatforms } from "../pages/platforms-model";
import { applyTheme, readTheme, type ThemePreference } from "../theme";
import { botIdentityKey, useBotIdentity } from "./bot-identity";
import BrandMark from "./BrandMark.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { connectionNoticeKey } from "./connection-notice";
import Icon from "./Icon.vue";
import { pageCrumb } from "./page-crumb";
import { fullPage, widePage } from "./page-width";
import ReconnectOverlay from "./ReconnectOverlay.vue";
import Toasts from "./Toasts.vue";

/** The page in the shell; while the 设置 window is open, the page under it. */
const route = useRoute();
const router = useRouter();
const settingsOpen = computed(() => !!router.currentRoute.value.meta.settings);
const session = useSession();
const live = useLive();
const drawer = ref(false);
const mobile = ref(false);
const sidebar = ref<HTMLElement>();
const menuButton = ref<HTMLButtonElement>();
let media: MediaQueryList | undefined;
function syncViewport() {
  mobile.value = media?.matches ?? false;
  if (!mobile.value) drawer.value = false;
}
onMounted(() => {
  media = window.matchMedia("(max-width: 900px)");
  syncViewport();
  media.addEventListener("change", syncViewport);
});
/**
 * Phone top bar. A page shows its name only after its own heading has scrolled under the bar, so the name is never
 * on screen twice. (设置 is a window over the page and names itself.)
 */
const topbarTitle = computed(() => pageCrumb.value?.label ?? route.meta.title);
const heading = ref<HTMLElement>();
const headingInView = ref(false);
let headingObserver: IntersectionObserver | undefined;
watch(
  heading,
  (element) => {
    headingObserver?.disconnect();
    headingInView.value = false;
    if (!element || typeof IntersectionObserver === "undefined") return;
    headingObserver = new IntersectionObserver(([entry]) => (headingInView.value = !!entry?.isIntersecting), { rootMargin: "-52px 0px 0px 0px" });
    headingObserver.observe(element);
  },
  { flush: "post" },
);
onBeforeUnmount(() => {
  headingObserver?.disconnect();
  media?.removeEventListener("change", syncViewport);
});

const groups = computed(() => visibleGroups(session.state.features, session.state.role));
const panel = useTopic<PanelPayload | null>("panel");
// Keep only sidebar state pinned; heavier data is subscribed by the visible page.
watch(
  () => sessionTopics(session.state.features),
  (topics, _, onCleanup) => onCleanup(live.pin(topics)),
  { immediate: true },
);
const plugins = live.use<PluginsSnapshot>("plugins");
onBeforeUnmount(plugins.release);
const bot = useBotIdentity(plugins, panel);
provide(botIdentityKey, bot);
provide(connectionNoticeKey, true);
/** The one disconnect notice for every page in the shell (topic feedback inside does not repeat it): a full-screen loading layer. */
const reconnecting = computed(() => live.status.value === "reconnecting");
const liveLabel = computed(() => ({ idle: "未连接", connecting: "连接中", open: "实时", reconnecting: "重连中" })[live.status.value]);
const liveClass = computed(() =>
  live.status.value !== "open" ? (live.status.value === "reconnecting" ? "warn" : "") : panel.data?.health.online === false ? "warn" : "ok",
);
/** The bot's own state under its name; the connection state only while the page is not live. */
const statusLabel = computed(() => (live.status.value !== "open" ? liveLabel.value : panel.data?.health.online === false ? "未运行" : "运行中"));
const attention = computed(
  () => flattenPlugins(plugins.state.data?.tree ?? []).filter((entry) => !entry.group && (entry.needsConfig || entry.status === "failed")).length,
);
/** 设置 is marked when a platform is not online; 系统 when a feature failed or still needs setting up (listed in its status). */
const marks = computed<Record<string, { tone: string; label: string } | undefined>>(() => ({
  settings: platforms.value && platforms.value.tone !== "ok" ? platforms.value : undefined,
  system: attention.value ? { tone: "warn", label: `${attention.value} 项功能需要处理` } : undefined,
}));
/** Every chat platform's connection, e.g. "QQ 在线 · 微信未连接". */
const platforms = computed(() => {
  const summary = platformSummary(presentPlatforms(panel.data ?? undefined, [], session.state.features));
  if (!summary) return undefined;
  if (panel.stale && !panel.cached) return { tone: "warn", label: "平台状态过期" };
  return { tone: summary.tone === "ok" ? "ok" : "warn", label: summary.label };
});

const theme = ref<ThemePreference>(readTheme());
/** 安装 App (user, 2026-11-26): a computer or an Android phone, never inside the app or on an iPhone. */
const installPlace = placeFor(navigator.userAgent, navigator.maxTouchPoints, navigator.platform);
const installOpen = ref(false);
/** On a phone the button sits in the drawer: the drawer closes first, or the dialog would open under it. */
function openInstall() {
  drawer.value = false;
  void nextTick(() => (installOpen.value = true));
}
const themeLabel = computed(() => ({ system: "主题：跟随系统", light: "主题：浅色", dark: "主题：深色" })[theme.value]);
function cycleTheme() {
  theme.value = theme.value === "system" ? "light" : theme.value === "light" ? "dark" : "system";
  applyTheme(theme.value);
}

async function signOut() {
  if (editorRegistry.busy()) {
    await editorRegistry.leave();
    return;
  }
  if (
    !(await confirmDialog({
      title: "退出登录？",
      message: editorRegistry.changed() ? "当前还有未保存的修改，退出前请确认不需要保存。" : undefined,
      confirmLabel: "退出",
      danger: editorRegistry.changed(),
    }))
  )
    return;
  await session.logout().catch(() => {});
  live.reset();
  await router.replace({ name: "login" });
}
</script>
<style scoped>
/* UI-EXCEPTION app-layout: responsive navigation rail and page grid compose shadcn Button, Breadcrumb and mobile Sheet; geometry is application-specific. */
@reference "../styles/app.css";

.shell {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  min-height: 100vh;
  min-height: 100dvh;
}
.sidebar {
  @apply border-r border-border;
  position: sticky;
  top: 0;
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--sidebar);
  padding: 16px 12px 12px;
  overflow-y: auto;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 24px;
}
.bot {
  @apply rounded-lg text-inherit;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
  padding: 8px;
  margin: -8px;
  text-decoration: none;
}
.bot:hover {
  background: var(--surface-hover, color-mix(in srgb, var(--text) 5%, transparent));
}
.bot-text {
  display: grid;
  gap: 4px;
  min-width: 0;
}
/* The icon is its own tile; the corner is clipped on the drawing so the status dot can sit outside it. */
.logo {
  @apply rounded-lg;
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
}
.logo svg {
  width: 100%;
  height: 100%;
  border-radius: inherit;
}
.product {
  @apply font-sans text-base;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.bot-text .live {
  margin-left: 0;
}
.live {
  @apply text-xs text-muted-foreground;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  white-space: nowrap;
}
.live .dot {
  width: 6px;
  height: 6px;
}
.live.warn {
  @apply text-warn;
}
nav {
  display: grid;
  gap: 20px;
}
nav section {
  display: grid;
  gap: 4px;
}
nav h2 {
  @apply text-xs font-medium text-muted-foreground;
  padding: 0 12px 8px;
  letter-spacing: 0.08em;
}
.nav-item {
  @apply rounded-lg text-subtle text-sm font-medium;
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 12px;
  transition:
    background 0.12s,
    color 0.12s;
}
.nav-item :deep(.icon) {
  @apply text-muted-foreground;
  width: 17px;
  height: 17px;
}

.nav-item.active :deep(.icon) {
  @apply text-primary;
}
.nav-label {
  flex: 1;
  min-width: 0;
}
.mark {
  @apply rounded-full;
  width: 7px;
  height: 7px;
  flex: none;
}
.mark.ok {
  @apply bg-ok;
}
.mark.warn {
  @apply bg-warn;
}
footer {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 8px 4px;
}
.avatar {
  @apply rounded-full bg-surface-3 text-foreground font-sans text-sm font-semibold;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: none;
}
.who {
  flex: 1;
  min-width: 0;
  display: grid;
  line-height: 1.25;
}
.who strong {
  @apply text-sm font-semibold;
}
.who span {
  @apply text-xs text-muted-foreground;
}
footer .btn :deep(.icon) {
  width: 16px;
  height: 16px;
}
.main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: none;
}
.topbar-actions {
  display: flex;
  align-items: center;
}
.topbar-actions:empty {
  display: none;
}
.content {
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 36px 40px 64px;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  gap: 24px;
  min-width: 0;
}
/* The chat fills the window exactly; only its own lists scroll. `clip`, not `hidden`: a hidden box can still be
   scrolled by scrollIntoView or focus, which shifted the whole chat up and left the window's bottom blank. */
.chat-shell {
  grid-template-rows: minmax(0, 1fr);
  height: 100dvh;
  min-height: 0;
  overflow: clip;
}
.chat-shell .main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: clip;
}
.chat-shell .topbar {
  flex-shrink: 0;
}
.chat-shell .content.full {
  max-width: none;
  padding: 0;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: clip;
}
.content.full > .page-enter {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: clip;
}
/* Form pages: a reading column at the same left edge as every other page, so nothing jumps. */
.content.form > * {
  width: 100%;
  max-width: 960px;
}
.page-enter {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  animation: page-in 0.18s ease-out;
}
@keyframes page-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
.page-heading {
  min-width: 0;
}
.crumbs {
  min-width: 0;
  flex-wrap: nowrap;
  font-size: inherit;
}
.crumb-root {
  cursor: pointer;
}
.crumbs :deep([data-slot="breadcrumb-separator"] svg) {
  width: 18px;
  height: 18px;
}
.page-actions:empty {
  display: none;
}
.close,
.menu {
  display: none;
}

/* Desktop: a narrow rail of icons, each named on hover; the phone drawer below keeps the names. */
@media (min-width: 901px) {
  .shell {
    grid-template-columns: var(--rail-width) minmax(0, 1fr);
  }
  .sidebar {
    align-items: center;
    padding: 16px 0 12px;
    overflow: visible;
  }
  .brand {
    padding: 0 0 20px;
  }
  .bot {
    flex: none;
    margin: 0;
    padding: 0;
  }
  .bot-text,
  nav h2,
  .who {
    display: none;
  }
  .logo {
    position: relative;
  }
  .logo-dot {
    @apply rounded-full bg-muted-foreground;
    position: absolute;
    right: -4px;
    bottom: -4px;
    width: 10px;
    height: 10px;
    border: 2px solid var(--sidebar);
  }
  .logo-dot.ok {
    @apply bg-ok;
  }
  .logo-dot.warn {
    @apply bg-warn;
  }
  nav {
    gap: 8px;
  }
  .nav-item {
    @apply rounded-full;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
  }
  .nav-item :deep(.icon) {
    width: 19px;
    height: 19px;
  }
  .nav-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .mark {
    position: absolute;
    top: 8px;
    right: 8px;
    box-shadow: 0 0 0 2px var(--sidebar);
  }
  footer {
    flex-direction: column;
    gap: 8px;
    padding: 12px 0 0;
  }
  footer .avatar {
    order: 3;
    margin-top: 4px;
  }
}
@media (max-width: 900px) {
  .logo-dot {
    display: none;
  }
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    width: min(280px, 86vw);
    z-index: 50;
    height: 100dvh;
  }
  .open .sidebar {
    transform: none;
  }

  .close,
  .menu {
    display: inline-flex;
  }
  .topbar {
    @apply border-b border-border;
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 52px;
    padding: 0 12px 0 8px;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(10px);
  }
  .topbar-title {
    @apply font-semibold text-base;
    flex: 1;
    min-width: 0;
    transition: opacity 0.15s;
  }
  .topbar-title.quiet {
    opacity: 0;
  }
  .content {
    padding: 20px 16px 40px;
    gap: 16px;
  }
}
</style>

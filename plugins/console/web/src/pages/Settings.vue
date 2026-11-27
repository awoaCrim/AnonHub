<template>
  <!-- 设置 is a window over the current page (user, 2026-11-22: 「整个设置页面也做成弹窗」); closing it returns to that page. -->
  <Dialog :open="true" @update:open="(open) => open || close()">
    <DialogContent
      class="settings-window h-[min(860px,calc(100dvh-3rem))] max-h-none w-[min(1100px,calc(100vw-3rem))] gap-0 overflow-clip rounded-[22px] p-0 sm:max-w-none max-[900px]:h-dvh max-[900px]:w-screen max-[900px]:rounded-none max-[900px]:border-0"
      :aria-describedby="undefined"
      @open-auto-focus="focusPage"
      @escape-key-down="backOnEscape"
    >
      <div class="settings-layout">
        <aside class="settings-side">
          <DialogTitle class="window-title">设置</DialogTitle>
          <nav ref="nav" class="settings-nav" aria-label="设置分类">
            <RouterLink
              v-for="item in items"
              :key="item.name"
              :to="item.path"
              class="settings-link"
              :aria-current="route.name === item.name ? 'page' : undefined"
            >
              <Icon :name="item.icon" />
              <span class="label">{{ item.label }}</span>
              <span v-if="marks[item.name]" class="mark" :class="marks[item.name]!.tone" :title="marks[item.name]!.label"
                ><span class="sr-only">{{ marks[item.name]!.label }}</span></span
              >
            </RouterLink>
          </nav>
        </aside>
        <section ref="main" class="settings-main" tabindex="-1">
          <header class="page-head">
            <div class="page-heading">
              <h1 v-if="!subpages.stack.length">{{ route.meta.title }}</h1>
              <!-- Inside a category: where it is, each level a way back (Esc goes back one). -->
              <Breadcrumb v-else class="crumbs">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink as="button" type="button" @click="subpages.back(0)">{{ route.meta.title }}</BreadcrumbLink>
                  </BreadcrumbItem>
                  <template v-for="(page, index) in subpages.stack" :key="page.id">
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage v-if="index === subpages.stack.length - 1"
                        ><h1>{{ page.title() }}</h1></BreadcrumbPage
                      >
                      <BreadcrumbLink v-else as="button" type="button" @click="subpages.back(index + 1)">{{ page.title() }}</BreadcrumbLink>
                    </BreadcrumbItem>
                  </template>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
            <div v-show="!subpages.stack.length" id="page-actions" class="page-actions"></div>
          </header>
          <!-- The category page stays mounted under its subpages, keeping its drafts and place. -->
          <div v-show="!subpages.stack.length" class="page-body" :class="{ back: cameBack }">
            <RouterView v-slot="{ Component }">
              <Transition name="page"><component :is="Component" :key="String(route.name)" /></Transition>
            </RouterView>
          </div>
          <div ref="subpageArea" class="subpage-area"></div>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { PanelPayload } from "../../../src/shared/panel";
import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "../components/ui/breadcrumb";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { useSession } from "../context";
import { prefetch } from "../lib/cache";
import { flattenPlugins } from "../lib/plugin-config";
import { useTopic } from "../lib/use-topic";
import { settingsPages, visibleSettings } from "../nav";
import Icon from "../shell/Icon.vue";
import { createSubpageHost, subpageHostKey } from "../shell/settings-subpages";
import { settingsBackground } from "../shell/settings-window";
import { useAbilityIssues } from "../state/ability-issues";
import { platformSummary, presentPlatforms } from "./platforms-model";

/**
 * 设置: every way to configure the bot, one category per kind, in a window over the page the user was on. The
 * sidebar keeps what is used day to day (对话, 会话管理); low-frequency management stays here.
 */
const route = useRoute();
const router = useRouter();
/** Closing goes back to the page under the window; an unsaved editor still asks first (the router's leave guard). */
function close() {
  void router.push(settingsBackground.value);
}
const session = useSession();
const items = computed(() => visibleSettings(session.state.features, session.state.role === "member" ? "member" : "owner"));
const panel = useTopic<PanelPayload | null>("panel");
const plugins = useTopic<PluginsSnapshot>("plugins");
const abilities = useAbilityIssues();

/**
 * Each request costs about a second on the public link (2026-11-21), so entering 设置 reads every settings page's data
 * at once, in parallel; switching pages then shows them without waiting.
 */
let prefetched = false;
watch(
  () => plugins.data,
  (data) => {
    if (prefetched || !data) return;
    prefetched = true;
    const entries = flattenPlugins(data.tree).filter((entry) => !entry.group);
    const config = (name: string) => entries.find((entry) => entry.name === name)?.path;
    void prefetch([
      "/yesimbot/model-settings",
      "/yesimbot/api/v1/plugins/schema?name=yesimbot",
      ...["yesimbot", "yesimbot-message-debounce"].flatMap((name) => {
        const path = config(name);
        return path ? [`/yesimbot/api/v1/plugins/config?path=${encodeURIComponent(path)}`] : [];
      }),
      ...(session.state.features.accounts ? ["/yesimbot/admin/context-policy"] : []),
    ]);
  },
  { immediate: true },
);
/** On phones the categories are one scrolling row: keep the current one in view. */
const nav = ref<HTMLElement>();
const main = ref<HTMLElement>();
const subpageArea = ref<HTMLElement>();
/** What a category opens (a service, a capability's settings) is a page of this window, never a dialog over it. */
const subpages = createSubpageHost(main, subpageArea);
provide(subpageHostKey, subpages);
const cameBack = ref(false);
watch(
  () => subpages.stack.length,
  (depth) => (cameBack.value ||= !depth),
);
/** Esc leaves a subpage before it closes the window. */
function backOnEscape(event: KeyboardEvent) {
  if (!subpages.stack.length) return;
  event.preventDefault();
  subpages.back(subpages.stack.length - 1);
}
/** Focus starts on the page itself, not on the first category (which would show a focus ring on opening). */
function focusPage(event: Event) {
  // The window's content mounts after this component (in a portal): bring the open category into view now.
  revealCurrent();
  if (!main.value) return;
  event.preventDefault();
  main.value.focus({ preventScroll: true });
}
function revealCurrent() {
  const row = nav.value,
    link = row?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!row || !link || row.scrollWidth <= row.clientWidth) return;
  const box = row.getBoundingClientRect(),
    item = link.getBoundingClientRect();
  row.scrollLeft += item.left - box.left - (box.width - item.width) / 2;
}
watch(
  () => route.name,
  () => {
    // Another category starts at its top, as a page would, even if it replaced an open subpage.
    subpages.reset();
    if (main.value) main.value.scrollTop = 0;
    cameBack.value = false;
    void nextTick(revealCurrent);
  },
);
onMounted(revealCurrent);
const marks = computed<Record<string, { tone: string; label: string } | undefined>>(() => {
  const instances = flattenPlugins(plugins.data?.tree ?? []).filter((item) => !item.group);
  return {
    [settingsPages.platforms.name]: platformSummary(presentPlatforms(panel.data ?? undefined, instances, session.state.features)),
    [settingsPages.extensions.name]: abilities.count.value ? { tone: "danger", label: `${abilities.count.value} 项需要处理` } : undefined,
  };
});
</script>
<style scoped>
@reference "../styles/app.css";

/* UI-EXCEPTION settings-window: the window's two-pane geometry (categories | page) inside the shared Dialog. */
.settings-layout {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.settings-side {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-height: 0;
  padding: 24px 16px;
  overflow-y: auto;
  background: var(--sidebar);
  border-right: 1px solid var(--group-line);
}
.window-title {
  padding: 0 12px;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.settings-nav {
  display: grid;
  align-content: start;
  gap: 4px;
}
.settings-link {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 0 12px;
  border-radius: 12px;
  color: var(--text-2);
  font-size: 14px;
  text-decoration: none;
  transition:
    background-color var(--t-fast) ease,
    color var(--t-fast) ease;
}
.settings-link:hover {
  background: var(--group);
  color: var(--text);
}
.settings-link[aria-current="page"] {
  background: var(--group-hover);
  color: var(--text);
  font-weight: 600;
}
.settings-link:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.settings-link .icon {
  flex: none;
  width: 18px;
  height: 18px;
}
.settings-link[aria-current="page"] .icon {
  @apply text-primary;
}
.label {
  flex: 1;
}
.mark {
  @apply rounded-full bg-muted-foreground;
  width: 7px;
  height: 7px;
}
.mark.ok {
  @apply bg-ok;
}
.mark.warn {
  @apply bg-warn;
}
.mark.danger {
  @apply bg-destructive;
}
.settings-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  gap: 24px;
  min-width: 0;
  min-height: 0;
  padding: 28px 36px 36px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
.settings-main:focus {
  outline: none;
}
.page-body,
.subpage-area {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
}
.subpage-area:empty {
  display: none;
}
/* Back on the category page: it comes back the way a subpage arrives. */
.page-body.back {
  animation: page-arrive var(--t-mid) var(--ease-out);
}
.crumbs :deep([data-slot="breadcrumb-list"]) {
  @apply gap-2 text-lg font-semibold;
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.crumbs :deep([data-slot="breadcrumb-link"]) {
  @apply cursor-pointer rounded-md text-muted-foreground;
}
.crumbs :deep([data-slot="breadcrumb-link"]:focus-visible) {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
.crumbs :deep([data-slot="breadcrumb-separator"] > svg) {
  @apply size-5 text-muted-foreground;
}
.crumbs h1 {
  font: inherit;
  letter-spacing: inherit;
  overflow-wrap: anywhere;
}
/* Clear of the window's close button in the corner. */
.settings-main .page-head {
  padding-right: 40px;
}
@media (max-width: 900px) {
  /* Phones and narrow windows: the window fills the screen, the categories are one scrolling row above the page. */
  .settings-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .settings-side {
    gap: 12px;
    padding: 16px 0 12px;
    overflow: visible;
    border-right: 0;
    border-bottom: 1px solid var(--group-line);
  }
  .window-title {
    padding: 4px 16px 0;
  }
  .settings-nav {
    display: flex;
    gap: 8px;
    padding: 0 16px 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .settings-nav::-webkit-scrollbar {
    display: none;
  }
  .settings-link {
    flex: none;
    min-height: 36px;
    padding: 0 16px;
    border-radius: 999px;
    background: var(--group);
  }
  .settings-link[aria-current="page"] {
    background: var(--text);
    color: var(--bg);
  }
  .settings-link[aria-current="page"] .icon {
    @apply text-inherit;
  }
  .settings-main {
    padding: 20px 16px 32px;
    scrollbar-gutter: auto;
  }
  .settings-main .page-head {
    padding-right: 0;
  }
}
</style>

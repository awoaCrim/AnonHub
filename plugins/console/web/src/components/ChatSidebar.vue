<template>
  <DialogRoot :open="open" :modal="!layerInline" @update:open="emit('update:open', $event)">
    <DialogPortal :disabled="layerInline">
      <DialogOverlay
        v-if="!layerInline"
        class="fixed inset-0 z-40 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />
      <DialogContent
        id="chat-sidebar"
        force-mount
        class="chat-sidebar"
        :class="{ 'is-desktop': inline, 'is-computer': panel === 'computer', closed: !open, moving }"
        :inert="!open || undefined"
        :role="layerInline ? 'complementary' : 'dialog'"
        @open-auto-focus="layerInline && $event.preventDefault()"
        @interact-outside="layerInline && $event.preventDefault()"
        @escape-key-down="layerInline && $event.preventDefault()"
      >
        <div :ref="rememberTarget" class="sidebar-inner" />
      </DialogContent>
    </DialogPortal>
    <Teleport v-if="mountTarget" :to="mountTarget">
      <!-- The computer window's bar comes with its screen (ChatSideContent). -->
      <DialogTitle v-if="panel === 'computer'" class="sr-only">{{ titles.computer }}</DialogTitle>
      <header v-else class="sidebar-identity">
        <Button variant="ghost" size="icon-sm" class="identity-close rounded-full" aria-label="收起右栏" @click="emit('update:open', false)"
          ><X class="size-4"
        /></Button>
        <BotAvatar class="identity-avatar" style="--avatar-size: 84px" />
        <DialogTitle class="identity-name">{{ botName }}</DialogTitle>
        <p class="identity-status" :class="{ busy: !!status }" aria-live="polite">
          <span class="identity-status-text" :title="status || undefined" :aria-hidden="status ? undefined : 'true'"
            ><span class="pulse" aria-hidden="true"></span>{{ shownStatus }}</span
          >
        </p>
      </header>
      <DialogDescription class="sr-only">查看本会话任务、电脑屏幕和角色与记忆文件。</DialogDescription>
      <nav
        v-if="panel !== 'computer'"
        class="sidebar-tabs"
        aria-label="对话右栏"
        :style="{
          '--tab': Math.max(
            0,
            panels.findIndex((item) => item.id === panel),
          ),
        }"
      >
        <Button
          v-for="item in panels"
          :key="item.id"
          variant="ghost"
          size="sm"
          class="sidebar-tab"
          :class="{ active: panel === item.id }"
          :aria-current="panel === item.id ? 'page' : undefined"
          @click="emit('select', item.id)"
          ><component :is="item.icon" class="size-4" />{{ item.label }}</Button
        >
      </nav>
      <div class="sidebar-content"><slot /></div>
      <footer v-if="panel !== 'computer'" class="sidebar-footer">
        <Button variant="ghost" size="sm" class="w-full justify-start rounded-xl" @click="emit('select', 'computer')">
          <Monitor class="size-4" />打开电脑<ArrowUpRight class="ml-auto size-4" />
        </Button>
        <Button variant="ghost" size="sm" class="w-full justify-start rounded-xl" :disabled="startingSession" @click="emit('new-session')">
          <SquarePen class="size-4" />{{ startingSession ? "正在开始新对话…" : "开始新对话" }}
        </Button>
      </footer>
    </Teleport>
  </DialogRoot>
</template>
<script setup lang="ts">
import { ArrowRightUp as ArrowUpRight, Files, Checklist as ListTodo, Monitor, PenSquare as SquarePen, X } from "reicon-vue";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { computed, onBeforeUnmount, ref, shallowRef, watch, type ComponentPublicInstance } from "vue";

import { provideDialogLayers } from "../lib/dialog-layers";
import BotAvatar from "../shell/BotAvatar.vue";
import { Button } from "./ui/button";
export type ChatPanel = "tasks" | "computer" | "files";
const props = defineProps<{ open: boolean; desktop: boolean; panel: ChatPanel; startingSession: boolean; botName: string; status?: string }>();
const inline = computed(() => props.desktop && props.panel !== "computer");
const layers = provideDialogLayers();
const layerInline = ref(inline.value);
watch(
  [inline, layers],
  ([value, count]) => {
    if (!count) layerInline.value = value;
  },
  { flush: "post" },
);
const emit = defineEmits<{ "update:open": [value: boolean]; select: [value: ChatPanel]; "new-session": [] }>();
/** The last thing it said it was doing stays while the line closes, so the line shrinks away instead of emptying at once. */
const shownStatus = ref(props.status ?? "");
watch(
  () => props.status,
  (value) => {
    if (value) shownStatus.value = value;
  },
);
// The modal wrapper changes at responsive breakpoints; this retained teleport keeps document drafts and device selection alive.
const mountTarget = shallowRef<HTMLElement>();
function rememberTarget(value: Element | ComponentPublicInstance | null) {
  if (value instanceof HTMLElement) mountTarget.value = value;
}
/**
 * Only opening and closing slide the panel (user, 2026-11-19: transitions were missing). Switching between the narrow
 * panel and the computer window changes its geometry at once, so nothing slides across the page then.
 */
const moving = ref(false);
let settle: ReturnType<typeof setTimeout> | undefined;
watch(
  () => props.open,
  () => {
    moving.value = true;
    clearTimeout(settle);
    settle = setTimeout(() => (moving.value = false), 400);
  },
);
onBeforeUnmount(() => clearTimeout(settle));
const titles = { tasks: "任务", computer: "电脑", files: "角色与记忆" };
const panels = [
  { id: "tasks", label: "任务", icon: ListTodo },
  { id: "files", label: "角色", icon: Files },
] as const;
</script>
<style scoped>
@reference "../styles/app.css";
/* The panel shares the page colour; a hairline separates it from the chat. */
.chat-sidebar {
  @apply bg-background;
  --panel-width: min(440px, 92vw);
  position: fixed;
  z-index: 50;
  inset: 0 0 0 auto;
  display: flex;
  flex-direction: column;
  width: var(--panel-width);
  height: 100dvh;
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--line);
  outline: none;
  /* Clipped, never scrollable itself: only .sidebar-content scrolls (see AppShell's chat layout). */
  overflow: clip;
}
.chat-sidebar.closed {
  visibility: hidden;
  transform: translateX(100%);
}
.chat-sidebar.is-desktop {
  --panel-width: clamp(340px, 24vw, 400px);
  position: relative;
  z-index: auto;
  inset: auto;
  flex-shrink: 0;
  height: 100%;
}
/* Beside the chat it opens by widening, so the conversation makes room smoothly instead of jumping. */
.chat-sidebar.is-desktop.closed {
  width: 0;
  border-left-width: 0;
  transform: none;
}
/* Keeps its width while the panel narrows; the height still fits the panel, so the content scrolls inside it. */
.chat-sidebar.is-desktop .sidebar-inner {
  width: var(--panel-width);
}
.chat-sidebar.moving {
  transition:
    transform var(--t-slow) var(--ease-panel),
    width var(--t-slow) var(--ease-panel),
    opacity var(--t-mid) ease,
    visibility 0s linear 0s;
}
.chat-sidebar.moving.closed {
  transition:
    transform var(--t-slow) var(--ease-panel),
    width var(--t-slow) var(--ease-panel),
    opacity var(--t-mid) ease,
    border-left-width 0s linear var(--t-slow),
    visibility 0s linear var(--t-slow);
}
.chat-sidebar.is-computer {
  inset: 50% auto auto 50%;
  width: min(1440px, 96vw);
  height: min(94dvh, 1100px);
  transform: translate(-50%, -50%);
  border: 1px solid var(--border);
  border-radius: 20px;
  @apply bg-card;
  box-shadow: var(--shadow-lg);
}
/* The computer window grows in where it stands and fades out the same way. */
.chat-sidebar.is-computer.closed {
  opacity: 0;
  transform: translate(-50%, -49%) scale(0.98);
}
@media (min-width: 640px) {
  .chat-sidebar.is-computer:not(.closed) {
    animation: window-in var(--t-mid) var(--ease-out);
  }
}
@keyframes window-in {
  from {
    opacity: 0;
    transform: translate(-50%, -48%) scale(0.98);
  }
}
.sidebar-inner {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
/* Who it is, centred at the top of the panel; the line under the name says what it is doing right now. */
.sidebar-identity {
  position: relative;
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 28px 20px 8px;
  text-align: center;
}
.identity-close {
  @apply text-muted-foreground;
  position: absolute;
  top: 16px;
  right: 16px;
}
.identity-avatar {
  @apply rounded-2xl;
  margin-bottom: 8px;
}
.identity-name {
  @apply text-lg font-semibold text-foreground;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * Closed while it is idle; the line opens to its text's height when it starts working and closes the same way, so
 * nothing below jumps. A long status takes a second line and ends there with an ellipsis; the tooltip has all of it
 * (user, 2026-11-19: two lines in a one-line box lost their top and bottom).
 */
.identity-status {
  @apply text-sm text-muted-foreground;
  display: grid;
  grid-template-rows: 0fr;
  max-width: 100%;
  opacity: 0;
  transition:
    grid-template-rows var(--t-mid) var(--ease-out),
    opacity var(--t-mid) ease;
}
.identity-status.busy {
  grid-template-rows: 1fr;
  opacity: 1;
}
.identity-status-text {
  display: -webkit-box;
  min-height: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
/* Sits on the first line, level with the middle of the characters. */
.pulse {
  @apply rounded-full bg-primary;
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 8px;
  vertical-align: 0.15em;
  animation: pulse 1.4s ease-in-out infinite;
}
.identity-status:not(.busy) .pulse {
  animation: none;
}
@keyframes pulse {
  50% {
    opacity: 0.35;
    transform: scale(0.8);
  }
}
/* Two tabs on one grey track; a white thumb slides under the chosen one. */
.sidebar-tabs {
  @apply bg-muted;
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 8px 20px 16px;
  padding: 4px;
  border-radius: 999px;
}
.sidebar-tabs::before {
  content: "";
  background: var(--control-thumb);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc((100% - 6px) / 2);
  border-radius: 999px;
  transform: translateX(calc(var(--tab) * 100%));
  transition: transform var(--t-mid) var(--ease-panel);
}
.sidebar-tab {
  @apply rounded-full text-muted-foreground;
  position: relative;
  height: 30px;
}
.sidebar-tab:hover {
  @apply bg-transparent text-foreground;
}
.sidebar-tab.active {
  @apply text-foreground;
}
.sidebar-content {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 16px 20px;
}
.is-computer .sidebar-content {
  padding: 12px 16px 16px;
  overflow: hidden;
}
.sidebar-footer {
  flex-shrink: 0;
  padding: 8px 12px;
}
@media (max-width: 639px) {
  .chat-sidebar,
  .chat-sidebar.is-computer {
    inset: auto 0 0;
    width: 100%;
    height: min(88dvh, 900px);
    border-left: 0;
    border-top: 1px solid var(--line);
    border-radius: 20px 20px 0 0;
    transform: none;
    animation: none;
  }
  .chat-sidebar.closed,
  .chat-sidebar.is-computer.closed {
    transform: translateY(100%);
  }
  /* The computer sheet is as tall as its screen, not a mostly empty sheet. */
  .chat-sidebar.is-computer {
    height: auto;
    max-height: min(88dvh, 900px);
  }
  .is-computer .sidebar-content {
    padding: 12px 12px max(12px, env(safe-area-inset-bottom));
    overflow-y: auto;
  }
  .sidebar-identity {
    padding-top: 20px;
  }
  .sidebar-content {
    padding-inline: 12px;
  }
  .sidebar-footer {
    padding-bottom: max(8px, env(safe-area-inset-bottom));
  }
}
@media (prefers-reduced-motion: reduce) {
  .pulse {
    animation: none;
  }
}
</style>

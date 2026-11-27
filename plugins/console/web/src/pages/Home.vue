<template>
  <div class="web-home">
    <div class="chat-main">
      <!-- No bar over the messages (user, 2026-11-27: 「这上面咋还是挡了那么多」): the name scrolls with them; the
           side panel's toggle floats in the corner, or sits in the phone's top bar. -->
      <Teleport defer to="#topbar-actions" :disabled="!phone">
        <Button
          id="chat-sidebar-toggle"
          variant="ghost"
          size="icon"
          class="rounded-full text-muted-foreground"
          :class="{ 'panel-toggle': !phone }"
          :aria-label="panelOpen ? '收起右栏' : '展开右栏'"
          :aria-expanded="panelOpen"
          aria-controls="chat-sidebar"
          @click="setPanelOpen(!panelOpen)"
          ><PanelRight
        /></Button>
      </Teleport>
      <WebChat :chat="chat" :persona="persona">
        <template #top
          ><h1 class="chat-title truncate">{{ persona.bot.value.name }}</h1></template
        >
      </WebChat>
    </div>
    <ChatSidebar
      :bot-name="persona.bot.value.name"
      :status="chat.typing.value ? chat.activity.value || '正在回复…' : ''"
      :open="panelOpen"
      :desktop="desktop"
      :panel="panel"
      :starting-session="startingSession"
      @update:open="setPanelOpen"
      @select="setPanel"
      @new-session="newSession"
    >
      <ChatSideContent
        :panel="panel"
        :visible="panelOpen"
        :computers="computers"
        :devices-loading="devicesLoading"
        :devices-error="devicesError"
        :preferred-device-id="chat.state.snapshot?.computerDeviceId"
        :persona="persona"
        :conversation="chat.state.snapshot?.conversation"
        :document="route.query.document === 'memory' ? 'memory' : route.query.document === 'role' ? 'role' : undefined"
        @back="setPanel('tasks')"
        @close="setPanelOpen(false)"
      />
    </ChatSidebar>
  </div>
</template>
<script setup lang="ts">
import { useMediaQuery } from "@vueuse/core";
import type { DeviceView } from "@yesimbot/contracts";
import { SidebarRight as PanelRight } from "reicon-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ChatSnapshot } from "../../../src/shared/chat";
import ChatSidebar, { type ChatPanel } from "../components/ChatSidebar.vue";
import ChatSideContent from "../components/ChatSideContent.vue";
import { Button } from "../components/ui/button";
import WebChat from "../components/WebChat.vue";
import { api } from "../lib/api";
import { isWorkspaceDevice, loadDevices } from "../lib/devices";
import { confirmDialog } from "../lib/dialog";
import { editorRegistry } from "../lib/editor-guard";
import { toast } from "../lib/toast";
import { useTopic } from "../lib/use-topic";
import { useWebPersona } from "../lib/web-persona";
import { botIdentityKey } from "../shell/bot-identity";
import { fullPage } from "../shell/page-width";
import { createWebChat } from "../state/web-chat";
const chat = createWebChat();
const topic = useTopic<ChatSnapshot>("chat");
watch(() => topic.data, chat.accept, { immediate: true });
const persona = useWebPersona(chat);
provide(botIdentityKey, persona.bot);
const route = useRoute(),
  router = useRouter();
const desktop = useMediaQuery("(min-width: 1100px)");
/** The shell's phone layout (AppShell, max-width 900px), which has a top bar. */
const phone = useMediaQuery("(max-width: 900px)");
const panel = ref<ChatPanel>("tasks"),
  panelOpen = ref(desktop.value);
// Hiding the retained sidebar never discards a document or resets the selected panel.
function setPanel(value: ChatPanel) {
  panel.value = value;
  syncPanelRoute(true);
}
function setPanelOpen(open: boolean) {
  panelOpen.value = open;
  syncPanelRoute(open);
}
function syncPanelRoute(open: boolean) {
  void router.replace({
    query: {
      ...route.query,
      panel: open ? panel.value : undefined,
      view: undefined,
      document: open && panel.value === "files" ? route.query.document : undefined,
    },
    hash: route.hash,
  });
}
watch(panelOpen, async (open) => {
  if (!open) {
    await nextTick();
    document.getElementById("chat-sidebar-toggle")?.focus();
  }
});
watch(
  () => [route.query.panel, route.query.view],
  ([requested, legacyView]) => {
    const value = requested ?? (legacyView === "screen" ? "computer" : undefined);
    if (value === "files" || value === "computer" || value === "tasks") {
      panel.value = value;
      panelOpen.value = true;
    }
  },
  { immediate: true },
);
const devices = ref<DeviceView[]>([]),
  devicesLoading = ref(true),
  devicesError = ref("");
const computers = computed(() => devices.value.filter((d) => !d.revokedAt && isWorkspaceDevice(d)));
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
async function poll() {
  try {
    const result = await loadDevices(true);
    if (!disposed) {
      devices.value = result.devices;
      devicesError.value = "";
    }
  } catch {
    if (!disposed) devicesError.value = "暂时无法读取电脑状态，稍后会自动重试。";
  } finally {
    devicesLoading.value = false;
    if (!disposed) timer = setTimeout(poll, 15000);
  }
}
const startingSession = ref(false);
async function newSession() {
  if (startingSession.value) return;
  const c = chat.state.snapshot?.conversation;
  if (!c) return;
  startingSession.value = true;
  try {
    if (!(await editorRegistry.leave())) return;
    if (
      !(await confirmDialog({
        title: "开始新的网页对话？",
        message: "聊天记录会保留。新对话不带入旧聊天和摘要，未完成任务会取消，角色卡保持不变。",
        confirmLabel: "开始新对话",
      }))
    )
      return;
    const result = await api<{ archived: boolean }>("/yesimbot/api/v1/conversations/archive", { channel: c.channel, session: c.session });
    if (result?.archived !== true) throw new Error("新对话未能确认，请重试。");
    await chat.load();
    toast("已开始新对话");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "danger");
  } finally {
    startingSession.value = false;
  }
}
onMounted(() => {
  fullPage.value = true;
  void poll();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  chat.dispose();
  fullPage.value = false;
});
</script>
<style scoped>
.web-home {
  display: flex;
  height: 100%;
  min-height: 0;
  min-width: 0;
  /* Never scrollable itself, even by scrollIntoView (see AppShell's chat layout). */
  overflow: clip;
}
.chat-main {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
/* Over the messages' corner, so it stays legible when a message scrolls beneath it. */
.panel-toggle {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 2;
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  backdrop-filter: blur(8px);
}
.chat-title {
  margin: 0 0 16px;
  padding-right: 48px;
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
  line-height: 28px;
}
</style>

<template>
  <div class="page grouped conversations">
    <aside class="directory" :class="selected ? 'hidden md:block' : ''" aria-label="会话列表">
      <ConversationList :selected="selected" :web="[]" :channels="index.data?.channels ?? []" :name="name" :loaded="!!index.data" management @select="select" />
    </aside>
    <ConversationThread v-if="channel" :key="selected" :channel="channel" :label="name(channel)" :back="mobile" embedded @back="select('')" />
    <SettingsGroup v-else-if="!mobile" :label="selected ? '会话暂不可用' : '未选择会话'" class="empty-pane">
      <div class="empty-body">
        <MessagesSquare class="text-muted-foreground" aria-hidden="true" />
        <h2 class="text-sm font-medium text-muted-foreground">{{ selected ? "会话暂不可用" : "未选择会话" }}</h2>
      </div>
    </SettingsGroup>
  </div>
</template>
<script setup lang="ts">
import { useMediaQuery } from "@vueuse/core";
import { isRetiredPlatform } from "@yesimbot/contracts/platforms";
import { Dialog as MessagesSquare } from "reicon-vue";
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import SettingsGroup from "../components/group/SettingsGroup.vue";
import ConversationList from "../components/talk/ConversationList.vue";
import ConversationThread from "../components/talk/ConversationThread.vue";
import { webHistoryTarget, parseWebHistoryTarget, webSessionView } from "../lib/talk";
import { useConversationNames } from "../lib/use-conversation-names";
import { useTopic } from "../lib/use-topic";
import type { ConversationIndex } from "../state/history-types";
const mobile = useMediaQuery("(max-width: 767px)");
const route = useRoute(),
  router = useRouter();
const index = useTopic<ConversationIndex>("conversations");
const name = useConversationNames();
const selected = computed(() => {
  const c = typeof route.query.c === "string" ? route.query.c : "";
  const channel = index.data?.channels.find((channel) => channel.key === c);
  if (channel?.platform === "web") {
    const session = typeof route.query.s === "string" ? route.query.s : channel.activeSession;
    return session ? webHistoryTarget(c, session) : c;
  }
  return c;
});
const channel = computed(() => {
  const target = parseWebHistoryTarget(selected.value);
  const entry = index.data?.channels.find((channel) => channel.key === (target?.channel ?? selected.value));
  return entry?.platform === "web" ? webSessionView(entry, target?.session) : entry;
});
let initialSelection = false;
watch(
  [() => index.data, mobile],
  ([data, small]) => {
    if (!data || initialSelection) return;
    initialSelection = true;
    if (small || selected.value) return;
    const recent = [...data.channels].filter((c) => !isRetiredPlatform(c.platform)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
    if (recent) select(recent.key);
  },
  { immediate: true },
);
function select(c: string) {
  const target = parseWebHistoryTarget(c);
  void router.replace({ path: "/conversations", query: { ...route.query, c: target?.channel ?? (c || undefined), s: target?.session } });
}
</script>
<style scoped>
@reference "../styles/app.css";

.conversations {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 48px;
  align-items: stretch;
  height: calc(100dvh - 180px);
  min-height: 24rem;
}
.directory {
  overflow-y: auto;
  overscroll-behavior: contain;
  min-width: 0;
  min-height: 0;
}
.empty-pane {
  align-content: stretch;
}
.empty-pane :deep(.group-body) {
  display: grid;
  min-height: 0;
  place-items: center;
}
.empty-body {
  display: grid;
  justify-items: center;
  gap: 12px;
}
@media (min-width: 768px) {
  .conversations {
    grid-template-columns: 300px minmax(0, 1fr);
  }
  .directory {
    margin: 0 -16px;
    padding: 0 16px;
  }
  .empty-pane,
  .empty-pane :deep(.group-body) {
    height: 100%;
  }
}
</style>

<template>
  <nav class="talk-list" aria-label="会话">
    <div class="list-head">
      <label class="search-field relative"
        ><Search class="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><span class="sr-only"
          >搜索会话</span
        ><Input
          v-model="query"
          class="h-10 rounded-[12px] border-transparent bg-group pl-10 shadow-none dark:bg-group"
          type="search"
          placeholder="搜索名称或号码"
      /></label>
      <Button
        v-if="!management"
        variant="ghost"
        size="icon-sm"
        type="button"
        title="新的网页对话"
        aria-label="新的网页对话"
        :disabled="creating"
        @click="emit('create')"
        >＋</Button
      >
    </div>
    <LoadingRows v-if="!loaded" :count="5" label="正在加载会话" class="p-1" />
    <SettingsGroup
      v-for="group in groups"
      :key="group.id"
      :title="group.label"
      :collapsible="group.id === ARCHIVE"
      :open="group.id === ARCHIVE ? archiveOpen : true"
      @update:open="archiveOpen = $event"
    >
      <GroupRow
        v-for="item in group.items"
        :key="item.value"
        :title="item.label"
        :value="item.typing || unread(item) ? undefined : item.lastActivityAt ? when(item.lastActivityAt) : undefined"
        :selected="item.value === selected"
        :chevron="false"
        clickable
        :aria-current="item.value === selected ? 'page' : undefined"
        @open="pick(item)"
      >
        <template #icon
          ><span class="list-avatar" aria-hidden="true">{{ item.avatar ?? item.label.slice(0, 1) }}</span></template
        >
        <template #title
          ><span v-if="item.typing" class="typing" role="img" aria-label="正在回复"><i></i><i></i><i></i></span
          ><span v-else-if="unread(item)" class="unread" role="img" aria-label="有新消息"></span
        ></template>
        <template #detail
          ><span class="block w-0 min-w-full truncate">{{ item.note }}</span></template
        >
        <Button
          v-if="removable(item)"
          variant="ghost"
          size="icon-sm"
          type="button"
          :aria-label="`从列表移除「${item.label}」`"
          title="从列表移除"
          @click="emit('remove', item.value.slice(WEB_PREFIX.length))"
        >
          <Icon name="close" />
        </Button>
      </GroupRow>
      <GroupRow v-if="!group.items.length" title="暂无" class="text-muted-foreground" />
    </SettingsGroup>
    <SettingsGroup v-if="query && !groups.some((group) => group.items.length)" label="搜索结果">
      <GroupRow title="没有匹配的会话" class="text-muted-foreground"
        ><Button variant="ghost" size="sm" class="rounded-full" type="button" @click="query = ''">清除搜索</Button></GroupRow
      >
    </SettingsGroup>
    <SettingsGroup v-else-if="!query && !groups.some((group) => group.items.length) && loaded" label="会话">
      <GroupRow title="暂无会话" class="text-muted-foreground" />
    </SettingsGroup>
  </nav>
</template>
<script setup lang="ts">
import { Search } from "reicon-vue";
import { computed, ref, watch } from "vue";

import type { ChatConversation } from "../../../../src/shared/chat";
import { formatTime } from "../../lib/format";
import { readSeen, talkGroups, WEB_PREFIX, writeSeen, type TalkItem, webHistoryGroups } from "../../lib/talk";
import Icon from "../../shell/Icon.vue";
import type { ConversationChannelSummary } from "../../state/history-types";
import GroupRow from "../group/GroupRow.vue";
import SettingsGroup from "../group/SettingsGroup.vue";
import LoadingRows from "../LoadingRows.vue";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Every conversation in one list, grouped by where it happens; the open one is marked, newer activity elsewhere gets a dot. */
const props = defineProps<{
  selected: string;
  web: readonly ChatConversation[];
  channels: readonly ConversationChannelSummary[];
  name: (channel: ConversationChannelSummary) => string;
  /** The chat index has been read at least once (an empty list then means there are none). */
  loaded: boolean;
  creating?: boolean;
  management?: boolean;
}>();
const emit = defineEmits<{ select: [value: string]; create: []; remove: [id: string] }>();
const query = ref("");
const groups = computed(() => {
  const groups = talkGroups({ web: props.web, channels: props.channels, name: props.name, query: query.value });
  if (!props.management) return groups;
  return [...webHistoryGroups(props.channels, props.name, query.value), ...groups.filter((group) => group.id !== "web")];
});

/** Archived web sessions stay folded until asked for, or until a search or the open conversation reaches into them. */
const ARCHIVE = "web-archive";
const archiveOpen = ref(false);
const searching = computed(() => !!query.value.trim());
const selectedArchived = computed(() => groups.value.some((group) => group.id === ARCHIVE && group.items.some((item) => item.value === props.selected)));
watch(
  [searching, selectedArchived],
  ([search, archived]) => {
    if (search || archived) archiveOpen.value = true;
  },
  { immediate: true },
);

// What was already there on the first visit counts as seen; later activity shows a dot until opened.
const seen = ref(readSeen());
watch(
  () => groups.value.flatMap((group) => group.items),
  (items) => {
    let changed = false;
    const next = { ...seen.value };
    for (const item of items) {
      if (next[item.value] === undefined || item.value === props.selected) {
        if (next[item.value] !== item.lastActivityAt) {
          next[item.value] = item.lastActivityAt;
          changed = true;
        }
      }
    }
    if (changed) {
      seen.value = next;
      writeSeen(next);
    }
  },
  { immediate: true },
);
/** Web conversations other than the 全局大脑 can leave the list; their history stays. */
const removable = (item: TalkItem) => !props.management && item.value.startsWith(WEB_PREFIX) && item.value !== WEB_PREFIX;
const unread = (item: TalkItem) => item.value !== props.selected && item.lastActivityAt > (seen.value[item.value] ?? Infinity);
function pick(item: TalkItem) {
  if (item.lastActivityAt > (seen.value[item.value] ?? 0)) {
    seen.value = { ...seen.value, [item.value]: item.lastActivityAt };
    writeSeen(seen.value);
  }
  emit("select", item.value);
}
/** Today: the clock; earlier: the date. */
function when(value: number) {
  const text = formatTime(value);
  return new Date(value).toDateString() === new Date().toDateString() ? text.slice(-5) : text.slice(0, 5);
}
</script>
<style scoped>
@reference "../../styles/app.css";

.talk-list {
  display: grid;
  align-content: start;
  gap: 20px;
}
.list-head {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
  background: var(--bg);
}
/* Not `.search`: layout.css draws its own icon for that class. */
.list-head .search-field {
  flex: 1;
  min-width: 0;
}
.list-avatar {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-2);
}
.unread {
  @apply rounded-full bg-primary;
  flex: none;
  width: 8px;
  height: 8px;
}
.typing {
  display: inline-flex;
  gap: 4px;
}
.typing i {
  @apply rounded-full bg-primary;
  width: 4px;
  height: 4px;
  animation: blink 1.2s infinite ease-in-out;
}
.typing i:nth-child(2) {
  animation-delay: 0.15s;
}
.typing i:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes blink {
  50% {
    opacity: 0.3;
  }
}
</style>

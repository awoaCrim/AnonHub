<template>
  <div class="system">
    <Alert v-if="error" variant="destructive" as="p" role="alert">{{ error }} <Button variant="outline" size="sm" @click="loadSystem">重试</Button></Alert>
    <SettingsGroup title="运行">
      <!-- The owner's own runtime (the one friends' bots run beside). -->
      <RuntimeStatus v-if="session.state.features.accounts" />
      <GroupRow
        title="运行环境"
        :detail="system ? `Node.js ${system.nodeVersion} · 已运行 ${formatUptime(system.uptime)}` : '正在读取环境信息…'"
        :icon="Server"
        clickable
        @open="envOpen = true"
      />
      <slot />
    </SettingsGroup>
    <SettingsGroup v-if="logs" title="实时日志" plain class="logs-group">
      <template #actions>
        <Segmented v-model="level" :options="levels" label="日志级别" />
        <label class="search"
          ><span class="sr-only">搜索日志</span
          ><Input v-model="q" type="search" placeholder="搜索日志" class="h-9 rounded-full border-transparent bg-group shadow-none dark:bg-group"
        /></label>
        <Button variant="outline" size="sm" class="rounded-full" type="button" @click="toggleFollow">
          {{ paused || !following ? (hasNew ? "回到最新 · 有新日志" : "回到最新") : "暂停滚动" }}
        </Button>
      </template>
      <Alert v-if="logs.state.stale" as="p">正在连接当前运行实例的日志…</Alert>
      <TopicFeedback v-else :state="logs.state" label="日志" />
      <div v-if="logs.state.data" ref="box" class="logs" @scroll="scrollLogs" tabindex="0" aria-label="日志列表">
        <p v-if="!rows.length" class="empty-state">暂无匹配日志</p>
        <div v-for="row in rows" :key="row.id" class="log-row" :class="row.level">
          <time>{{ formatTime(row.timestamp, "clock") }}</time
          ><span class="level">{{ levelLabel[row.level] }}</span
          ><strong class="truncate">{{ row.name }}</strong>
          <pre>{{ row.content }}</pre>
        </div>
      </div>
    </SettingsGroup>
    <Alert v-else as="p">日志仅管理员可查看。</Alert>
    <SettingsSubpage v-model:open="envOpen" title="运行环境" dialog-class="sm:max-w-xl">
      <SettingsGroup label="运行环境">
        <GroupRow v-for="item in env" :key="item.label" :title="item.label" :detail="system ? item.value : undefined" class="break-all">
          <Skeleton v-if="!system" class="h-5 w-40" />
        </GroupRow>
      </SettingsGroup>
    </SettingsSubpage>
  </div>
</template>
<script setup lang="ts">
import { Server } from "reicon-vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import type { LogsSnapshot, SystemSnapshot } from "../../../src/shared/webui";
import GroupRow from "../components/group/GroupRow.vue";
import Segmented from "../components/group/Segmented.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import RuntimeStatus from "../components/RuntimeStatus.vue";
import SettingsSubpage from "../components/SettingsSubpage.vue";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { useLive, useSession } from "../context";
import { api } from "../lib/api";
import { onCacheRefresh } from "../lib/cache";
import { formatTime } from "../lib/format";
import { useRouteState } from "../lib/route-state";
import TopicFeedback from "../shell/TopicFeedback.vue";
import { formatUptime } from "./overview-model";
const session = useSession(),
  live = useLive();
const logs = session.state.role === "owner" ? live.use<LogsSnapshot>("logs") : undefined;
onUnmounted(() => logs?.release());
const system = ref<SystemSnapshot>(),
  envOpen = ref(false),
  error = ref(""),
  paused = ref(false),
  following = ref(true),
  hasNew = ref(false),
  box = ref<HTMLElement>();
const level = useRouteState("level", ""),
  q = useRouteState("q", "");
const rows = computed(() =>
  (logs?.state.stale ? [] : (logs?.state.data?.entries ?? [])).filter(
    (v) => (!level.value || v.level === level.value) && (!q.value || `${v.name} ${v.content}`.toLowerCase().includes(q.value.toLowerCase())),
  ),
);
const env = computed(() =>
  system.value
    ? [
        { label: "监听地址", value: `${system.value.host}:${system.value.port ?? "未配置"}` },
        { label: "工作目录", value: system.value.baseDir },
        { label: "Node.js", value: system.value.nodeVersion },
        { label: "运行时长", value: formatUptime(system.value.uptime) },
      ]
    : ["监听地址", "工作目录", "Node.js", "运行时长"].map((label) => ({ label, value: "" })),
);
const levels = [
  { value: "", label: "全部" },
  { value: "error", label: "错误" },
  { value: "warn", label: "警告" },
  { value: "info", label: "信息" },
  { value: "debug", label: "调试" },
];
const levelLabel = {
  success: "成功",
  error: "错误",
  info: "信息",
  warn: "警告",
  debug: "调试",
};
async function loadSystem() {
  try {
    system.value = await api<SystemSnapshot>("/yesimbot/api/v1/system");
    error.value = "";
  } catch {
    error.value = "无法读取系统信息，请稍后重试。";
  }
}
onMounted(loadSystem);
onUnmounted(onCacheRefresh((path) => path === "/yesimbot/api/v1/system" && void loadSystem()));
watch(
  () => rows.value.at(-1)?.id,
  async () => {
    if (paused.value || !following.value) {
      hasNew.value = true;
      return;
    }
    await nextTick();
    if (box.value) box.value.scrollTop = box.value.scrollHeight;
  },
);
function scrollLogs() {
  const element = box.value;
  if (!element) return;
  following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  if (following.value) hasNew.value = false;
}
async function toggleFollow() {
  if (!paused.value && following.value) {
    paused.value = true;
    return;
  }
  paused.value = false;
  following.value = true;
  hasNew.value = false;
  await nextTick();
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
}
</script>
<style scoped>
@reference "../styles/app.css";

.system {
  display: grid;
  gap: 28px;
  min-width: 0;
}
.logs-group :deep(.group-body.plain) {
  padding: 8px 0;
}
.logs-group :deep(.topic-feedback),
.logs-group [data-slot="alert"] {
  margin: 8px 12px;
}
.search {
  flex: 0 1 180px;
  min-width: 120px;
}
.logs {
  @apply text-foreground font-mono text-xs;
  height: max(360px, calc(100dvh - 380px));
  overflow: auto;
  line-height: 1.6;
  padding: 8px 0;
}
.logs .empty-state {
  @apply text-muted-foreground;
  padding: 8px 20px;
}
.log-row {
  display: grid;
  grid-template-columns: 72px 40px 120px minmax(0, 1fr);
  gap: 12px;
  padding: 4px 20px;
}
.log-row:hover {
  background: var(--group-hover);
}
.log-row time {
  @apply text-muted-foreground;
}
.log-row strong {
  @apply font-medium;
  @apply text-primary;
}
.log-row pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
}
.level {
  @apply text-muted-foreground;
}
.log-row.error .level,
.log-row.error pre {
  @apply text-destructive;
}
.log-row.warn .level,
.log-row.warn pre {
  @apply text-warn;
}
.log-row.success .level {
  @apply text-ok;
}
.log-row.debug {
  opacity: 0.7;
}
@media (max-width: 640px) {
  .log-row {
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 0 12px;
    padding: 4px 12px;
  }
  .level {
    display: none;
  }
  .log-row pre {
    grid-column: 1 / -1;
  }
  .search {
    flex: 1 1 100%;
  }
}
</style>

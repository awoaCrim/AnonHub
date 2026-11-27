<template>
  <GroupRow v-if="available !== false" :title="runtime?.name || '机器人运行状态'" :icon="Bot" :aria-busy="loading || busy">
    <template #detail>
      <span v-if="runtime" class="inline-flex flex-wrap items-center gap-x-2"
        ><Badge :variant="badgeTone(runtime.state === 'running' ? 'ok' : runtime.state === 'error' ? 'danger' : 'warn')" as="span">
          {{ labels[runtime.state] }} </Badge
        >{{ runtime.location === "local" ? "在电脑上运行" : "在服务器上运行" }}</span
      >
      <span v-else role="status">{{ error ? "暂时无法获取状态" : "正在读取运行状态…" }}</span>
    </template>
    <Button variant="ghost" size="icon-sm" class="intent-target rounded-full" type="button" aria-label="刷新状态" :disabled="busy || loading" @click="load"
      ><RefreshCw class="size-4" :class="{ 'animate-spin': loading }"
    /></Button>
    <Button
      v-if="runtime"
      variant="outline"
      size="sm"
      class="rounded-full"
      type="button"
      :disabled="busy || transitioning || !!error"
      @click="action(runtime.state === 'running' ? 'stop' : 'start')"
    >
      {{ busy ? "正在处理…" : transitioning ? labels[runtime.state] : runtime.state === "running" ? "暂停机器人" : "启动机器人" }}
    </Button>
    <template v-if="error" #below
      ><p class="text-sm text-destructive" role="alert">{{ error }}</p></template
    >
  </GroupRow>
</template>
<script setup lang="ts">
import { Ghost as Bot, Refresh as RefreshCw } from "reicon-vue";
import { computed, onMounted, onUnmounted, ref } from "vue";

import type { RuntimeView } from "../../../src/shared/accounts";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import GroupRow from "./group/GroupRow.vue";
import { Badge, badgeTone } from "./ui/badge";
import { Button } from "./ui/button";
const runtime = ref<RuntimeView>(),
  available = ref<boolean>(),
  loading = ref(false),
  busy = ref(false),
  error = ref("");
const transitioning = computed(() => runtime.value?.state === "starting" || runtime.value?.state === "stopping");
let timer: ReturnType<typeof setInterval> | undefined,
  generation = 0,
  disposed = false;
const labels: Record<string, string> = {
  "setup-required": "待配置",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已暂停",
  error: "连接异常",
};
async function load() {
  if (disposed || loading.value) return;
  const token = ++generation;
  loading.value = true;
  try {
    const result = await api<{ available: boolean; runtime?: RuntimeView }>("/yesimbot/admin/runtime", undefined, { fresh: true });
    if (disposed || token !== generation) return;
    available.value = result.available;
    runtime.value = result.runtime;
    error.value = "";
  } catch {
    if (!disposed && token === generation) error.value = "无法读取运行状态，请确认电脑和网络连接后刷新。";
  } finally {
    if (!disposed && token === generation) loading.value = false;
  }
}
async function action(value: "start" | "stop") {
  if (busy.value || transitioning.value || disposed) return;
  busy.value = true;
  try {
    await api("/yesimbot/admin/runtime", { action: value });
    if (!disposed) await load();
  } catch {
    if (!disposed) toast("操作未完成，请检查电脑是否在线后重试。", "danger");
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(async () => {
  await load();
  if (!disposed && available.value !== false)
    timer = setInterval(() => {
      if (!busy.value) void load();
    }, 10000);
});
onUnmounted(() => {
  disposed = true;
  generation++;
  clearInterval(timer);
});
</script>

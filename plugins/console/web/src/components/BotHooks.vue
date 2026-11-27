<template>
  <div class="grid min-w-0 gap-6">
    <Alert v-if="error" variant="destructive" as="p" role="alert"
      >{{ error }} <Button variant="outline" size="sm" :disabled="busy || loading" @click="load">刷新状态</Button></Alert
    >
    <p v-if="loading" class="muted text-sm" role="status">正在读取通知链接…</p>
    <SettingsGroup v-if="!loading && !shown.length" label="通知链接">
      <GroupRow title="账号" value="未接入" tone="idle" :icon="Webhook" />
    </SettingsGroup>
    <SettingsGroup v-for="bot in shown" :key="bot.selfId" :title="bot.selfId">
      <GroupRow title="连接" :value="bot.online ? '在线' : '未连接'" :tone="bot.online ? 'ok' : 'warn'" :icon="Link2" />
      <template v-if="bot.path">
        <GroupRow title="接收通知" :icon="Bell">
          <Switch
            :aria-label="`${bot.selfId}接收通知`"
            :model-value="!!bot.enabled"
            :disabled="busy"
            @update:model-value="change(bot, bot.enabled ? 'disable' : 'enable')"
          />
        </GroupRow>
        <GroupRow title="Hook 链接" :icon="Webhook">
          <Button variant="outline" size="sm" :disabled="busy" @click="copy(bot.path)">复制链接</Button>
          <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" :disabled="busy" @click="rotate(bot)">重置链接</Button>
          <template #below
            ><Input
              :class="FIELD"
              readonly
              :aria-label="`${bot.selfId}的 Hook 链接`"
              :value="url(bot.path)"
              @focus="($event.target as HTMLInputElement).select()"
          /></template>
        </GroupRow>
      </template>
      <GroupRow v-else title="Hook 链接" :icon="Webhook">
        <Button variant="default" size="sm" :disabled="busy" @click="change(bot, 'create')">生成链接</Button>
      </GroupRow>
    </SettingsGroup>
    <SettingsGroup label="调用方式">
      <GroupRow title="调用方式" :icon="BookOpen" clickable @open="helpOpen = true" />
    </SettingsGroup>
    <SettingsSubpage v-model:open="helpOpen" title="调用方式" dialog-class="sm:max-w-xl">
      <SettingsGroup label="请求">
        <div class="grid gap-2 p-3 text-sm">
          <p>POST · application/json</p>
          <pre class="overflow-x-auto">{ "event_id": "build-123", "content": "构建已完成。" }</pre>
        </div>
      </SettingsGroup>
    </SettingsSubpage>
  </div>
</template>
<script setup lang="ts">
import { BookOpen, Bell, Link as Link2, Link as Webhook } from "reicon-vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { api } from "../lib/api";
import { confirmDialog } from "../lib/dialog";
import { trackEditor } from "../lib/editor-guard";
import { toast } from "../lib/toast";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import SettingsSubpage from "./SettingsSubpage.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
const FIELD = "rounded-[10px] border-transparent bg-group-tile font-mono text-xs shadow-none dark:bg-group-tile";
type Bot = { platform: string; selfId: string; online: boolean; enabled?: boolean; path?: string };
const props = defineProps<{ platform: string }>();
const emit = defineEmits<{ busy: [boolean] }>();
const bots = ref<Bot[]>([]),
  busy = ref(false),
  loading = ref(true),
  error = ref(""),
  helpOpen = ref(false);
trackEditor(
  () => false,
  () => busy.value,
);
watch(busy, (value) => emit("busy", value), { flush: "sync" });
onBeforeUnmount(() => emit("busy", false));
const shown = computed(() => bots.value.filter((bot) => bot.platform === props.platform));
const url = (path: string) => new URL(path, location.origin).href;
async function load() {
  loading.value = true;
  try {
    bots.value = (await api<{ bots: Bot[] }>("/yesimbot/api/v1/bot-hooks", undefined, { fresh: true })).bots;
    error.value = "";
  } catch {
    error.value = "无法读取通知链接，请重试。";
  } finally {
    loading.value = false;
  }
}
async function change(bot: Bot, action: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    bots.value = (await api<{ bots: Bot[] }>("/yesimbot/api/v1/bot-hooks", { platform: bot.platform, selfId: bot.selfId, action })).bots;
    error.value = "";
  } catch {
    error.value = "通知链接更新失败，请重试。";
  } finally {
    busy.value = false;
  }
}
async function rotate(bot: Bot) {
  if (
    busy.value ||
    !(await confirmDialog({ title: "重置通知链接？", message: "重置后旧链接立即失效，需要在外部服务中换成新链接。", confirmLabel: "重置链接", danger: true }))
  )
    return;
  await change(bot, "rotate");
}
async function copy(path: string) {
  try {
    await navigator.clipboard.writeText(url(path));
    toast("链接已复制");
  } catch {
    error.value = "复制失败，请手动复制链接。";
  }
}
watch(() => props.platform, load, { immediate: true });
</script>
<style scoped>
@reference "../styles/app.css";

pre {
  @apply rounded-xl bg-group p-3 text-sm;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

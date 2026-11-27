<template>
  <div v-if="entry" class="plugin-settings">
    <SettingsGroup v-if="head" :label="`${label}状态`">
      <GroupRow title="启用" :icon="Power">
        <Switch :aria-label="`启用${label}`" :model-value="entry.enabled" :disabled="toggling || !writable" @update:model-value="toggle" />
      </GroupRow>
      <GroupRow v-if="status" title="状态" :value="status" tone="danger" :to="logs" />
    </SettingsGroup>
    <Alert v-if="error" variant="destructive" as="p" role="alert">
      {{ error }} <Button variant="outline" size="sm" type="button" @click="load">重试读取</Button>
    </Alert>
    <SettingsGroup v-else-if="!snapshot" :label="label" aria-busy="true">
      <div class="grid gap-2 p-2"><Skeleton v-for="n in 3" :key="n" class="h-10" /></div>
    </SettingsGroup>
    <PluginFields v-else :key="entry.name" :path="entry.path" :name="entry.name" :label="label" :snapshot="snapshot" :writable="writable" />
  </div>
</template>
<script setup lang="ts">
import { Power } from "reicon-vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import type { PluginSchemaSnapshot, PluginsSnapshot } from "../../../src/shared/plugin-config";
import { useSession } from "../context";
import { api } from "../lib/api";
import { setFeatureEnabled } from "../lib/features";
import { flattenPlugins, pluginError, pluginIdentity, pluginName } from "../lib/plugin-config";
import { toast } from "../lib/toast";
import { useTopic } from "../lib/use-topic";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import PluginFields from "./PluginFields.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";

/**
 * One plugin instance's settings as rows that save on change (user, 2026-11-25: 全部改成即改即存). `head` adds its
 * switch and what keeps it from running, for pages without a row of their own for it (a custom chat platform).
 */
const props = defineProps<{ path: string; head?: boolean }>();

const plugins = useTopic<PluginsSnapshot>("plugins");

const session = useSession();

const entry = computed(() =>
  flattenPlugins(plugins.data?.tree ?? []).find((item) => !item.group && !!props.path && pluginIdentity(item.path) === pluginIdentity(props.path)),
);

const label = computed(() => (entry.value ? pluginName(entry.value) : ""));

const writable = computed(() => !!plugins.data?.writable && !entry.value?.locked);

const status = computed(() => (entry.value?.status === "failed" ? "启动失败" : entry.value?.needsConfig ? "需要设置" : ""));

const logs = computed(() => (entry.value?.status === "failed" && session.state.role === "owner" ? "/settings/system?tab=server" : undefined));

const snapshot = ref<PluginSchemaSnapshot>();

const error = ref("");

let disposed = false,
  generation = 0;
onBeforeUnmount(() => (disposed = true));

const toggling = ref(false);

async function load() {
  const name = entry.value?.name;
  if (!name) return;
  const token = ++generation;
  error.value = "";
  snapshot.value = undefined;
  try {
    const result = await api<PluginSchemaSnapshot>(`/yesimbot/api/v1/plugins/schema?name=${encodeURIComponent(name)}`);
    if (!disposed && token === generation) snapshot.value = result;
  } catch (cause) {
    if (!disposed && token === generation) error.value = pluginError(cause);
  }
}
watch(() => entry.value?.name, load, { immediate: true });

async function toggle(enabled: boolean, undo = false) {
  const current = entry.value;
  if (!current || toggling.value || !writable.value || current.enabled === enabled) return;
  toggling.value = true;
  try {
    await setFeatureEnabled(plugins.data?.revision, current, enabled);
    if (!disposed)
      toast(`「${label.value}」已${enabled ? "开启" : "关闭"}`, "ok", undefined, undo ? undefined : { label: "撤销", run: () => void toggle(!enabled, true) });
  } catch (cause) {
    if (!disposed) toast(pluginError(cause), "danger");
  } finally {
    if (!disposed) toggling.value = false;
  }
}
</script>
<style scoped>
.plugin-settings {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 28px;
  min-width: 0;
}
</style>

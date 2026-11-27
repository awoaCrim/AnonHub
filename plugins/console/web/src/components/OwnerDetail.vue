<template>
  <div class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7" aria-label="我的 bot">
    <SettingsGroup label="我的 bot">
      <GroupRow title="我的 bot" :value="status.label" :tone="status.tone || 'idle'" :icon="Bot" />
    </SettingsGroup>
    <SettingsGroup v-if="status.problems.length > 1" title="需要处理" tone="danger">
      <GroupRow
        v-for="problem in status.problems"
        :key="problem.label"
        :title="problem.label"
        :icon="TriangleAlert"
        :icon-tone="problem.tone === 'danger' ? 'danger' : 'warn'"
      />
    </SettingsGroup>
    <SettingsGroup v-if="stats.length" title="概况">
      <GroupRow v-for="stat in stats" :key="stat.label" :title="stat.label" :value="stat.value" />
    </SettingsGroup>
    <InstanceOps :ops="ops" base="napcat" :restart="restart" :quiet-qq="restarting" own />
  </div>
</template>

<script setup lang="ts">
import { Ghost as Bot, Danger as TriangleAlert } from "reicon-vue";
import { computed } from "vue";

import type { BotSummary, OpsInstance, OpsProgramName } from "../../../src/shared/accounts";
import { formatUptime } from "../pages/overview-model";
import { ownerStatus, relativeTime } from "../state/accounts-health";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import InstanceOps from "./InstanceOps.vue";

/** The owner's own instance: how it is doing, and the same restart and QQ tools a friend's has. */
const props = defineProps<{
  health?: BotSummary | null;
  ops?: OpsInstance;
  restart: (program: OpsProgramName) => Promise<void>;
  /** This bot is restarting itself; nothing it serves can be read until it is back. */
  restarting?: boolean;
}>();
const status = computed(() => ownerStatus(props.health, props.ops));
const stats = computed(() => {
  const value = props.health;
  if (!value) return [];
  return [
    { label: "今天回复", value: value.todayCalls == null ? "—" : `${value.todayCalls} 次` },
    { label: "最近聊天", value: relativeTime(value.lastActivityAt) },
    { label: "聊过的群和私聊", value: value.conversations == null ? "—" : `${value.conversations} 个` },
    { label: "已运行", value: value.uptimeSeconds == null ? "—" : formatUptime(value.uptimeSeconds) },
  ];
});
</script>

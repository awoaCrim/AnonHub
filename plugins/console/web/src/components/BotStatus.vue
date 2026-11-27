<template>
  <div class="bot-status">
    <SettingsGroup label="机器人状态">
      <div class="status-head">
        <div class="min-w-0">
          <h2 :class="{ 'text-destructive': health.tone === 'danger' }">{{ health.title }}</h2>
          <p v-if="owner">已运行 {{ formatUptime(panel.health.uptimeSeconds) }} · 更新于 {{ time(panel.generatedAt) }}</p>
          <p v-else>更新于 {{ time(panel.generatedAt) }}</p>
        </div>
      </div>
    </SettingsGroup>
    <!-- Problems are rows like any other, never a separate alarm card. -->
    <SettingsGroup title="概况">
      <GroupRow
        v-for="item in allRows"
        :key="item.id"
        :title="item.label"
        :detail="item.detail"
        :value="item.value"
        :tone="(item.tone || 'idle') as RowTone"
        :icon="ROW_ICONS[item.id] ?? Activity"
        :to="item.to"
      />
    </SettingsGroup>
    <SettingsGroup v-if="issues.length || failures.length" title="最近的提醒">
      <GroupRow
        v-for="(issue, index) in issues"
        :key="`issue-${index}`"
        :title="issue.message"
        :icon="TriangleAlert"
        :icon-tone="issue.level === 'error' ? 'danger' : 'warn'"
      />
      <GroupRow
        v-for="item in failures"
        :key="item.timestamp + item.channel"
        :title="item.message"
        :detail="`${time(item.timestamp)} · 发送失败 · ${item.channel}`"
        :icon="MessageSquareX"
        icon-tone="danger"
      />
    </SettingsGroup>
    <SettingsGroup v-if="owner" title="资源">
      <GroupRow v-for="item in memory" :key="item.label" :title="item.label" :value="formatMemoryRatio(item.ratio)">
        <template #below><Progress :model-value="item.percent" class="meter" :class="{ high: item.percent >= 85 }" /></template>
      </GroupRow>
    </SettingsGroup>
  </div>
</template>
<script setup lang="ts">
import type { DeviceView } from "@yesimbot/contracts";
import {
  Pulse as Activity,
  Widget as Blocks,
  ChatRound as MessageCircle,
  MessageRemove as MessageSquareX,
  Monitor,
  Stars as Sparkles,
  Danger as TriangleAlert,
  Users,
} from "reicon-vue";
import { computed, onMounted, ref, type Component } from "vue";

import type { AccountsHealthResponse, AccountsResponse } from "../../../src/shared/accounts";
import type { PanelPayload } from "../../../src/shared/panel";
import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import { useSession } from "../context";
import { adminRequest } from "../lib/admin-request";
import { isComputerDevice, loadDevices } from "../lib/devices";
import { featureLink } from "../lib/features";
import { formatTime } from "../lib/format";
import { flattenPlugins, pluginName } from "../lib/plugin-config";
import { useTopic } from "../lib/use-topic";
import { pages } from "../nav";
import { botHealth, formatMemoryRatio, formatUptime, statusRows } from "../pages/overview-model";
import { accountIssues } from "../state/accounts-health";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import { Progress } from "./ui/progress";

/** How the bot is doing: platforms, reply model, computer, and anything that needs attention. */
const props = defineProps<{ panel: PanelPayload }>();
const session = useSession();
const owner = computed(() => session.state.role !== "member");
/** The headline follows the worst line under it, so it never says 运行正常 above a warning. */
const health = computed(() => {
  const base = botHealth(props.panel);
  if (base.tone === "danger" || base.tone === "idle") return base;
  const flagged = allRows.value.filter((row) => row.tone === "warn" || row.tone === "danger");
  const count = flagged.length + props.panel.attention.length;
  if (!count) return base;
  return { tone: flagged.some((row) => row.tone === "danger") ? "danger" : "warn", title: `运行中 · ${count} 项需要注意` };
});
const issues = computed(() => props.panel.attention ?? []);
/** Features that failed to start or still need settings; each links to where it is set up. */
const plugins = useTopic<PluginsSnapshot>("plugins");
const featureIssues = computed(() =>
  flattenPlugins(plugins.data?.tree ?? []).filter((entry) => !entry.group && (entry.needsConfig || entry.status === "failed")),
);
// Members have no delivery-failure log.
const failures = computed(() => (owner.value ? (props.panel.recent ?? []).slice(0, 5) : []));
// The computer line appears once the device list is known; a failed read leaves it out quietly.
const computers = ref<DeviceView[]>();
const rows = computed(() => statusRows(props.panel, session.state.features, computers.value));
// Owners with friends see how their bots are doing; read once per visit.
const friends = ref<{ total: number; attention: { name: string; issue: string }[] }>();
onMounted(() => {
  void loadDevices()
    .then((list) => {
      if (list?.available && Array.isArray(list.devices)) computers.value = list.devices.filter(isComputerDevice);
    })
    .catch(() => {});
  if (session.state.role !== "owner" || !session.state.features.accounts) return;
  void Promise.all([adminRequest<AccountsResponse>("admin/accounts"), adminRequest<AccountsHealthResponse>("admin/accounts/health")])
    .then(([list, checks]) => {
      const byId = new Map(checks.accounts.map((row) => [row.id, row]));
      const attention = list.accounts.flatMap((account) => {
        const first = accountIssues(account, byId.get(account.id))[0];
        return first ? [{ name: account.username, issue: first.label }] : [];
      });
      friends.value = { total: list.accounts.length, attention };
    })
    .catch(() => {});
});
type Row = { id: string; label: string; value: string; detail: string; tone: string; to?: string | { path: string; query?: Record<string, string> } };
/** Platforms, model and computer, then features and friends when they need a look. */
const allRows = computed<Row[]>(() => {
  const list: Row[] = [...rows.value];
  const features = featureIssues.value;
  if (features.length) {
    const first = features[0]!;
    const failed = features.some((entry) => entry.status === "failed");
    list.push({
      id: "features",
      label: "功能",
      value: features.length === 1 ? `${pluginName(first)}${first.status === "failed" ? "没能启动" : "还需要设置"}` : `${features.length} 项功能需要看一下`,
      detail: features.length === 1 ? "" : features.map((entry) => pluginName(entry)).join("、"),
      tone: failed ? "danger" : "warn",
      to: featureLink(first.name),
    });
  }
  const group = friends.value;
  if (group?.total) {
    const attention = group.attention;
    list.push({
      id: "friends",
      label: "好友",
      value: attention.length ? `${attention.length} 位好友的 bot 有问题` : `${group.total} 位好友的 bot 都正常`,
      detail: attention
        .slice(0, 3)
        .map((item) => `${item.name}：${item.issue}`)
        .join("；"),
      tone: attention.length ? "warn" : "ok",
      to: pages.friends.path,
    });
  }
  return list;
});
const time = (value: string | number) => formatTime(value);
type RowTone = "ok" | "warn" | "danger" | "idle";
const ROW_ICONS: Record<string, Component> = { platforms: MessageCircle, model: Sparkles, computer: Monitor, features: Blocks, friends: Users };
/** Memory as bars (user, 2026-11-22, showing Muse's usage bars as the better design). */
const memory = computed(() =>
  [
    { label: "进程内存", ratio: props.panel.health.memory?.app },
    { label: "系统内存", ratio: props.panel.health.memory?.total },
  ].map((item) => ({ ...item, percent: typeof item.ratio === "number" && Number.isFinite(item.ratio) ? Math.min(100, Math.max(0, item.ratio * 100)) : 0 })),
);
</script>
<style scoped>
@reference "../styles/app.css";

.bot-status {
  display: grid;
  gap: 40px;
  min-width: 0;
}
.status-head {
  padding: 0 16px;
}
.status-head h2 {
  font-size: 18px;
  font-weight: 600;
}
.status-head p {
  @apply text-muted-foreground;
  margin-top: 4px;
  font-size: 14px;
}
.meter {
  height: 8px;
  background: var(--surface-3);
}
</style>

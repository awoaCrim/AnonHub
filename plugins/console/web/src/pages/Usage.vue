<template>
  <div class="usage">
    <SettingsGroup v-if="isAdmin" title="按用户">
      <template #actions
        ><Button variant="ghost" size="sm" class="rounded-full" :disabled="loadingAccounts" @click="loadAccounts">{{
          loadingAccounts ? "刷新中…" : "刷新"
        }}</Button></template
      >
      <Alert v-if="accountsError" variant="destructive" class="m-2 w-auto">用户用量暂时无法读取，请重试。</Alert>
      <GroupRow
        v-for="account in accountRows"
        :key="account.id"
        :title="`${account.username}${account.id === 'self' ? '（自己）' : ''}`"
        :detail="account.usage ? todayLine(account.usage.today) : '暂不可用'"
        :selected="selectedUser === account.id"
        :chevron="false"
        clickable
        @open="selectedUser = account.id"
      >
        <template #icon
          ><span class="initial">{{ account.username.slice(0, 1).toUpperCase() }}</span></template
        >
        <Check v-if="selectedUser === account.id" class="size-4 text-brand-text" aria-hidden="true" />
      </GroupRow>
    </SettingsGroup>
    <Alert v-if="selectedUser !== 'self' && !usage.data">该用户的用量暂不可用，可能是实例未启动或未开启统计。</Alert>
    <TopicFeedback v-if="selectedUser === 'self'" :state="usage" label="用量统计" />
    <Alert v-if="selectedUser === 'self' && usage.unavailable" as="p" class="enable">
      <span>开启用量统计后，这里会显示每天的模型调用和 Token 用量。</span>
      <Button v-if="usageEntry && plugins.data?.writable" variant="outline" size="sm" :disabled="enabling" @click="enableUsage">{{
        enabling ? "开启中…" : "开启"
      }}</Button>
    </Alert>
    <template v-if="usage.data && !usage.unavailable">
      <SettingsGroup :title="`${selectedName}的用量 · 今日`">
        <div class="kpis">
          <div v-for="item in today" :key="item.label" class="kpi">
            <span class="kpi-label">{{ item.label }}</span>
            <strong class="kpi-value">{{ item.value }}</strong>
          </div>
        </div>
        <GroupRow title="当前速率（Token）" :value="`↑${compact(usage.data.rate.inputPerMinute)} ↓${compact(usage.data.rate.outputPerMinute)} / 分钟`" />
      </SettingsGroup>
      <SettingsGroup :title="range === 'today' ? '今日每小时' : `最近 ${usage.data.recent.length} 天`" plain>
        <template #actions>
          <Segmented v-model="range" :options="ranges" label="时间范围" />
          <Segmented v-model="metric" :options="metrics" label="指标" />
        </template>
        <BarChart
          :label="chartLabel"
          :labels="series.labels"
          :series="metric === 'input' ? ['缓存命中', '缓存未命中'] : ['输出']"
          :values="metric === 'input' ? series.input : series.output"
          :format="compact"
        />
      </SettingsGroup>
      <SettingsGroup :title="`按模型 · 最近 ${usage.data.recent.length} 天`">
        <GroupRow
          v-for="row in rows"
          :key="row.model + row.kind"
          :title="modelName(row.model).name"
          :detail="[modelName(row.model).provider, row.kind === 'chat' ? '对话' : '向量'].filter(Boolean).join(' · ')"
          :value="`${row.counts.calls.toLocaleString()} 次`"
          :icon="row.kind === 'chat' ? MessageSquare : Binary"
        >
          <template #below>
            <Progress :model-value="share(row)" class="share" :aria-label="`${modelName(row.model).name} 的输入占比`" />
            <p class="share-line">
              <span>输入 {{ compact(row.counts.inputTokens) }}</span
              ><span>输出 {{ compact(row.counts.outputTokens) }}</span
              ><span>缓存命中 {{ row.hit }}</span>
            </p>
          </template>
        </GroupRow>
        <GroupRow v-if="!rows.length" title="还没有记录" class="text-muted-foreground" />
      </SettingsGroup>
    </template>
  </div>
</template>
<script setup lang="ts">
import type { TokenCounts } from "@yesimbot/contracts";
import type { UsagePayload } from "@yesimbot/contracts";
import { Code as Binary, Check, Message as MessageSquare } from "reicon-vue";
import { computed, ref, onMounted, onUnmounted } from "vue";

import type { AccountsUsageResponse } from "../../../src/shared/accounts-usage";
import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import GroupRow from "../components/group/GroupRow.vue";
import Segmented from "../components/group/Segmented.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { useSession } from "../context";
import { api } from "../lib/api";
import { setFeatureEnabled } from "../lib/features";
import { flattenPlugins, pluginError } from "../lib/plugin-config";
import { useRouteState } from "../lib/route-state";
import { toast } from "../lib/toast";
import { useTopic } from "../lib/use-topic";
import BarChart from "../shell/BarChart.vue";
import TopicFeedback from "../shell/TopicFeedback.vue";
import { cacheHitRate, compact, dailySeries, hourlySeries, modelRows } from "./usage-model";

const session = useSession();
const isAdmin = computed(() => session.state.role === "owner" && session.state.features.accounts);
const ownUsage = useTopic<UsagePayload>("usage");
const accounts = ref<AccountsUsageResponse["accounts"]>([]);
const loadingAccounts = ref(false),
  accountsError = ref(false);
const selectedUser = ref("self");
const accountRows = computed(() => [{ id: "self", username: session.state.username, usage: ownUsage.data ?? null }, ...accounts.value]);
const selectedName = computed(() => accountRows.value.find((row) => row.id === selectedUser.value)?.username ?? session.state.username);
const usage = {
  get data() {
    return selectedUser.value === "self" ? ownUsage.data : (accounts.value.find((row) => row.id === selectedUser.value)?.usage ?? undefined);
  },
  get unavailable() {
    return selectedUser.value === "self" && ownUsage.unavailable;
  },
  get stale() {
    return selectedUser.value === "self" && ownUsage.stale;
  },
  get cached() {
    return selectedUser.value === "self" && ownUsage.cached;
  },
  get failed() {
    return selectedUser.value === "self" && ownUsage.failed;
  },
  get revision() {
    return ownUsage.revision;
  },
};
let disposed = false;
async function loadAccounts() {
  if (!isAdmin.value || loadingAccounts.value) return;
  loadingAccounts.value = true;
  try {
    const result = await api<AccountsUsageResponse>("/yesimbot/admin/accounts/usage", undefined, { fresh: true });
    if (disposed) return;
    accounts.value = result.accounts;
    if (selectedUser.value !== "self" && !result.accounts.some((row) => row.id === selectedUser.value)) selectedUser.value = "self";
    accountsError.value = false;
  } catch {
    if (!disposed) accountsError.value = true;
  } finally {
    loadingAccounts.value = false;
  }
}
onMounted(loadAccounts);
onUnmounted(() => {
  disposed = true;
});
const plugins = useTopic<PluginsSnapshot>("plugins");
const usageEntry = computed(() => flattenPlugins(plugins.data?.tree ?? []).find((item) => !item.group && item.name === "yesimbot-usage"));
const enabling = ref(false);
async function enableUsage() {
  if (!usageEntry.value || enabling.value) return;
  enabling.value = true;
  try {
    await setFeatureEnabled(plugins.data?.revision, usageEntry.value, true);
    toast("已开启用量统计。");
  } catch (error) {
    toast(pluginError(error), "danger");
  } finally {
    enabling.value = false;
  }
}
const range = useRouteState<"recent" | "today">("range", "recent");
const metric = useRouteState<"input" | "output">("metric", "input");
const ranges = [
  { value: "recent", label: "按天" },
  { value: "today", label: "今日" },
] as const;
const metrics = [
  { value: "input", label: "输入" },
  { value: "output", label: "输出" },
] as const;
const series = computed(() =>
  usage.data ? (range.value === "today" ? hourlySeries(usage.data) : dailySeries(usage.data)) : { labels: [], input: [], output: [] },
);
const rows = computed(() => (usage.data ? modelRows(usage.data) : []));
const todayLine = (counts: TokenCounts) =>
  `今日 ${counts.calls.toLocaleString()} 次 · 输入 ${compact(counts.inputTokens)} · 输出 ${compact(counts.outputTokens)} · 缓存命中 ${cacheHitRate(counts)}`;
const today = computed(() => {
  const counts = usage.data?.today;
  if (!counts) return [];
  return [
    { label: "调用", value: counts.calls.toLocaleString() },
    { label: "输入 Token", value: compact(counts.inputTokens) },
    { label: "输出 Token", value: compact(counts.outputTokens) },
    { label: "缓存命中率", value: cacheHitRate(counts) },
  ];
});
/** `provider:model` → the model, with its provider under it. */
const modelName = (id: string) => {
  const at = id.indexOf(":");
  return at > 0 ? { provider: id.slice(0, at), name: id.slice(at + 1) } : { provider: "", name: id };
};
/** Each model's input as a share of the busiest model's. */
const share = (row: { counts: TokenCounts }) => {
  const peak = Math.max(1, ...rows.value.map((item) => item.counts.inputTokens));
  return Math.round((row.counts.inputTokens / peak) * 100);
};
const chartLabel = computed(() => `${range.value === "today" ? "今日每小时" : "每日"}${metric.value === "input" ? "输入" : "输出"} Token`);
</script>
<style scoped>
@reference "../styles/app.css";

.usage {
  display: grid;
  gap: 28px;
  min-width: 0;
}
[data-slot="alert"].enable {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.initial {
  font-size: 18px;
  font-weight: 600;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  padding: 8px 0;
}
.kpi {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 8px 16px;
}
.kpi + .kpi {
  border-left: 1px solid var(--group-line);
}
.kpi-label {
  color: var(--text-3);
  font-size: 14px;
}
.kpi-value {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.share {
  height: 8px;
  background: var(--group-tile);
}
.share-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 8px;
  color: var(--text-3);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 640px) {
  .kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: 8px;
  }
  .kpi:nth-child(3) {
    border-left: 0;
  }
  .kpi-value {
    font-size: 18px;
  }
}
</style>

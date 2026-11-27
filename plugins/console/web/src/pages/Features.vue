<template>
  <div class="page grouped abilities-page">
    <TopicFeedback :state="plugins" label="能力" />
    <Teleport defer to="#page-actions"><ToolCatalog /></Teleport>

    <SettingsGroup v-for="group in groups" :key="group.id" class="arrive" :title="group.label" :tone="group.id === 'issue' ? 'danger' : undefined">
      <AbilityCard
        v-for="item in group.items"
        :key="item.ability.plugin"
        :ability="item.ability"
        :entry="item.entry"
        :addable="item.addable"
        :issue="item.issue"
        :open="section === item.ability.plugin"
        :writable="writable"
        :busy="busy"
        @update:open="setSection(item.ability.plugin, $event)"
        @toggle="toggle(item.ability, $event)"
        @add="add(item.ability)"
      >
        <template v-if="item.entry">
          <SettingsGroup v-if="item.ability.body === 'memory'" :label="item.ability.title">
            <GroupRow title="记忆库" :icon="BookOpen" :to="{ path: pages.home.path, query: { panel: 'files', document: 'memory' } }" />
            <GroupRow title="检索模型" :icon="Sparkles" :to="settingsPages.models.path" />
          </SettingsGroup>
          <ImageModels v-else-if="item.ability.body === 'image'" />
          <Computer v-else-if="item.ability.body === 'computer'" />
          <GoogleConnection v-else-if="item.ability.body === 'google'" class="nested" />
          <XiaoheiheConnection v-if="item.ability.body === 'xiaoheihe' && session.state.role === 'owner'" />
          <PluginSettings v-if="item.ability.body === 'settings' || item.ability.body === 'xiaoheihe'" :path="item.entry.path" />
        </template>
      </AbilityCard>
    </SettingsGroup>

    <ExtensionsPanel />
  </div>
</template>
<script setup lang="ts">
import { BookOpen, Stars as Sparkles } from "reicon-vue";
import { computed, onBeforeUnmount, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { PluginConfigEntry } from "../../../src/shared/plugin-config";
import AbilityCard from "../components/AbilityCard.vue";
import ExtensionsPanel from "../components/ExtensionsPanel.vue";
import GoogleConnection from "../components/GoogleConnection.vue";
import GroupRow from "../components/group/GroupRow.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import ImageModels from "../components/models/ImageModels.vue";
import PluginSettings from "../components/PluginSettings.vue";
import ToolCatalog from "../components/ToolCatalog.vue";
import XiaoheiheConnection from "../components/XiaoheiheConnection.vue";
import { useSession } from "../context";
import { ABILITIES, ABILITY_LEVELS, type Ability } from "../lib/abilities";
import { setFeatureEnabled } from "../lib/features";
import { addPluginInstance } from "../lib/plugin-actions";
import { pluginError } from "../lib/plugin-config";
import { toast } from "../lib/toast";
import { pages, settingsPages } from "../nav";
import TopicFeedback from "../shell/TopicFeedback.vue";
import { useAbilityIssues } from "../state/ability-issues";
import Computer from "./Computer.vue";

/**
 * 能力 (user, 2026-11-21): one row per capability, grouped by who may have the bot use it, with what needs the
 * owner's attention on top. A row's switch saves at once (with 撤销); its own settings open on their own
 * (user, 2026-11-22: 「我不喜欢下拉式的，我需要的是弹窗」), as a page of the 设置 window (2026-11-23: 「最忌弹窗套弹窗」).
 */
const { plugins, entryOf, issueOf } = useAbilityIssues();
const session = useSession();
const route = useRoute(),
  router = useRouter();
const writable = computed(() => plugins.data?.writable ?? false);
const busy = ref(false);

interface Item {
  ability: Ability;
  entry?: PluginConfigEntry;
  addable: boolean;
  issue?: string;
}
const items = computed<Item[]>(() =>
  ABILITIES.flatMap((ability) => {
    const entry = entryOf(ability.plugin);
    const addable = !entry && !!plugins.data?.available.some((candidate) => candidate.name === ability.plugin);
    if (!entry && !addable) return [];
    return [{ ability, entry, addable, issue: issueOf(ability) }];
  }),
);
const groups = computed(() =>
  [
    { id: "issue", label: "需要处理", items: items.value.filter((item) => item.issue) },
    { id: "all", label: ABILITY_LEVELS.all, items: items.value.filter((item) => !item.issue && item.entry?.enabled && item.ability.level === "all") },
    { id: "admin", label: ABILITY_LEVELS.admin, items: items.value.filter((item) => !item.issue && item.entry?.enabled && item.ability.level === "admin") },
    { id: "off", label: "已关闭", items: items.value.filter((item) => !item.issue && !item.entry?.enabled) },
  ].filter((group) => group.items.length),
);

/** The open card is in the URL (`?section=<plugin>`), so links into a capability's settings keep working. */
const section = computed(() => (typeof route.query.section === "string" ? route.query.section : ""));
function setSection(plugin: string, open: boolean) {
  const query = { ...route.query };
  if (open) query.section = plugin;
  else delete query.section;
  void router.replace({ query });
}

let disposed = false;
onBeforeUnmount(() => (disposed = true));
async function toggle(ability: Ability, enabled: boolean, undo = false) {
  const entry = entryOf(ability.plugin);
  if (!entry || busy.value || !writable.value || entry.locked || entry.enabled === enabled) return;
  busy.value = true;
  try {
    await setFeatureEnabled(plugins.data?.revision, entry, enabled);
    if (disposed) return;
    const text = `「${ability.title}」已${enabled ? "开启" : "关闭"}`;
    toast(text, "ok", undefined, undo ? undefined : { label: "撤销", run: () => void toggle(ability, !enabled, true) });
  } catch (error) {
    if (!disposed) toast(pluginError(error), "danger");
  } finally {
    if (!disposed) busy.value = false;
  }
}
async function add(ability: Ability) {
  if (busy.value || !writable.value || !plugins.data?.revision || entryOf(ability.plugin)) return;
  busy.value = true;
  try {
    await addPluginInstance(plugins.data.revision, ability.plugin);
    if (!disposed) {
      toast(`已添加「${ability.title}」`);
      setSection(ability.plugin, true);
    }
  } catch (error) {
    if (!disposed) toast(pluginError(error), "danger");
  } finally {
    if (!disposed) busy.value = false;
  }
}
</script>
<style scoped>
@reference "../styles/app.css";

/* A capability's own panels sit on its page; their cards keep no extra shadow. */
.nested :deep(.service) {
  box-shadow: none;
}
</style>

<template>
  <div class="page grouped system-settings">
    <Tabs :model-value="current" activation-mode="manual"
      ><TabsList class="h-auto max-w-full justify-start overflow-x-auto" aria-label="系统"
        ><TabsTrigger v-for="item in tabs" :key="item.id" :value="item.id" @click="tab = item.id">{{ item.label }}</TabsTrigger></TabsList
      ></Tabs
    >
    <template v-if="current === 'status'">
      <TopicFeedback :state="panel" label="机器人状态" />
      <SettingsGroup v-if="panel.data === null" label="机器人状态"><GroupRow title="机器人核心尚未启动" :icon="Power" /></SettingsGroup>
      <BotStatus v-else-if="panel.data" :panel="panel.data" />
      <SettingsGroup v-else label="机器人状态" aria-busy="true"
        ><div class="grid gap-2 p-2"><Skeleton v-for="n in 3" :key="n" class="h-12" /></div
      ></SettingsGroup>
    </template>
    <Usage v-else-if="current === 'usage'" />
    <System v-else-if="current === 'server'"><GroupRow title="提示词" :icon="FileText" clickable @open="promptOpen = true" /></System>
    <SettingsGroup v-else title="运行"><GroupRow title="提示词" :icon="FileText" clickable @open="promptOpen = true" /></SettingsGroup>
    <SettingsSubpage v-model:open="promptOpen" title="提示词" dialog-class="sm:max-w-4xl"><PromptOverview /></SettingsSubpage>
  </div>
</template>
<script setup lang="ts">
import { DocumentText as FileText, Power } from "reicon-vue";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";

import type { PanelPayload } from "../../../src/shared/panel";
import BotStatus from "../components/BotStatus.vue";
import GroupRow from "../components/group/GroupRow.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import PromptOverview from "../components/PromptOverview.vue";
import SettingsSubpage from "../components/SettingsSubpage.vue";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { useSession } from "../context";
import { useRouteState } from "../lib/route-state";
import { useTopic } from "../lib/use-topic";
import TopicFeedback from "../shell/TopicFeedback.vue";
import System from "./System.vue";
import Usage from "./Usage.vue";

/** 设置 → 系统: how the bot is doing, what it used, the server (owner) and the prompt. Its old 高级 settings moved to 对话 and 模型. */
const session = useSession();
const panel = useTopic<PanelPayload | null>("panel");
type Tab = "status" | "usage" | "server" | "advanced";
const tabs = computed(
  () =>
    [
      { id: "status", label: "运行状态" },
      ...(session.state.features.usage || (session.state.role === "owner" && session.state.features.accounts) ? [{ id: "usage", label: "用量" }] : []),
      ...(session.state.role === "owner" ? [{ id: "server", label: "诊断" }] : [{ id: "advanced", label: "提示词" }]),
    ] as { id: Tab; label: string }[],
);
const tab = useRouteState("tab", "status");
/** 提示词 is a diagnostic view, so it lives here (user, 2026-11-17); `section=prompt` opens it on any tab. */
const route = useRoute();
const promptOpen = ref(false);
watch(
  () => route.query.section,
  (section) => {
    promptOpen.value = section === "prompt";
  },
  { immediate: true },
);
/** Old links to 高级 open 服务器 for the owner, where those settings now live. */
const current = computed<Tab>(() => {
  const wanted = tab.value === "advanced" && session.state.role === "owner" ? "server" : tab.value;
  return tabs.value.some((item) => item.id === wanted) ? (wanted as Tab) : "status";
});
</script>

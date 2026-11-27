<template>
  <div class="page grouped model-settings">
    <SettingsGroup v-if="!state.draft && state.loading" label="模型" aria-busy="true">
      <div class="grid gap-2 p-2" role="status"><Skeleton v-for="n in 3" :key="n" class="h-10" /></div>
    </SettingsGroup>
    <Alert v-if="state.error && !state.draft" role="alert" variant="destructive" as="p">{{ state.error }}</Alert>
    <Alert v-if="state.draft && !state.draft.writable" role="alert" variant="warn" as="p">
      {{ state.draft.reason || "当前配置不可编辑" }}
    </Alert>
    <ModelPurposes />
    <ConnectionList />
    <BotBehavior part="input" />
  </div>
</template>

<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, provide } from "vue";

import SettingsGroup from "../components/group/SettingsGroup.vue";
import ConnectionList from "../components/models/ConnectionList.vue";
import ModelPurposes from "../components/models/ModelPurposes.vue";
import { Alert } from "../components/ui/alert";
import { Skeleton } from "../components/ui/skeleton";
import { onCacheRefresh } from "../lib/cache";
import { toastErrors } from "../lib/toast";
import { createModelSettingsState } from "../state/model-settings-state";
import { createModelsPage, MODELS_PAGE } from "../state/models-page";
import BotBehavior from "./BotBehavior.vue";

const view = createModelSettingsState();
provide(MODELS_PAGE, createModelsPage(view));
const { state } = view;
// A failed save shows as a toast; a page that could not be read keeps its error and retry in place.
toastErrors(
  () => state.error,
  () => (state.error = ""),
  () => !state.draft,
  () => state.loading || state.saving,
);
onBeforeUnmount(
  onCacheRefresh((path) => {
    if (path === "/yesimbot/model-settings" && !state.saving) void view.reload();
  }),
);

// Settings are read while the tab is visible; a hidden tab does not hold a stale copy open.
let pageActive = false;
const visibility = () => void view.setVisible(pageActive && !document.hidden);
onMounted(() => {
  pageActive = true;
  document.addEventListener("visibilitychange", visibility);
  visibility();
});
onActivated(() => {
  pageActive = true;
  visibility();
});
onDeactivated(() => {
  pageActive = false;
  visibility();
});
onBeforeUnmount(() => {
  pageActive = false;
  document.removeEventListener("visibilitychange", visibility);
  view.dispose();
});
</script>

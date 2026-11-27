<template>
  <SettingsGroup v-if="!state.draft && state.loading" label="模型" aria-busy="true">
    <div class="grid gap-2 p-2" role="status"><Skeleton v-for="n in 2" :key="n" class="h-10" /></div>
  </SettingsGroup>
  <Alert v-if="state.error && !state.draft" role="alert" variant="destructive" as="p">{{ state.error }}</Alert>
  <ModelPurposes only="image" />
  <!-- No image model in any service yet: the way to add one, in the service that can serve it. -->
  <SettingsGroup v-if="state.draft && !hasImageModels" label="生图模型">
    <GroupRow title="添加生图模型" :icon="ImagePlus" :to="addLink" />
  </SettingsGroup>
</template>
<script setup lang="ts">
import { GalleryAdd as ImagePlus } from "reicon-vue";
import { computed, onBeforeUnmount, onMounted, provide } from "vue";

import { toastErrors } from "../../lib/toast";
import { settingsPages } from "../../nav";
import { createModelSettingsState, servesImages } from "../../state/model-settings-state";
import { createModelsPage, MODELS_PAGE } from "../../state/models-page";
import GroupRow from "../group/GroupRow.vue";
import SettingsGroup from "../group/SettingsGroup.vue";
import { Alert } from "../ui/alert";
import { Skeleton } from "../ui/skeleton";
import ModelPurposes from "./ModelPurposes.vue";

/**
 * 能力 › 画图: which models draw and edit pictures (user, 2026-11-23: 「咋不能配置生图了？」). The same model settings
 * as 模型's 生图 and 改图; a choice saves at once there and here.
 */
const view = createModelSettingsState();
provide(MODELS_PAGE, createModelsPage(view));
const { state } = view;
toastErrors(
  () => state.error,
  () => (state.error = ""),
  () => !state.draft,
  () => state.loading || state.saving,
);
const hasImageModels = computed(() => view.modelChoices("image").length > 0);
/** The first enabled service that can draw opens on its 生图模型 list; without one, 模型 is where a service is added. */
const addLink = computed(() => {
  const service = state.draft?.connections.find((connection) => connection.enabled && servesImages(connection.type) && connection.id.trim());
  return service ? { path: settingsPages.models.path, query: { connection: service.id, tab: "image" } } : settingsPages.models.path;
});
onMounted(() => void view.setVisible(true));
onBeforeUnmount(() => view.dispose());
</script>

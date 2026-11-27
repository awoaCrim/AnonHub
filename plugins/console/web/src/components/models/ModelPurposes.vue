<template>
  <!-- 能力 › 画图: only the image models, chosen where drawing is switched on. -->
  <SettingsGroup v-if="state.draft && only === 'image'" title="模型">
    <fieldset :disabled="!editable" class="role-list">
      <GroupRow v-for="role in imageRoles" :key="role.key" :title="role.label" :icon="role.icon">
        <div class="picker">
          <PickerMenu
            :model-value="roleValue(role.key)"
            field
            :label="role.label"
            :options="modelOptions(role.key, role.fallback)"
            @update:model-value="choose(role.key, $event)"
          />
        </div>
      </GroupRow>
    </fieldset>
  </SettingsGroup>
  <template v-else-if="state.draft">
    <SettingsGroup title="主要模型">
      <fieldset :disabled="!editable" class="role-list">
        <GroupRow title="对话" :icon="MessageSquare" :detail="state.draft.roles.chatModel ? undefined : '未选对话模型'">
          <div class="picker">
            <PickerMenu
              :model-value="state.draft.roles.chatModel"
              field
              label="对话"
              :options="modelOptions('chatModel', '未设置')"
              @update:model-value="choose('chatModel', $event)"
            />
          </div>
        </GroupRow>
        <GroupRow v-for="role in primaryRoles" :key="role.key" :title="role.label" :icon="role.icon">
          <div class="picker">
            <PickerMenu
              :model-value="roleValue(role.key)"
              field
              :label="role.label"
              :options="modelOptions(role.key, role.fallback)"
              @update:model-value="choose(role.key, $event)"
            />
          </div>
        </GroupRow>
      </fieldset>
    </SettingsGroup>
    <SettingsGroup title="其余用途">
      <fieldset :disabled="!editable" class="role-list">
        <GroupRow v-for="role in followRoles" :key="role.key" :title="role.label" :icon="role.icon">
          <div class="picker">
            <PickerMenu
              :model-value="roleValue(role.key)"
              field
              :label="role.label"
              :options="modelOptions(role.key, role.fallback)"
              @update:model-value="choose(role.key, $event)"
            />
          </div>
        </GroupRow>
        <GroupRow title="后台任务" :icon="ListTodo">
          <div class="picker"><TaskModels /></div>
        </GroupRow>
      </fieldset>
    </SettingsGroup>
  </template>
</template>

<script setup lang="ts">
import { Bulb as Brain, Eye, GalleryAdd as ImagePlus, Checklist as ListTodo, Message as MessageSquare, Pen as Pencil, Stars as Sparkles } from "reicon-vue";
import { inject, type Component } from "vue";

import type { ModelSettingsRoles } from "../../../../src/model-settings-types";
import type { PickerOption } from "../../lib/picker";
import { MODELS_PAGE } from "../../state/models-page";
import GroupRow from "../group/GroupRow.vue";
import SettingsGroup from "../group/SettingsGroup.vue";
import PickerMenu from "../PickerMenu.vue";
import TaskModels from "./TaskModels.vue";

/** `image`: only 生图 and 改图 (on 能力 › 画图). */
defineProps<{ only?: "image" }>();
const { view, state, editable } = inject(MODELS_PAGE)!;
/** 模型 (user, 2026-11-21): three models to choose; every other use follows one of them unless set. A choice saves at once, with 撤销. */
const primaryRoles: { key: keyof ModelSettingsRoles; label: string; fallback: string; icon: Component }[] = [
  { key: "auxiliaryModel", label: "辅助", fallback: "未设置", icon: Sparkles },
  { key: "imageModel", label: "生图", fallback: "不画图", icon: ImagePlus },
];
const followRoles: { key: keyof ModelSettingsRoles; label: string; fallback: string; icon: Component }[] = [
  { key: "visionModel", label: "看图", fallback: "对话模型直接看", icon: Eye },
  { key: "imageEditModel", label: "改图", fallback: "跟随生图", icon: Pencil },
  { key: "embeddingModel", label: "检索记忆", fallback: "只按关键词", icon: Brain },
];
const imageRoles = [...primaryRoles, ...followRoles].filter((role) => role.key === "imageModel" || role.key === "imageEditModel");
const ROLE_LABELS: Partial<Record<keyof ModelSettingsRoles, string>> = Object.fromEntries(
  [{ key: "chatModel", label: "对话" }, ...primaryRoles, ...followRoles].map((role) => [role.key, role.label]),
);
function choose(key: keyof ModelSettingsRoles, value: string | undefined) {
  if (!state.draft || !editable.value || (state.draft.roles[key] ?? "") === (value ?? "")) return;
  void view.setRole(key, value ?? "", ROLE_LABELS[key] ?? key);
}

function roleValue(key: keyof ModelSettingsRoles): string | undefined {
  return state.draft?.roles[key] ?? "";
}

/** A saved choice whose connection or model is gone stays visible instead of silently changing. */
function modelOptions(key: keyof ModelSettingsRoles, empty: string): PickerOption<string | undefined>[] {
  const value = state.draft?.roles[key];
  const choices = view.modelChoices(key === "imageModel" || key === "imageEditModel" ? "image" : key === "embeddingModel");
  return [
    { value: "", label: empty },
    ...(value && !choices.some((choice) => choice.value === value) ? [{ value, label: `${value}（当前不可用）` }] : []),
    ...choices.map((choice) => ({
      value: choice.value,
      label: choice.label,
      ...(key === "imageEditModel" && !state.draft?.roles.imageModel ? { disabled: true, note: "先选择生图模型" } : {}),
    })),
  ];
}
</script>

<style scoped>
@reference "../../styles/app.css";

.role-list {
  display: grid;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.picker {
  width: 224px;
  max-width: 100%;
}
.picker :deep([data-slot="select-trigger"]) {
  @apply rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile;
}
</style>

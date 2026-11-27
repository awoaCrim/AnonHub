<template>
  <div class="model-workspace">
    <SettingsGroup :title="tab === 'image' ? '生图模型' : tab === 'chat' ? '聊天模型' : '向量模型'">
      <div v-if="!supported" class="state-line">{{ tab === "image" ? "当前协议不支持生图" : "当前协议不支持向量检索" }}</div>
      <label v-if="searchable" class="search-field"
        ><span class="sr-only">搜索模型</span
        ><Input
          v-model="modelQuery"
          type="search"
          class="rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile"
          placeholder="搜索模型 ID"
      /></label>
      <GroupRow v-for="row in filteredModels" :key="row.key" :title="row.model.id" clickable @open="selectedModelKey = row.key">
        <template #title
          ><Badge v-if="usedFor(row.model)" variant="ok" as="span">{{ usedFor(row.model) }}</Badge
          ><span v-if="chat(row.model)?.toolCall" class="tag">工具</span><span v-if="chat(row.model)?.reasoning" class="tag">推理</span></template
        >
      </GroupRow>
      <div v-if="modelQuery && !filteredModels.length" class="state-line">没有匹配的模型</div>
      <GroupRow v-if="supported" title="添加模型" :icon="Plus">
        <form class="add" @submit.prevent="add">
          <SuggestInput
            v-model="draft"
            class="field-input mono-input"
            aria-label="模型 ID"
            label="检测到的模型"
            :options="unusedProbed.map((id) => ({ value: id, label: id }))"
            :aria-invalid="!!problem"
            :disabled="!editable"
            @update:model-value="problem = ''"
          />
          <Button type="submit" variant="outline" size="sm" :disabled="!editable || !draft.trim()">添加</Button>
        </form>
        <template v-if="problem" #below
          ><p class="problem" role="alert">{{ problem }}</p></template
        >
      </GroupRow>
    </SettingsGroup>
  </div>
  <!-- One model is a level of its own (模型 › 服务 › 模型); each change saves at once. -->
  <SettingsSubpage :open="!!activeModel" :title="activeModel?.id || '模型'" dialog-class="sm:max-w-xl" @update:open="(open) => open || (selectedModelKey = '')">
    <fieldset v-if="activeModel" :disabled="!editable" class="model-detail">
      <SettingsGroup label="模型">
        <GroupRow title="模型 ID" :icon="Tag">
          <SuggestInput
            v-model="idText"
            class="field-input mono-input"
            aria-label="模型 ID"
            label="检测到的模型"
            :options="probedModels.map((id) => ({ value: id, label: id }))"
            :aria-invalid="!!idProblem"
            @update:model-value="idProblem = ''"
            @blur="rename"
            @keyup.enter="($event.target as HTMLInputElement).blur()"
          />
          <template v-if="idProblem" #below
            ><p class="problem" role="alert">{{ idProblem }}</p></template
          >
        </GroupRow>
        <template v-if="chat(activeModel)">
          <GroupRow title="支持工具调用" :icon="Wrench">
            <Switch
              :model-value="!!chat(activeModel)!.toolCall"
              aria-label="支持工具调用"
              @update:model-value="changeModel(activeModel, '工具调用', (model) => (model.toolCall = $event))"
            />
          </GroupRow>
          <GroupRow title="支持推理" :icon="Brain">
            <Switch
              :model-value="!!chat(activeModel)!.reasoning"
              aria-label="支持推理"
              @update:model-value="changeModel(activeModel, '推理', (model) => (model.reasoning = $event))"
            />
          </GroupRow>
          <ModelCapabilityProbe :connection-key="connection.key" :model="activeModel.id" :enabled="!state.saving && connection.enabled && !!activeModel.id" />
        </template>
      </SettingsGroup>
      <template v-if="chat(activeModel)">
        <SettingsGroup title="思考">
          <GroupRow title="思考等级" :icon="SlidersHorizontal" :detail="thinkingHint || undefined">
            <div class="picker">
              <PickerMenu
                :model-value="chat(activeModel)!.thinkingLevel"
                field
                label="思考等级"
                :options="thinkingOptions"
                @update:model-value="setThinkingLevel"
              />
            </div>
          </GroupRow>
        </SettingsGroup>
        <SettingsGroup v-if="mapLevels.length" title="思考等级映射">
          <GroupRow v-for="level in mapLevels" :key="level" :title="level">
            <Input
              class="picker field-input mono-input"
              :aria-label="`${level} 映射`"
              :value="chat(activeModel)!.thinkingLevelMap?.[level] ?? ''"
              :placeholder="chat(activeModel)!.thinkingLevelMap?.[level] === null ? '不发送' : '默认'"
              @change="setLevel(level, ($event.target as HTMLInputElement).value)"
            />
          </GroupRow>
        </SettingsGroup>
      </template>
      <SettingsGroup label="删除">
        <GroupRow title="删除此模型" :icon="Trash2" icon-tone="danger"><Button variant="danger" size="sm" @click="remove">删除</Button></GroupRow>
      </SettingsGroup>
    </fieldset>
  </SettingsSubpage>
</template>

<script setup lang="ts">
import { Bulb as Brain, Add as Plus, Tuning as SlidersHorizontal, Tag, Trash2, Gear as Wrench } from "reicon-vue";
import { computed, inject, ref, watch } from "vue";

import type { ModelSettingsConnection, ModelSettingsImageModel, ModelSettingsModel } from "../../../../src/model-settings-types";
import { confirmDialog } from "../../lib/dialog";
import { modelThinkingHint, modelThinkingLevels, modelThinkingOptions, selectModelThinkingLevel } from "../../lib/model-thinking";
import { servesImages } from "../../state/model-settings-state";
import { MODELS_PAGE } from "../../state/models-page";
import GroupRow from "../group/GroupRow.vue";
import SettingsGroup from "../group/SettingsGroup.vue";
import PickerMenu from "../PickerMenu.vue";
import SettingsSubpage from "../SettingsSubpage.vue";
import SuggestInput from "../SuggestInput.vue";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import ModelCapabilityProbe from "./ModelCapabilityProbe.vue";

/** The models of one kind of a service: a searchable list with an add row; each model opens as its own level. */
const props = defineProps<{ connection: ModelSettingsConnection; probedModels: string[] }>();
const {
  state,
  editable,
  tab,
  models,
  modelQuery,
  rows,
  filteredModels,
  selectedModelKey,
  activeModel,
  addModels,
  removeModel,
  changeModel,
  renameModel,
  usedFor,
} = inject(MODELS_PAGE)!;
const searchable = computed(() => rows.value.length > 6);
const supported = computed(() =>
  tab.value === "image" ? servesImages(props.connection.type) : tab.value === "embedding" ? ["openai", "google"].includes(props.connection.type) : true,
);
const unusedProbed = computed(() => props.probedModels.filter((id) => !models.value.some((model) => model.id === id)));
const draft = ref("");
const problem = ref("");
/** The ID being typed; it is saved when the field is left, and follows the saved ID otherwise. */
const idText = ref("");
const idProblem = ref("");
const mapLevels = computed(() => {
  const model = chat(activeModel.value);
  return model ? modelThinkingLevels(props.connection.type, model) : [];
});
const thinkingOptions = computed(() => {
  const model = chat(activeModel.value);
  return model ? modelThinkingOptions(props.connection.type, model) : [];
});
const thinkingHint = computed(() => {
  const model = chat(activeModel.value);
  return model ? modelThinkingHint(props.connection.type, model) : "";
});

watch(
  () => activeModel.value?.id,
  (id) => {
    idText.value = id ?? "";
    idProblem.value = "";
  },
  { immediate: true },
);

/** A chat model, which has tools, reasoning and thinking levels; image and embedding models have none. */
function chat(model: ModelSettingsModel | ModelSettingsImageModel | undefined): ModelSettingsModel | undefined {
  return tab.value === "chat" ? (model as ModelSettingsModel | undefined) : undefined;
}

function add() {
  const id = draft.value.trim();
  if (!id) return;
  if (models.value.some((model) => model.id === id)) {
    problem.value = "已有同名模型。";
    return;
  }
  draft.value = "";
  void addModels([id]);
}

function rename() {
  if (activeModel.value) idProblem.value = renameModel(activeModel.value, idText.value);
}

function setThinkingLevel(level: ModelSettingsModel["thinkingLevel"]) {
  if (activeModel.value) void changeModel(activeModel.value, "思考等级", (model) => selectModelThinkingLevel(props.connection.type, model, level));
}

/** One level's provider value; clearing it drops the entry, and an empty map is dropped too. */
function setLevel(level: NonNullable<ModelSettingsModel["thinkingLevel"]>, text: string) {
  const model = chat(activeModel.value);
  if (!model || (model.thinkingLevelMap?.[level] ?? "") === text.trim()) return;
  void changeModel(model, `${level} 映射`, (target) => {
    const map = { ...target.thinkingLevelMap };
    if (text.trim()) map[level] = text.trim();
    else delete map[level];
    target.thinkingLevelMap = Object.keys(map).length ? map : undefined;
  });
}

async function remove() {
  const model = activeModel.value;
  if (model && (await confirmDialog({ title: `删除模型“${model.id}”？`, confirmLabel: "删除", danger: true }))) void removeModel(model);
}
</script>

<style scoped>
@reference "../../styles/app.css";

.model-workspace {
  display: grid;
  gap: 24px;
  min-width: 0;
}
.search-field {
  display: block;
  padding: 4px 8px 8px;
}
.state-line {
  padding: 16px;
  color: var(--text-3);
  font-size: 14px;
}
.tag {
  @apply rounded-full bg-group-tile text-muted-foreground text-xs;
  padding: 4px 8px;
}
.field-input {
  @apply rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile;
  width: 260px;
  max-width: 100%;
}
.add {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.add .field-input {
  width: min(15rem, 42vw);
}
.problem {
  @apply text-sm text-destructive;
  margin: 0;
}
.model-detail {
  display: grid;
  gap: 28px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.picker {
  width: 200px;
  max-width: 100%;
}
.picker :deep([data-slot="select-trigger"]) {
  @apply rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile;
}
</style>

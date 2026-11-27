<template>
  <Button
    variant="outline"
    class="w-full min-w-0 justify-between gap-3 rounded-[10px] border-transparent bg-group-tile font-normal shadow-none dark:border-transparent dark:bg-group-tile dark:hover:bg-group-tile"
    aria-label="选择后台任务模型"
    :disabled="!editable"
    @click="openPicker"
  >
    <span class="truncate">{{ selected.length ? `已选 ${selected.length} 个模型` : "跟随当前对话" }}</span>
    <ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  </Button>
  <SettingsSubpage v-model:open="open" title="后台任务" dialog-class="sm:max-w-xl">
    <SettingsGroup title="可用模型">
      <template #actions>
        <Button variant="ghost" size="sm" :disabled="!editable || !selected.length" @click="clear">跟随当前对话</Button>
      </template>
      <label class="search-field"
        ><span class="sr-only">搜索后台任务模型</span
        ><Input v-model="query" type="search" class="rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile" placeholder="搜索模型"
      /></label>
      <GroupRow v-for="choice in choices" :key="choice.value" :title="choice.label">
        <Badge v-if="choice.value === selected[0]" variant="secondary">默认</Badge>
        <Button
          v-else-if="selected.includes(choice.value) && !choice.unavailable"
          variant="ghost"
          size="sm"
          :disabled="!editable"
          @click="makeDefault(choice.value)"
          >设为默认</Button
        >
        <Checkbox
          :model-value="selected.includes(choice.value)"
          :disabled="!editable"
          :aria-label="choice.label"
          @update:model-value="toggle(choice.value, $event === true)"
        />
      </GroupRow>
      <div v-if="!choices.length" class="state-line">{{ query.trim() ? "没有匹配的模型" : "没有可用的聊天模型" }}</div>
    </SettingsGroup>
  </SettingsSubpage>
</template>

<script setup lang="ts">
import { ChevronRight } from "reicon-vue";
import { computed, inject, ref } from "vue";

import { MODELS_PAGE } from "../../state/models-page";
import GroupRow from "../group/GroupRow.vue";
import SettingsGroup from "../group/SettingsGroup.vue";
import SettingsSubpage from "../SettingsSubpage.vue";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

/** 后台任务: the models background work may use, the first one by default. Each tick saves at once, with 撤销. */
const { view, state, editable } = inject(MODELS_PAGE)!;
const open = ref(false);
const query = ref("");
const selected = computed(() => state.draft?.taskModels ?? []);
const choices = computed(() => {
  const available = view.modelChoices();
  const missing = selected.value
    .filter((value) => !available.some((choice) => choice.value === value))
    .map((value) => ({ value, label: `${value}（当前不可用）`, unavailable: true }));
  const search = query.value.trim().toLowerCase();
  return [...missing, ...available.map((choice) => ({ ...choice, unavailable: false }))].filter((choice) => choice.label.toLowerCase().includes(search));
});
function openPicker() {
  query.value = "";
  open.value = true;
}

function save(next: string[]) {
  if (editable.value && state.draft && next.join("\n") !== selected.value.join("\n")) void view.setTaskModels(next);
}

function toggle(value: string, checked: boolean) {
  save(checked ? [...new Set([...selected.value, value])] : selected.value.filter((model) => model !== value));
}

function makeDefault(value: string) {
  if (selected.value.includes(value)) save([value, ...selected.value.filter((model) => model !== value)]);
}

function clear() {
  save([]);
}
</script>
<style scoped>
.search-field {
  display: block;
  padding: 4px 8px 8px;
}
.state-line {
  padding: 16px;
  color: var(--text-3);
  font-size: 14px;
}
</style>

<template>
  <SettingsGroup :title="`${title} ${model.length}/${catalog.length}`">
    <template #actions>
      <Button type="button" variant="outline" size="sm" class="rounded-full" :disabled="disabled" @click="model = catalog.map((item) => item.name)"
        >全选</Button
      >
      <Button type="button" variant="outline" size="sm" class="rounded-full" :disabled="disabled" @click="model = []">全不选</Button>
    </template>
    <GroupRow v-for="item in catalog" :key="item.name" :title="item.label" :detail="item.description">
      <Switch :model-value="model.includes(item.name)" :disabled="disabled" :aria-label="item.label" @update:model-value="choose(item.name, $event === true)" />
    </GroupRow>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { OPTIONAL_MEMBER_PLUGINS } from "../../../src/shared/plugin-catalog";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

/** Optional features granted to a friend when adding one or changing the grant. */
withDefaults(defineProps<{ disabled?: boolean; title?: string }>(), { title: "功能授权" });
const model = defineModel<string[]>({ required: true });
const catalog = OPTIONAL_MEMBER_PLUGINS;
const choose = (name: string, on: boolean) => (model.value = on ? [...model.value.filter((n) => n !== name), name] : model.value.filter((n) => n !== name));
</script>

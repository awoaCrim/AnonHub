<template>
  <div class="config-form">
    <SettingsGroup v-for="block in blocks" :key="block.id" :title="block.title || undefined" :label="block.title || label">
      <template v-if="choice(block)" #actions>
        <Segmented
          :model-value="String(choice(block)!.selected)"
          :options="segments(choice(block)!)"
          :label="block.title || label"
          :disabled="scoped.disabled"
          @update:model-value="choose(choice(block)!, Number($event), block.title || label)"
        />
      </template>
      <ConfigRow v-for="row in fields(block)" :key="row.id" :row="row" :label="row.title || block.title || label" />
      <ConfigCollection v-if="block.collection" :collection="block.collection" />
    </SettingsGroup>
  </div>
</template>
<script setup lang="ts">
import { computed, inject, provide } from "vue";

import Segmented from "../components/group/Segmented.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import { CONFIG_STORE, type ConfigStore } from "./config-store";
import ConfigCollection from "./ConfigCollection.vue";
import ConfigRow from "./ConfigRow.vue";
import { branchLabel, layout, shortLabel, switchBranch, type Block, type BranchRow, type FieldRow, type Path, type Schema } from "./schema-model";

/**
 * A schema as a settings page (user, 2026-11-25): groups of rows like 对话 and 模型服务, every change saved at once
 * through the store. Lists and named items open as pages of the 设置 window. `store` starts a scope of its own (an item
 * of a list, a new item); otherwise the rows use the page's.
 */
const props = defineProps<{ node: Schema | null | undefined; path: Path; label: string; store?: ConfigStore }>();
const scoped = props.store ?? (inject(CONFIG_STORE) as ConfigStore);
provide(CONFIG_STORE, scoped);
const blocks = computed(() => layout(props.node, props.path, (path) => scoped.value(path), scoped.dynamics));
const choice = (block: Block) => block.rows.find((row): row is BranchRow => row.kind === "branch");
const fields = (block: Block) => block.rows.filter((row): row is FieldRow => row.kind !== "branch");
const segments = (row: BranchRow) =>
  (row.node.list ?? []).map((child, index) => ({ value: String(index), label: shortLabel(branchLabel(child, index, scoped.dynamics)) }));
/** Another shape: its fixed fields are set; the fields both shapes share stay. */
function choose(row: BranchRow, index: number, label: string) {
  if (scoped.disabled || index === row.selected) return;
  scoped.commit(label, [[row.path, switchBranch(row.node.list?.[index] ?? {}, scoped.value(row.path), scoped.dynamics)]]);
}
</script>
<style scoped>
.config-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 28px;
  min-width: 0;
}
</style>

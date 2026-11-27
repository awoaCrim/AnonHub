<template>
  <div class="limited-list min-w-0 space-y-1">
    <div v-if="visible.length" class="grid grid-cols-1 gap-1">
      <slot v-for="item in visible" name="row" :item="item" :key="keyOf(item)"></slot>
    </div>
    <Button v-if="overflow" variant="ghost" size="sm" class="w-full rounded-full" type="button" data-view-all @click="open = true">{{ buttonLabel }}</Button>
    <Dialog v-if="overflow" v-model:open="open">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" :aria-describedby="undefined">
        <DialogHeader class="pr-6">
          <DialogTitle class="break-words leading-snug">{{ dialogTitle }}</DialogTitle>
        </DialogHeader>
        <div class="grid min-w-0 grid-cols-1 gap-1">
          <slot v-for="item in items" name="row" :item="item" :key="keyOf(item)"></slot>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
<script setup lang="ts" generic="T extends { id: string }">
import { computed, watch } from "vue";

import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

/**
 * A list that shows its first few rows (already sorted, newest first) and, past that, a text button opening
 * a Dialog with every row. Rows carry their own shape (no box or dividers around them). The `row` slot renders one row, so the inline list and the Dialog share one row
 * component and one click behavior; the owner closes the Dialog (v-model:open) when a row opens a detail.
 */
const props = withDefaults(defineProps<{ items: T[]; limit?: number; buttonLabel: string; dialogTitle: string }>(), { limit: 3 });
const open = defineModel<boolean>("open", { default: false });
const visible = computed(() => props.items.slice(0, props.limit));
const overflow = computed(() => props.items.length > props.limit);
watch(overflow, (more) => {
  if (!more) open.value = false;
});
const keyOf = (item: T) => item.id;
</script>

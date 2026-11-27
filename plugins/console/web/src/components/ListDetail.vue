<template>
  <div class="list-detail" :class="{ 'has-selection': selected }">
    <div class="ld-grid">
      <div class="ld-list"><slot name="list" /></div>
      <div class="ld-detail">
        <Button v-if="selected" variant="ghost" class="ld-back" type="button" @click="emit('back')">← {{ backLabel }}</Button>
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from "./ui/button";
/**
 * Directory on the left, the selected item on the right. When the page area is narrow (phones,
 * a narrow window, a 960 form page with the sidebar open) it shows either the list or the
 * selected item with a back button. The breakpoint follows the space this layout actually has,
 * not the window, so every list/detail page collapses at the same point.
 */
withDefaults(
  defineProps<{
    /** An item is open: narrow layouts show it instead of the list. */
    selected: boolean;
    /** Text of the back button, e.g. 全部能力. */
    backLabel?: string;
  }>(),
  { backLabel: "返回列表" },
);
const emit = defineEmits<{ back: [] }>();
</script>

<style scoped>
@reference "../styles/app.css";

.list-detail {
  container-type: inline-size;
  min-width: 0;
}
.ld-grid {
  display: grid;
  grid-template-columns: var(--list-width, 280px) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.ld-list {
  position: sticky;
  top: 24px;
  min-width: 0;
}
.ld-list > :deep(*) {
  max-height: calc(100vh - 48px);
  overflow: auto;
}
.ld-detail {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
}
.ld-back {
  display: none;
  justify-self: start;
}
@container (max-width: 760px) {
  .ld-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .ld-list {
    position: static;
  }
  .ld-list > :deep(*) {
    max-height: none;
  }
  .has-selection .ld-list,
  .list-detail:not(.has-selection) .ld-detail {
    display: none;
  }
  .ld-back {
    display: inline-flex;
  }
}
</style>

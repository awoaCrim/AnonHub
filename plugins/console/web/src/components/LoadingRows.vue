<template>
  <div class="arrive-list grid gap-1" role="status" :aria-label="label">
    <div v-for="n in count" :key="n" class="flex items-center gap-3 p-2" aria-hidden="true">
      <Skeleton class="size-9 shrink-0 rounded-full" />
      <div class="grid min-w-0 flex-1 gap-2">
        <Skeleton class="h-3.5 rounded-full" :style="{ width: `${WIDTHS[(n - 1) % WIDTHS.length]}%` }" />
        <Skeleton class="h-3 w-1/3 rounded-full" />
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { Skeleton } from "./ui/skeleton";

/** Placeholder rows shaped like the list that is loading (round icon, title, one quiet line); `label` is read aloud. */
withDefaults(defineProps<{ label: string; count?: number }>(), { count: 3 });
const WIDTHS = [72, 54, 64];
</script>

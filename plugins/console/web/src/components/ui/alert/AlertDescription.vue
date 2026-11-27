<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <div data-slot="alert-description" :class="cn('min-w-0 flex-1 basis-0 [&_p]:leading-relaxed', props.class)">
    <slot />
  </div>
</template>

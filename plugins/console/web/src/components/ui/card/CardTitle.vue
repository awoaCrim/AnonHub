<script setup lang="ts">
import { Primitive } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
  as?: string;
}>();
</script>

<template>
  <Primitive :as="as ?? 'h3'" data-slot="card-title" :class="cn('leading-none font-semibold', props.class)">
    <slot />
  </Primitive>
</template>

<script setup lang="ts">
import { Primitive } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cardVariants } from ".";
import { cn } from "../../../lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
  asChild?: boolean;
}>();
</script>

<template>
  <Primitive as="div" :as-child="asChild" data-slot="card" :class="cn(cardVariants(), props.class)">
    <slot />
  </Primitive>
</template>

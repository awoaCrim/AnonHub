<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { SliderRoot, SliderTrack, SliderRange, SliderThumb, useForwardPropsEmits, type SliderRootProps, type SliderRootEmits } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/utils";
const props = defineProps<SliderRootProps & { class?: HTMLAttributes["class"] }>();
const emits = defineEmits<SliderRootEmits>();
const forwarded = useForwardPropsEmits(reactiveOmit(props, "class"), emits);
</script>
<template>
  <SliderRoot v-bind="forwarded" :class="cn('relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50', props.class)">
    <SliderTrack class="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20"><SliderRange class="absolute h-full bg-primary" /></SliderTrack>
    <SliderThumb
      v-for="(_, index) in modelValue ?? defaultValue ?? [0]"
      :key="index"
      class="block size-4 rounded-full border border-primary bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
    />
  </SliderRoot>
</template>

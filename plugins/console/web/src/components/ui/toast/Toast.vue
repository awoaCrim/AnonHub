<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { ToastRoot, useForwardPropsEmits, type ToastRootProps, type ToastRootEmits } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/utils";
const props = defineProps<ToastRootProps & { class?: HTMLAttributes["class"]; variant?: "default" | "destructive" | "warn" }>();
const emits = defineEmits<ToastRootEmits>();
const forwarded = useForwardPropsEmits(reactiveOmit(props, "class", "variant"), emits);
</script>
<template>
  <ToastRoot
    v-bind="forwarded"
    :class="
      cn(
        'pointer-events-auto relative flex w-full items-center gap-3 overflow-hidden rounded-md border bg-background p-4 pr-6 text-foreground shadow-lg transition-all data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=open]:slide-in-from-top-full',
        variant === 'destructive' && 'border-destructive bg-destructive text-white',
        variant === 'warn' && 'border-warn/25 bg-warn-soft text-warn',
        props.class,
      )
    "
    ><slot
  /></ToastRoot>
</template>

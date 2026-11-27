<script setup lang="ts">
import { computed, useAttrs, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/utils";
import { readModel } from "../model";

/**
 * Works both ways the pages bind it: `v-model` (with `.trim`, `.number`, `.lazy`, and number inputs cast like
 * native `v-model` does) and a plain `:value` + `@input`.
 */
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  defaultValue?: string | number;
  modelValue?: string | number | null;
  modelModifiers?: { trim?: boolean; number?: boolean; lazy?: boolean };
  class?: HTMLAttributes["class"];
}>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the bound field decides: text, or a number under `.number`
const emit = defineEmits<{ "update:modelValue": [value: any] }>();
const attrs = useAttrs();
const value = computed(() => props.modelValue ?? (attrs.value as string | number | undefined) ?? props.defaultValue ?? "");
function update(event: Event, lazy: boolean) {
  if (!!props.modelModifiers?.lazy !== lazy) return;
  emit("update:modelValue", readModel(event, props.modelModifiers, attrs.type === "number"));
}
</script>

<template>
  <input
    v-bind="$attrs"
    :value="value"
    data-slot="input"
    :class="
      cn(
        'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-card px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-muted md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        props.class,
      )
    "
    @input="update($event, false)"
    @change="update($event, true)"
  />
</template>

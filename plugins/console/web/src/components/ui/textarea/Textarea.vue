<script setup lang="ts">
import { computed, useAttrs, type HTMLAttributes } from "vue";

import { cn } from "../../../lib/utils";
import { readModel } from "../model";

/** Like Input: `v-model` (with modifiers) or a plain `:value` + `@input`. */
defineOptions({ inheritAttrs: false });
const props = defineProps<{
  class?: HTMLAttributes["class"];
  defaultValue?: string | number;
  modelValue?: string | number | null;
  modelModifiers?: { trim?: boolean; number?: boolean; lazy?: boolean };
}>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the bound field decides: text, or a number under `.number`
const emit = defineEmits<{ "update:modelValue": [value: any] }>();
const attrs = useAttrs();
const value = computed(() => props.modelValue ?? (attrs.value as string | number | undefined) ?? props.defaultValue ?? "");
function update(event: Event, lazy: boolean) {
  if (!!props.modelModifiers?.lazy !== lazy) return;
  emit("update:modelValue", readModel(event, props.modelModifiers));
}
</script>

<template>
  <textarea
    v-bind="$attrs"
    :value="value"
    data-slot="textarea"
    :class="
      cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex min-h-16 w-full rounded-md border bg-card px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-muted md:text-sm',
        props.class,
      )
    "
    @input="update($event, false)"
    @change="update($event, true)"
  />
</template>

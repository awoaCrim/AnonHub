<template>
  <div class="relative min-w-0">
    <Select :model-value="selected" :disabled="disabled" @update:model-value="choose">
      <SelectTrigger :id="id" :aria-label="label" :class="field ? 'w-full' : 'h-auto w-auto border-0 bg-transparent px-1 shadow-none'">
        <slot v-if="!field" />
        <span v-else class="value truncate" :class="{ 'placeholder text-muted-foreground': !current }">{{ current?.label ?? placeholder }}</span>
      </SelectTrigger>
      <SelectContent :side="placement === 'up' ? 'top' : 'bottom'">
        <SelectGroup>
          <template v-for="(option, index) in options" :key="index">
            <SelectSeparator v-if="option.divider && index" />
            <SelectItem :value="`option-${index}`" :disabled="option.disabled">
              <span>{{ option.label }}</span
              ><small v-if="option.note" class="ml-2 text-muted-foreground">{{ option.note }}</small>
            </SelectItem>
          </template>
        </SelectGroup>
      </SelectContent>
    </Select>
    <!-- UI-EXCEPTION native-validation: an empty domain value must fail HTML form validation even when it is an explicit Select option. -->
    <input
      v-if="required"
      class="validate pointer-events-none absolute bottom-0 left-0 h-px w-px opacity-0"
      tabindex="-1"
      aria-hidden="true"
      required
      :disabled="disabled"
      :value="empty ? '' : 'set'"
    />
  </div>
</template>
<script setup lang="ts" generic="T">
import { computed } from "vue";

import type { PickerOption } from "../lib/picker";
import { Select, SelectTrigger, SelectContent, SelectGroup, SelectItem, SelectSeparator } from "./ui/select";
const props = withDefaults(
  defineProps<{
    modelValue: T;
    options: PickerOption<T>[];
    label?: string;
    id?: string;
    disabled?: boolean;
    placement?: "down" | "up";
    field?: boolean;
    placeholder?: string;
    required?: boolean;
  }>(),
  { placement: "down", placeholder: "请选择" },
);
const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const index = computed(() => props.options.findIndex((option) => Object.is(option.value, props.modelValue)));
const current = computed(() => props.options[index.value]);
const selected = computed(() => (index.value < 0 ? undefined : `option-${index.value}`));
const empty = computed(() => props.modelValue === undefined || props.modelValue === null || props.modelValue === "");
function choose(value: unknown) {
  const option = props.options[Number(String(value).replace("option-", ""))];
  if (option && !option.disabled) emit("update:modelValue", option.value);
}
</script>

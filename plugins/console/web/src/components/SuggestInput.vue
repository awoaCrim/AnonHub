<template>
  <Popover :open="shown.length > 0" @update:open="open = $event">
    <PopoverAnchor as-child>
      <Input
        v-bind="$attrs"
        :value="modelValue"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        :aria-expanded="shown.length > 0"
        :aria-controls="shown.length ? listId : undefined"
        :aria-activedescendant="shown.length && active >= 0 ? `${listId}-${active}` : undefined"
        @input="typed"
        @click="show"
        @keydown="key"
      />
    </PopoverAnchor>
    <PopoverContent class="w-[var(--reka-popover-trigger-width)] min-w-64 p-0" align="start" @open-auto-focus.prevent @close-auto-focus.prevent>
      <Command>
        <CommandList :id="listId" :aria-label="label">
          <CommandGroup>
            <CommandItem
              v-for="(option, index) in shown"
              :id="`${listId}-${index}`"
              :key="option.value"
              :value="option.value"
              :disabled="option.disabled"
              :class="{ 'bg-accent': active === index }"
              @mousedown.prevent
              @select="pick(option.value)"
            >
              <span>{{ option.label }}</span
              ><small v-if="option.note" class="ml-auto text-muted-foreground">{{ option.note }}</small>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
<script setup lang="ts">
import { computed, ref, useId } from "vue";

import type { PickerOption } from "../lib/picker";
import { Command, CommandList, CommandGroup, CommandItem } from "./ui/command";
import { Input } from "./ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";

/**
 * A text field with suggestions, in place of the browser's datalist popup: typing filters the
 * suggestions by value or label, and any other text stays allowed.
 */
defineOptions({ inheritAttrs: false });
const props = defineProps<{ modelValue: string | undefined; options: PickerOption[]; label: string; modelModifiers?: { trim?: true } }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const open = ref(false);
const filtering = ref(false);
const active = ref(-1);
const listId = useId();
const shown = computed(() => {
  if (!open.value) return [];
  const text = filtering.value ? (props.modelValue ?? "").trim().toLowerCase() : "";
  const matches = text ? props.options.filter((option) => `${option.value}\n${option.label}`.toLowerCase().includes(text)) : props.options;
  // Only the text already typed in full: nothing left to suggest.
  return matches.length === 1 && matches[0]!.value === props.modelValue ? [] : matches;
});
const set = (value: string) => emit("update:modelValue", props.modelModifiers?.trim ? value.trim() : value);
function show() {
  if (open.value) return;
  open.value = true;
  filtering.value = false;
  active.value = -1;
}
function typed(event: Event) {
  set((event.target as HTMLInputElement).value);
  open.value = true;
  filtering.value = true;
  active.value = -1;
}
function pick(value: string) {
  set(value);
  open.value = false;
}
function key(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!open.value) return show();
    const count = shown.value.length;
    const step = event.key === "ArrowDown" ? 1 : -1;
    if (count) active.value = active.value < 0 ? (step > 0 ? 0 : count - 1) : (active.value + step + count) % count;
  } else if (event.key === "Enter" && shown.value[active.value]) {
    event.preventDefault();
    pick(shown.value[active.value]!.value);
  } else if (event.key === "Escape" && shown.value.length) {
    event.preventDefault();
    open.value = false;
  }
}
</script>

<template>
  <div class="segmented" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="segment"
      :aria-pressed="modelValue === option.value"
      :disabled="disabled"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
<script setup lang="ts" generic="T extends string">
/** A pill track with the chosen option raised on it, as in Muse's 可用 / 已连接 switch. */
defineProps<{ modelValue: T; options: readonly { value: T; label: string }[]; label: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [T] }>();
</script>
<style scoped>
@reference "../../styles/app.css";

.segmented {
  display: inline-flex;
  flex: none;
  /* As its own row in a page grid it keeps its size instead of stretching across (user, 2026-11-23). */
  justify-self: start;
  width: fit-content;
  gap: 4px;
  max-width: 100%;
  padding: 4px;
  overflow-x: auto;
  border-radius: 999px;
  background: var(--group);
  scrollbar-width: none;
}
.segment {
  flex: none;
  height: 30px;
  padding: 0 16px;
  border-radius: 999px;
  color: var(--text-2);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background-color var(--t-fast) ease,
    color var(--t-fast) ease,
    box-shadow var(--t-fast) ease;
}
.segment:hover {
  color: var(--text);
}
.segment[aria-pressed="true"] {
  background: var(--control-thumb);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
  color: var(--text);
}
.segment:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.segment:disabled {
  opacity: 0.6;
}
</style>

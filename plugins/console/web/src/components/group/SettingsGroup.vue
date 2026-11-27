<template>
  <section class="settings-group" :aria-labelledby="title ? id : undefined" :aria-label="title ? undefined : label">
    <div v-if="title || $slots.actions" class="group-head">
      <h2 v-if="title" :id="id" class="group-title" :class="tone">
        <button v-if="collapsible" type="button" class="group-toggle" :aria-expanded="open" :aria-controls="`${id}-body`" @click="open = !open">
          {{ title }}<ChevronRight class="toggle-chevron" :class="{ open }" aria-hidden="true" />
        </button>
        <template v-else>{{ title }}</template>
        <slot name="badge" />
      </h2>
      <div v-if="$slots.actions" class="group-actions"><slot name="actions" /></div>
    </div>
    <Transition name="group-fold">
      <div v-if="!collapsible || open" :id="`${id}-body`" class="group-body" :class="{ plain }"><slot /></div>
    </Transition>
  </section>
</template>
<script lang="ts">
/** Ids for the headings; a plain counter, since the console renders only in the browser. */
let groups = 0;
</script>
<script setup lang="ts">
import { ChevronRight } from "reicon-vue";

/**
 * A titled group of rows: a small heading, then the rows on the page itself — no surface, borders, lines or shadows
 * (前端界面设计规范, 2026-11-26: no box in a box; hierarchy from type and spacing).
 */
defineProps<{
  title?: string;
  /** The group's accessible name when it has no visible title. */
  label?: string;
  /** Content laid out by the caller (a chart, a log) rather than rows: the surface without row spacing. */
  plain?: boolean;
  /** A group of things that need attention. */
  tone?: "danger";
  /** The title folds the rows away and back (`v-model:open`); only for a titled group. */
  collapsible?: boolean;
}>();
const open = defineModel<boolean>("open", { default: true });
const id = `settings-group-${++groups}`;
</script>
<style scoped>
@reference "../../styles/app.css";

.settings-group {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  min-width: 0;
}
.group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--text-2);
  font-size: 14px;
  font-weight: 600;
}
.group-title.danger {
  color: var(--danger);
}
.group-actions {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
.group-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: -4px -8px;
  padding: 4px 8px;
  border-radius: 8px;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.group-toggle:hover {
  background: var(--group-hover);
}
.group-toggle:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
.toggle-chevron {
  width: 16px;
  height: 16px;
  color: var(--text-3);
  transition: transform var(--t-fast) var(--ease-out);
}
.toggle-chevron.open {
  transform: rotate(90deg);
}
.group-fold-enter-active,
.group-fold-leave-active {
  transition:
    opacity var(--t-fast) var(--ease-out),
    transform var(--t-fast) var(--ease-out);
}
.group-fold-enter-from,
.group-fold-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .group-fold-enter-active,
  .group-fold-leave-active,
  .toggle-chevron {
    transition: none;
  }
}
/* Rows sit on the page; their padding hangs outside the column so their text lines up with the heading. */
.group-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  margin: 0 -16px;
}
.group-body.plain {
  margin: 8px 0 0;
}
.group-body :deep([data-slot="skeleton"]) {
  border-radius: 12px;
}
</style>

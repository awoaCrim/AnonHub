<template>
  <div class="group-row" :class="{ interactive, selected, 'has-icon': hasIcon }">
    <component :is="tag" v-bind="mainProps" class="row-main" @click="onMain">
      <span v-if="hasIcon" class="row-icon" :class="iconTone"
        ><slot name="icon"><component :is="icon" aria-hidden="true" /></slot
      ></span>
      <span class="row-text">
        <span class="row-title"
          ><span class="truncate">{{ title }}</span
          ><slot name="title"
        /></span>
        <span v-if="detail || $slots.detail" class="row-detail"
          ><slot name="detail">{{ detail }}</slot></span
        >
      </span>
      <span v-if="value" class="row-value" :class="tone" :title="value"
        ><span class="truncate">{{ value }}</span></span
      >
    </component>
    <div v-if="$slots.default" class="row-control"><slot /></div>
    <ChevronRight v-if="showChevron" class="row-chevron" aria-hidden="true" />
    <div v-if="$slots.below" class="row-below"><slot name="below" /></div>
  </div>
</template>
<script setup lang="ts">
import { ChevronRight } from "reicon-vue";
import { computed, useSlots, type Component } from "vue";
import type { RouteLocationRaw } from "vue-router";

/**
 * One row of a SettingsGroup: an icon, a title with a line under it, then a value, a control or a chevron.
 * A row with `to` is a link and one with `clickable` opens something (`open`); either way the whole row is the
 * target while a control in it keeps its own clicks.
 */
const props = withDefaults(
  defineProps<{
    title: string;
    detail?: string;
    /** Shown on the right, before any control. */
    value?: string;
    /** Colours a value that needs attention. */
    tone?: "ok" | "warn" | "danger" | "idle";
    icon?: Component;
    iconTone?: "ok" | "warn" | "danger" | "accent";
    to?: RouteLocationRaw;
    clickable?: boolean;
    selected?: boolean;
    /** Defaults to shown on links and clickable rows. */
    chevron?: boolean;
  }>(),
  // Explicit undefined: an absent boolean prop would otherwise read as false.
  { chevron: undefined, selected: undefined },
);
const emit = defineEmits<{ open: [] }>();
const slots = useSlots();
const interactive = computed(() => !!props.to || props.clickable);
const hasIcon = computed(() => !!props.icon || !!slots.icon);
const showChevron = computed(() => props.chevron ?? interactive.value);
// By name, so it resolves to the app's registered RouterLink (component tests render without a router).
const tag = computed(() => (props.to ? "RouterLink" : props.clickable ? "button" : "div"));
const mainProps = computed(() =>
  props.to ? { to: props.to } : props.clickable ? { type: "button", "aria-pressed": props.selected === undefined ? undefined : props.selected } : {},
);
function onMain() {
  if (props.clickable && !props.to) emit("open");
}
</script>
<style scoped>
@reference "../../styles/app.css";

.group-row {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: 16px;
  min-width: 0;
  min-height: 56px;
  padding: 12px 16px;
  border-radius: 12px;
  transition: background-color var(--t-fast) ease;
}
.group-row.has-icon {
  min-height: 64px;
}
.group-row.interactive:hover,
.group-row.selected {
  background: var(--group-hover);
}
.row-main {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  gap: 16px;
  /* The title keeps some room; a wide control moves under it instead of squeezing it away. */
  min-width: min(100%, 120px);
  color: inherit;
  text-align: left;
  text-decoration: none;
}
/* The whole row is the link or button; controls sit above this layer. */
.interactive .row-main::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
}
.interactive .row-main:focus-visible {
  outline: none;
}
.interactive .row-main:focus-visible::after {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.row-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--text);
}
.row-icon.ok {
  color: var(--ok);
}
.row-icon.warn {
  color: var(--warn);
}
.row-icon.danger {
  color: var(--danger);
}
.row-icon.accent {
  color: var(--accent-text);
}
.row-text {
  display: grid;
  flex: 1 1 0;
  gap: 4px;
  min-width: 0;
}
.row-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 16px;
  line-height: 1.4;
}
.row-detail {
  color: var(--text-3);
  font-size: 14px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.row-value {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 8px;
  max-width: 50%;
  min-width: 0;
  color: var(--text-2);
  font-size: 14px;
}
.row-value.danger {
  color: var(--danger);
}
.row-control {
  position: relative;
  z-index: 1;
  display: flex;
  flex: none;
  margin-left: auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
}
.row-chevron {
  flex: none;
  color: var(--text-3);
}
.row-below {
  position: relative;
  z-index: 1;
  flex: 1 0 100%;
  min-width: 0;
  padding-top: 12px;
}
.has-icon .row-below {
  padding-left: 40px;
}
@media (max-width: 640px) {
  .group-row {
    row-gap: 8px;
  }
  /* A text field or a field picker takes its own line under the title, as wide as the row: at its desktop width it
     wraps into a narrow box at the right (user, 2026-11-26, phone login: 「app的ui兼容还需要优化一下」). Switches,
     number boxes and compact menus stay beside the title. */
  .row-control:has(
    :is(input:not([type="checkbox"], [type="radio"], [type="number"], [type="range"], [aria-hidden="true"]), textarea, [data-slot="select-trigger"].w-full)
  ) {
    flex: 1 1 100%;
    flex-wrap: nowrap;
    margin-left: 0;
  }
  .row-control:has(
      :is(input:not([type="checkbox"], [type="radio"], [type="number"], [type="range"], [aria-hidden="true"]), textarea, [data-slot="select-trigger"].w-full)
    )
    > :deep(:first-child) {
    flex: 1 1 auto;
    width: auto;
    max-width: none;
    min-width: 0;
  }
  .row-value {
    max-width: 45%;
  }
  .has-icon .row-below {
    padding-left: 0;
  }
}
</style>

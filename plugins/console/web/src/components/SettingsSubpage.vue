<template>
  <!-- In the 设置 window: a page of the window under the breadcrumb, never a dialog over it. -->
  <Teleport v-if="host && open && host.target.value" :to="host.target.value">
    <section v-show="shown" class="subpage" :aria-label="title">
      <p v-if="description" class="subpage-description">{{ description }}</p>
      <slot />
      <footer v-if="$slots.footer" class="subpage-footer"><slot name="footer" /></footer>
    </section>
  </Teleport>
  <!-- Anywhere else (a page outside the window, a test): the dialog it always was. -->
  <Dialog v-else-if="!host" :open="open" @update:open="emit('update:open', $event)">
    <DialogContent :class="cn('max-h-[90dvh] overflow-y-auto', dialogClass)" v-bind="description ? {} : { 'aria-describedby': undefined }">
      <DialogHeader class="min-w-0 pr-6">
        <DialogTitle class="break-words">{{ title }}</DialogTitle>
        <DialogDescription v-if="description">{{ description }}</DialogDescription>
      </DialogHeader>
      <slot />
      <DialogFooter v-if="$slots.footer"><slot name="footer" /></DialogFooter>
    </DialogContent>
  </Dialog>
</template>
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, provide, ref, watch } from "vue";

import { cn } from "../lib/utils";
import { subpageHostKey, subpageKey } from "../shell/settings-subpages";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

/**
 * Something opened from a settings page: a service, a capability's settings, an editor. Inside the 设置 window it
 * is a page of the window, under a breadcrumb that leads back (user, 2026-11-23: 「那种配置页面最忌弹窗套弹窗了」);
 * elsewhere it is a dialog. Its owner keeps `open` and closes it on `update:open` false, which the breadcrumb and Esc
 * ask for.
 */
const props = defineProps<{
  open: boolean;
  /** The breadcrumb's last part (or the dialog's title). */
  title: string;
  description?: string;
  /** The dialog's width classes, outside the window. */
  dialogClass?: string;
}>();
const emit = defineEmits<{ "update:open": [boolean] }>();
const host = inject(subpageHostKey, null);
const close = () => emit("update:open", false);
if (host) provide(subpageKey, { close });

const id = ref<number>();
function leave() {
  if (id.value !== undefined) host?.remove(id.value);
  id.value = undefined;
}
if (host)
  watch(
    () => props.open,
    (open) => {
      if (open && id.value === undefined) id.value = host.open(() => props.title, close);
      else if (!open) leave();
    },
    { immediate: true },
  );
onBeforeUnmount(leave);
/** Only the innermost open subpage shows; the ones under it keep their state. */
const shown = computed(() => id.value !== undefined && host?.stack.at(-1)?.id === id.value);
</script>
<style scoped>
@reference "../styles/app.css";

/* UI-EXCEPTION settings-subpage: a page of the 设置 window, laid out as the category pages are. */
.subpage {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  gap: 28px;
  min-width: 0;
  animation: subpage-in var(--t-mid) var(--ease-out);
}
.subpage-description {
  @apply text-sm text-muted-foreground;
  margin-top: -16px;
}
.subpage-footer {
  @apply sticky bottom-4 z-10 rounded-xl border bg-card p-3 shadow-lg;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
@keyframes subpage-in {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
}
</style>

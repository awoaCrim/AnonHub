<template>
  <!-- In the 设置 window it opens as a page of the window. -->
  <SettingsSubpage v-if="host" :open="open" :title="title" :description="description" @update:open="emit('update:open', $event)"
    ><slot /><template v-if="$slots.footer" #footer><slot name="footer" /></template
  ></SettingsSubpage>
  <Sheet v-else-if="phone" :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="bottom" class="max-h-[90dvh] gap-0 overflow-hidden rounded-t-2xl">
      <!-- The sheet's inside scrolls, so its close button stays in the corner. -->
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <SheetHeader class="px-4 pr-12">
          <SheetTitle class="text-lg leading-snug break-all">{{ title }}</SheetTitle>
          <SheetDescription v-if="description">{{ description }}</SheetDescription>
        </SheetHeader>
        <div class="px-4 pb-2"><slot /></div>
        <SheetFooter v-if="$slots.footer" class="pt-2"><slot name="footer" /></SheetFooter>
      </div>
    </SheetContent>
  </Sheet>
  <Dialog v-else :open="open" @update:open="emit('update:open', $event)">
    <DialogContent :class="cn('max-h-[90dvh]', wide ? 'sm:max-w-2xl' : 'sm:max-w-lg')">
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
import { useMediaQuery } from "@vueuse/core";
import { inject } from "vue";

import { cn } from "../lib/utils";
import { subpageHostKey } from "../shell/settings-subpages";
import SettingsSubpage from "./SettingsSubpage.vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "./ui/sheet";

/** A form or setup step that leaves the page as an overview: a centred dialog, a bottom sheet on a phone. */
defineProps<{ open: boolean; title: string; description?: string; wide?: boolean }>();
const emit = defineEmits<{ "update:open": [boolean] }>();
const phone = useMediaQuery("(max-width: 640px)");
const host = inject(subpageHostKey, null);
</script>

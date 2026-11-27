<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { X } from "reicon-vue";
import type { DialogContentEmits, DialogContentProps } from "reka-ui";
import { DialogClose, DialogContent, DialogPortal, useForwardPropsEmits } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { cn } from "../../../lib/utils";
import { Button } from "../button";
import SheetOverlay from "./SheetOverlay.vue";

interface SheetContentProps extends DialogContentProps {
  class?: HTMLAttributes["class"];
  side?: "top" | "right" | "bottom" | "left";
  /** The content brings its own close button. */
  hideClose?: boolean;
}

defineOptions({
  inheritAttrs: false,
});

const props = withDefaults(defineProps<SheetContentProps>(), {
  side: "right",
});
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = reactiveOmit(props, "class", "side", "hideClose");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <DialogPortal>
    <SheetOverlay />
    <DialogContent
      data-slot="sheet-content"
      :class="
        cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-200 data-[state=open]:duration-250',
          side === 'right' &&
            'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm',
          side === 'left' && 'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm',
          side === 'top' && 'data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b',
          side === 'bottom' && 'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto border-t',
          props.class,
        )
      "
      v-bind="{ ...$attrs, ...forwarded }"
    >
      <slot />

      <!-- The same round button as dialogs; a sheet that scrolls keeps it reachable by scrolling an inner part. -->
      <DialogClose v-if="!hideClose" as-child>
        <Button variant="ghost" size="icon-sm" data-slot="sheet-close" class="absolute top-3 right-3 rounded-full bg-background/90 backdrop-blur-sm">
          <X class="size-4" />
          <span class="sr-only">关闭</span>
        </Button>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>

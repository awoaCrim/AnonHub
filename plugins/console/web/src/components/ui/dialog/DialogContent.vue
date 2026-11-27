<script setup lang="ts">
import { reactiveOmit } from "@vueuse/core";
import { X } from "reicon-vue";
import type { DialogContentEmits, DialogContentProps } from "reka-ui";
import { DialogClose, DialogContent, DialogPortal, useForwardPropsEmits } from "reka-ui";
import type { HTMLAttributes } from "vue";

import { DialogLayer } from "../../../lib/dialog-layers";
import { cn } from "../../../lib/utils";
import { Button } from "../button";
import DialogOverlay from "./DialogOverlay.vue";

defineOptions({
  inheritAttrs: false,
});

/**
 * `class` styles the dialog's box, which also scrolls; the close button sits outside the scrolling part, so it stays
 * in the corner however far the dialog is scrolled (user, 2026-11-20: 「关闭按钮样式不统一…我滚到下面后不能直接关闭，还得
 * 滚上去」). The positioned frame shrinks to the box and is centred on the screen.
 */
const props = withDefaults(defineProps<DialogContentProps & { class?: HTMLAttributes["class"]; showCloseButton?: boolean }>(), {
  showCloseButton: true,
});
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = reactiveOmit(props, "class");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent
      data-slot="dialog-content"
      v-bind="{ ...$attrs, ...forwarded }"
      class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed inset-0 z-50 m-auto h-fit w-fit duration-200 focus:outline-hidden"
    >
      <DialogLayer />
      <div
        data-slot="dialog-body"
        :class="
          cn(
            'bg-background grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] gap-4 overflow-y-auto overscroll-contain rounded-lg border p-6 shadow-lg *:min-w-0 sm:max-w-lg',
            props.class,
          )
        "
      >
        <slot />
      </div>

      <DialogClose v-if="showCloseButton" as-child>
        <Button variant="ghost" size="icon-sm" data-slot="dialog-close" class="absolute top-3 right-3 rounded-full bg-background/90 backdrop-blur-sm">
          <X class="size-4" />
          <span class="sr-only">关闭</span>
        </Button>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>

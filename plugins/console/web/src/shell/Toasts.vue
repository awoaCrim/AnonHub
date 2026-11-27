<template>
  <ToastProvider>
    <Toast
      v-for="item in toasts"
      :key="item.id"
      :open="true"
      :duration="item.duration"
      :variant="item.tone === 'danger' ? 'destructive' : item.tone === 'warn' ? 'warn' : 'default'"
      @update:open="!$event && dismissToast(item.id)"
    >
      <Icon :name="item.tone === 'ok' ? 'check' : 'close'" class="size-4 shrink-0" />
      <ToastTitle class="min-w-0 flex-1 break-words text-sm">{{ item.text }}</ToastTitle>
      <ToastAction v-if="item.action" as-child :alt-text="item.action.label"
        ><Button variant="outline" size="sm" class="rounded-full" @click="runAction(item.id, item.action.run)">{{ item.action.label }}</Button></ToastAction
      >
      <ToastClose as-child
        ><Button variant="ghost" size="icon-sm" aria-label="关闭通知" @click="dismissToast(item.id)"><Icon name="close" /></Button
      ></ToastClose>
    </Toast>
    <ToastViewport class="fixed top-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:top-4 sm:right-4 sm:max-w-sm" />
  </ToastProvider>
</template>
<script setup lang="ts">
import { onBeforeUnmount } from "vue";

import { Button } from "../components/ui/button";
import { Toast, ToastAction, ToastProvider, ToastViewport, ToastTitle, ToastClose } from "../components/ui/toast";
import { dismissToast, toasts } from "../lib/toast";
import Icon from "./Icon.vue";

function runAction(id: number, run: () => void) {
  dismissToast(id);
  run();
}
onBeforeUnmount(() => toasts.splice(0));
</script>

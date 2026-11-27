<template>
  <AlertDialog :open="!!request" @update:open="(open) => !open && settleConfirm(false)">
    <AlertDialogContent v-if="request" class="sm:max-w-md" @open-auto-focus="focusFirst">
      <form class="grid gap-4" @submit.prevent="typed && settleConfirm(true)">
        <AlertDialogHeader>
          <AlertDialogTitle>{{ request.title }}</AlertDialogTitle>
          <AlertDialogDescription v-if="request.message">{{ request.message }}</AlertDialogDescription>
        </AlertDialogHeader>
        <div v-if="request.typeToConfirm" class="grid gap-2">
          <Label for="confirm-typed"
            ><span
              >输入 <strong class="font-mono font-semibold">{{ request.typeToConfirm }}</strong> 确认</span
            ></Label
          >
          <Input id="confirm-typed" v-model="answer" autocomplete="off" autocapitalize="off" spellcheck="false" />
        </div>
        <AlertDialogFooter>
          <Button type="button" variant="outline" @click="settleConfirm(false)">{{ request.cancelLabel ?? "取消" }}</Button>
          <Button type="submit" :variant="request.danger ? 'destructive' : 'default'" :disabled="!typed">{{ request.confirmLabel ?? "确定" }}</Button>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  </AlertDialog>
</template>
<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { pendingConfirm as request, settleConfirm } from "../lib/dialog";

const answer = ref("");
const typed = computed(() => !request.value?.typeToConfirm || answer.value.trim() === request.value.typeToConfirm);
watch(request, () => (answer.value = ""));

/** Destructive choices start on Cancel (or the name to type) so Enter never discards by accident. */
function focusFirst(event: Event) {
  event.preventDefault();
  const content = (event.target as HTMLElement | null) ?? document.body;
  const value = request.value;
  const target = value?.typeToConfirm
    ? content.querySelector<HTMLElement>("#confirm-typed")
    : content.querySelector<HTMLElement>(value?.danger ? 'button[type="button"]' : 'button[type="submit"]');
  target?.focus();
}
</script>

<template>
  <Dialog :open="!!record" @update:open="(open) => !open && emit('close')">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-3xl" @close-auto-focus="emit('close-auto-focus', $event)">
      <template v-if="record">
        <DialogHeader class="pr-6">
          <DialogTitle>记录详情</DialogTitle>
          <DialogDescription class="break-words [overflow-wrap:anywhere]">{{ record.label }} · {{ formatTime(record.timestamp, "second") }}</DialogDescription>
        </DialogHeader>
        <section v-for="(section, index) in record.sections" :key="index" class="min-w-0 space-y-2">
          <h3 class="text-sm font-medium">{{ section.title }}</h3>
          <pre
            class="whitespace-pre-wrap break-words rounded-[14px] bg-group p-4 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]"
            :class="{ 'text-destructive': section.error }"
            >{{ section.text }}</pre>
        </section>
      </template>
    </DialogContent>
  </Dialog>
</template>
<script setup lang="ts">
import type { ConversationRecordDetail } from "../lib/conversation-record";
import { formatTime } from "../lib/format";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

defineProps<{ record?: ConversationRecordDetail }>();
const emit = defineEmits<{ close: []; "close-auto-focus": [event: Event] }>();
</script>

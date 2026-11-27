<template>
  <Dialog :open="true" @update:open="(open) => !open && emit('close')">
    <DialogContent class="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" @close-auto-focus="emit('close-auto-focus', $event)">
      <DialogHeader class="shrink-0 border-b px-5 py-4 pr-12 text-left sm:px-6">
        <DialogTitle>{{ selected ? "执行详情" : "执行记录" }}</DialogTitle>
        <DialogDescription class="break-words text-sm [overflow-wrap:anywhere]">{{ task.title }}</DialogDescription>
      </DialogHeader>
      <div ref="content" class="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
        <div class="mb-4 flex items-center justify-between gap-3">
          <Button v-if="selected" variant="ghost" size="sm" @click="back"><ArrowLeft class="size-4" />全部记录</Button>
          <span v-else />
          <Button variant="ghost" size="icon-sm" aria-label="刷新执行记录" :disabled="state.loading" @click="refresh">
            <RefreshCw class="size-4" :class="{ 'animate-spin': state.loading }" />
          </Button>
        </div>
        <Alert v-if="state.error" variant="destructive" class="mb-4">
          <div class="min-w-0 flex-1 space-y-2">
            <p role="alert">{{ state.error }}<span v-if="state.runs.length"> 以下保留上次读取的记录。</span></p>
            <Button variant="outline" size="sm" :disabled="state.loading" @click="state.failedMore ? history.retry() : refresh()">重试</Button>
          </div>
        </Alert>
        <section v-if="selected" class="space-y-5" aria-label="本次执行详情">
          <div class="flex items-start gap-3 rounded-lg border p-4">
            <component :is="iconFor(selected)" class="mt-1 size-5 shrink-0" :class="tone(selected)" />
            <div class="min-w-0 space-y-1">
              <h3 class="text-sm font-medium">{{ runLabel(selected) }}</h3>
              <p class="text-sm leading-relaxed text-muted-foreground">{{ runDescription(selected) }}</p>
            </div>
          </div>
          <dl class="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-muted-foreground">计划时间</dt>
              <dd class="mt-1 tabular-nums">{{ formatScheduleTime(selected.occurrenceAt, true) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">执行耗时</dt>
              <dd class="mt-1 tabular-nums">{{ runDuration(selected) }}</dd>
            </div>
            <div v-if="selected.queuedAt">
              <dt class="text-muted-foreground">进入队列</dt>
              <dd class="mt-1 tabular-nums">{{ formatScheduleTime(selected.queuedAt, true) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">开始执行</dt>
              <dd class="mt-1 tabular-nums">{{ selected.startedAt ? formatScheduleTime(selected.startedAt, true) : "未记录" }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">{{ selected.error?.code === "process_interrupted" ? "发现中断" : "结束时间" }}</dt>
              <dd class="mt-1 tabular-nums">
                {{ selected.finishedAt ? formatScheduleTime(selected.finishedAt, true) : runInProgress(selected) ? "尚未结束" : "未记录" }}
              </dd>
            </div>
            <div v-if="selected.notified !== undefined">
              <dt class="text-muted-foreground">消息通知</dt>
              <dd class="mt-1">{{ selected.notified ? "已发送" : "未发送" }}</dd>
            </div>
          </dl>
          <section v-if="selected.error" class="space-y-2">
            <h3 class="text-sm font-medium">原因</h3>
            <p class="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed [overflow-wrap:anywhere]">
              {{ selected.error.message }}
            </p>
          </section>
        </section>
        <template v-else>
          <p v-if="!state.loaded && state.loading" class="py-12 text-center text-sm text-muted-foreground" role="status">正在读取执行记录…</p>
          <div v-else-if="state.loaded && !state.runs.length" class="rounded-lg border border-dashed px-5 py-10 text-center">
            <History class="mx-auto mb-3 size-6 text-muted-foreground" />
            <p class="text-sm font-medium">暂无执行记录</p>
          </div>
          <div v-else-if="state.runs.length" class="divide-y overflow-hidden rounded-lg border" aria-label="执行记录列表">
            <button
              v-for="run in state.runs"
              :key="run.id"
              :data-run-id="run.id"
              type="button"
              class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              @click="openRun(run)"
            >
              <component :is="iconFor(run)" class="size-4 shrink-0" :class="tone(run)" />
              <span class="min-w-0 flex-1 space-y-1">
                <span class="block text-sm font-medium tabular-nums">{{ formatScheduleTime(run.occurrenceAt) }}</span>
                <span class="block text-sm text-muted-foreground">{{ runLabel(run) }}</span>
              </span>
              <span v-if="runDuration(run) !== '—'" class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ runDuration(run) }}</span>
              <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
            </button>
          </div>
          <div v-if="state.nextCursor" class="mt-4 flex justify-center">
            <Button variant="outline" size="sm" :disabled="state.loading" @click="history.more()">{{
              state.loadingMore ? "正在加载…" : "加载更早记录"
            }}</Button>
          </div>
        </template>
      </div>
      <footer v-if="!selected && state.runs.length" class="shrink-0 border-t px-5 py-3 text-xs text-muted-foreground sm:px-6">
        保留最近 {{ state.retainedLimit }} 条已结束记录
      </footer>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import {
  ArrowLeft,
  Check,
  ChevronRight,
  HelpCircle as CircleHelp,
  Clock as Clock3,
  History,
  Loader as LoaderCircle,
  Refresh as RefreshCw,
  SkipNext as SkipForward,
  Stop as Square,
  Danger as TriangleAlert,
} from "reicon-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { ScheduledTask, ScheduleRun } from "../../../src/shared/schedules";
import { formatScheduleTime, runDescription, runDuration, runInProgress, runLabel } from "../lib/schedule-runs";
import { createScheduleRunHistory } from "../state/schedule-runs";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const props = defineProps<{ task: ScheduledTask }>();
const emit = defineEmits<{ close: []; "close-auto-focus": [event: Event] }>();
const history = createScheduleRunHistory();
const { state } = history;
const content = ref<HTMLElement>();
const selectedRun = ref<ScheduleRun>();
const selected = computed(() => state.runs.find((run) => run.id === selectedRun.value?.id) ?? selectedRun.value);
let listScroll = 0;
function openRun(run: ScheduleRun) {
  listScroll = content.value?.scrollTop ?? 0;
  selectedRun.value = run;
  void nextTick(() => {
    content.value?.scrollTo({ top: 0 });
    content.value?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  });
}
async function back() {
  const id = selectedRun.value?.id;
  selectedRun.value = undefined;
  await nextTick();
  if (!content.value) return;
  content.value.scrollTop = listScroll;
  [...content.value.querySelectorAll<HTMLButtonElement>("[data-run-id]")].find((button) => button.dataset.runId === id)?.focus({ preventScroll: true });
}
async function refresh() {
  const id = selectedRun.value?.id;
  const taskId = props.task.id;
  await history.refresh();
  if (!id || taskId !== props.task.id || selectedRun.value?.id !== id || state.error) return;
  // Do not reopen a dismissed detail or keep an older run's stale status after a fresh read.
  selectedRun.value = state.runs.find((run) => run.id === id);
  if (!selectedRun.value) {
    await nextTick();
    content.value?.scrollTo({ top: 0 });
    content.value?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }
}
function iconFor(run: ScheduleRun) {
  return {
    queued: Clock3,
    running: LoaderCircle,
    accepted: CircleHelp,
    completed: Check,
    undelivered: CircleHelp,
    failed: TriangleAlert,
    missed: SkipForward,
    interrupted: Square,
  }[run.status];
}
function tone(run: ScheduleRun) {
  if (run.status === "failed") return "text-destructive";
  if (run.status === "running") return "animate-spin text-primary";
  return "text-muted-foreground";
}
watch(
  () => props.task.id,
  (id) => {
    selectedRun.value = undefined;
    void history.open(id);
  },
  { immediate: true },
);
let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  poll = setInterval(() => {
    if (!document.hidden && !state.loading && !state.error && state.pages === 1 && state.runs.some(runInProgress)) void refresh();
  }, 10_000);
});
onBeforeUnmount(() => {
  clearInterval(poll);
  history.dispose();
});
</script>

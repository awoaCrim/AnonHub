<template>
  <section ref="taskList" class="tasks intent-scope" :aria-label="instanceWide ? '我的定时计划' : '本会话定时任务'" :aria-busy="loading">
    <header class="tasks-head">
      <h3 class="text-lg font-semibold">计划</h3>
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        class="intent-target rounded-full text-muted-foreground"
        aria-label="刷新定时任务"
        :disabled="loading || !!editing || !!deleting"
        @click="load"
        ><RefreshCw class="size-4" :class="{ 'animate-spin': loading }"
      /></Button>
    </header>
    <Alert v-if="!enabled" variant="warn" as="p">定时任务已关闭，任务不会执行。</Alert>
    <Alert v-if="error && !selected" variant="destructive" as="p" role="alert"
      >{{ error }}<span v-if="snapshot?.available"> 以下是上次加载的列表。</span></Alert
    >
    <LoadingRows v-if="!snapshot && loading" label="正在读取计划" />
    <p v-else-if="snapshot && !snapshot.available" class="arrive px-2 text-sm text-muted-foreground">暂不可用</p>
    <p v-else-if="snapshot?.available && !tasks.length" class="arrive px-2 text-sm text-muted-foreground">暂无计划</p>
    <LimitedList
      v-else-if="snapshot?.available"
      v-model:open="allOpen"
      class="arrive"
      :items="tasks"
      :button-label="`查看全部 ${tasks.length} 项计划…`"
      :dialog-title="`全部计划 · ${tasks.length}`"
    >
      <template #row="{ item: task }">
        <button type="button" class="side-row" :disabled="!!deleting" @click="openTask(task, $event)">
          <span class="side-row-icon"><component :is="task.purpose === 'heartbeat' ? HeartPulse : CalendarClock" class="size-4" /></span>
          <span class="min-w-0 flex-1"
            ><strong class="side-row-title">{{ task.title }}</strong
            ><span class="side-row-meta"
              ><span>{{ states[task.state] ?? task.state }}</span
              ><span class="truncate">{{ task.kind === "cron" ? rule(task) : task.nextRunAt ? time(task.nextRunAt) : rule(task) }}</span></span
            ><span v-if="instanceWide" class="side-row-meta truncate">{{ destination(task) }}</span></span
          >
        </button>
      </template>
    </LimitedList>
    <p v-if="tasks.length" class="px-2 text-xs text-muted-foreground">时间为北京时间（UTC+8）</p>
    <Dialog :open="!!selected" @update:open="updateOpen">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" :aria-describedby="undefined" @close-auto-focus="restoreFocus">
        <template v-if="selected">
          <DialogHeader class="pr-6"
            ><DialogTitle class="break-words leading-snug">{{ editing ? "修改计划" : selected.title }}</DialogTitle></DialogHeader
          >
          <Alert v-if="error" variant="destructive" as="p" role="alert">{{ error }}</Alert>
          <ScheduleEditor v-if="editing === selected.id" :key="selected.id" ref="scheduleEditor" :task="selected" @saved="saved" @cancel="cancelEditing" />
          <template v-else>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <p class="text-xs text-muted-foreground">{{ states[selected.state] ?? selected.state }} · 北京时间（UTC+8）</p>
              <Button variant="outline" size="sm" @click="openRuns"><History class="size-4" />执行记录</Button>
            </div>
            <dl class="task-meta">
              <div>
                <dt>执行计划</dt>
                <dd>{{ rule(selected) }}</dd>
              </div>
              <div>
                <dt>下次执行</dt>
                <dd>{{ selected.nextRunAt ? time(selected.nextRunAt) : "—" }}</dd>
              </div>
              <div>
                <dt>所属会话</dt>
                <dd>
                  {{ platformLabel(selected.platform) }} · {{ selected.type === "direct" ? "私聊" : selected.type === "shared" ? "共享会话" : "群聊" }}
                  {{ displayChannelId(selected.platform, selected.channelId) }}
                </dd>
              </div>
              <div>
                <dt>机器人</dt>
                <dd>{{ selected.selfId }}</dd>
              </div>
              <div v-if="selected.lastResult">
                <dt>最近触发</dt>
                <dd>{{ time(selected.lastResult.occurrenceAt) }} · {{ outcome(selected) }}</dd>
              </div>
              <div>
                <dt>{{ selected.purpose === "heartbeat" ? "心跳方式" : "发送方式" }}</dt>
                <dd>
                  {{
                    selected.purpose === "heartbeat"
                      ? selected.delivery === "silent"
                        ? "静默（检查过程不显示）"
                        : "显式（在对话里唤醒）"
                      : selected.delivery === "silent"
                        ? "静默执行"
                        : "发送到会话"
                  }}
                </dd>
              </div>
            </dl>
            <p v-if="selected.purpose === 'heartbeat'" class="text-xs text-muted-foreground">心跳检查 · 有值得告诉你的事才发消息，没事保持安静</p>
            <section class="space-y-2">
              <h4 class="text-sm font-medium">任务内容</h4>
              <p class="task-prompt">{{ selected.prompt }}</p>
            </section>
            <section v-if="selected.notes" class="space-y-2">
              <h4 class="text-sm font-medium">做法记录</h4>
              <p class="task-prompt">{{ selected.notes }}</p>
            </section>
            <div class="flex justify-end gap-2">
              <Button
                v-if="selected.state === 'enabled' || selected.state === 'paused'"
                type="button"
                variant="outline"
                size="sm"
                :disabled="!enabled || !!editing || !!deleting || loading"
                @click="editing = selected.id"
                >修改计划</Button
              >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="text-destructive hover:text-destructive"
                :disabled="!enabled || !!editing || !!deleting || loading"
                @click="remove(selected)"
                >{{ deleting === selected.id ? "删除中…" : "删除" }}</Button
              >
            </div>
          </template>
        </template>
      </DialogContent>
    </Dialog>
    <ScheduleRunHistory v-if="selected && runsOpen" :task="selected" @close="runsOpen = false" @close-auto-focus="restoreRunsFocus" />
  </section>
</template>
<script setup lang="ts">
import { displayChannelId, platformLabel } from "@yesimbot/contracts/platforms";
import { Calendar as CalendarClock, HeartPulse, History, Refresh as RefreshCw } from "reicon-vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import type { ScheduledTask, SchedulesSnapshot } from "../../../src/shared/schedules";
import { api, ApiError } from "../lib/api";
import { confirmDialog } from "../lib/dialog";
import { formatScheduleTime as time } from "../lib/schedule-runs";
import { toast } from "../lib/toast";
import LimitedList from "./LimitedList.vue";
import LoadingRows from "./LoadingRows.vue";
import ScheduleEditor from "./ScheduleEditor.vue";
import ScheduleRunHistory from "./ScheduleRunHistory.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

const props = withDefaults(defineProps<{ enabled?: boolean; scope: { platform: string; selfId?: string; channelId: string; type: string } }>(), {
  enabled: true,
});
const emit = defineEmits<{ dirty: [value: boolean] }>();
const taskList = ref<HTMLElement>(),
  selectedId = ref(""),
  scheduleEditor = ref<{ cancel(): Promise<void> }>(),
  editing = ref("");
const deleting = ref("");
const allOpen = ref(false);
const runsOpen = ref(false);
let runsTrigger: HTMLElement | undefined;
watch(selectedId, () => (runsOpen.value = false));
function openRuns(event: MouseEvent) {
  runsTrigger = event.currentTarget as HTMLElement;
  runsOpen.value = true;
}
function restoreRunsFocus(event: Event) {
  event.preventDefault();
  if (runsTrigger?.isConnected) runsTrigger.focus();
}
watch(editing, (value) => emit("dirty", !!value));
const snapshot = ref<SchedulesSnapshot>();
// The signed-in web owner manages this instance. Other conversation views stay scoped.
const instanceWide = computed(() => props.scope.platform === "web");
/** Newest first by creation time, else last edit; plans from an older server without either keep the server's order, after dated ones. */
const recentness = (task: ScheduledTask) => Date.parse(task.createdAt ?? task.updatedAt ?? "") || 0;
const tasks = computed(() =>
  (snapshot.value?.tasks ?? [])
    .filter(
      (task) =>
        instanceWide.value ||
        (task.platform === props.scope.platform &&
          task.selfId === props.scope.selfId &&
          task.channelId === props.scope.channelId &&
          task.type === props.scope.type),
    )
    .sort((a, b) => recentness(b) - recentness(a)),
);
const selected = computed(() => tasks.value.find((task) => task.id === selectedId.value));
let lastTrigger: HTMLElement | undefined,
  closing = false;
function openTask(task: ScheduledTask, event?: MouseEvent) {
  if (deleting.value || editing.value) return;
  lastTrigger = event?.currentTarget as HTMLElement | undefined;
  allOpen.value = false;
  selectedId.value = task.id;
}
/** Closing never saves and never asks: an open edit is dropped with the dialog unless it is being saved. */
async function updateOpen(open: boolean) {
  if (open || closing || deleting.value) return;
  if (editing.value) {
    closing = true;
    try {
      await scheduleEditor.value?.cancel();
    } finally {
      closing = false;
    }
  } else selectedId.value = "";
}
function cancelEditing() {
  editing.value = "";
  if (closing) selectedId.value = "";
}
function restoreFocus(event: Event) {
  event.preventDefault();
  const target = lastTrigger?.isConnected ? lastTrigger : taskList.value?.querySelector<HTMLElement>("button:not(:disabled)");
  target?.focus();
}
const loading = ref(false);
const error = ref("");
let generation = 0;
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  emit("dirty", false);
});

const states = { enabled: "已启用", paused: "已暂停", completed: "已完成", cancelled: "已取消" };
// `accepted` predates reported outcomes: submitted, result unknown.
const results = {
  submitting: "正在执行",
  accepted: "结果未知",
  completed: "已结束",
  undelivered: "未发送回复",
  failed: "执行失败",
  missed: "已错过",
  interrupted: "已中断",
};
function outcome(task: ScheduledTask): string {
  const last = task.lastResult;
  if (!last) return "";
  return task.purpose === "heartbeat" && last.status === "completed" && last.notified !== undefined
    ? last.notified
      ? "已通知"
      : "检查完成，无需通知"
    : (results[last.status] ?? last.status);
}
function rule(task: ScheduledTask): string {
  if (task.kind === "once") return `仅一次 · ${task.at ? time(task.at) : "—"}`;
  const interval = /^\*\/(\d+) \* \* \* \*$/.exec(task.cron ?? "");
  const minutes = Number(interval?.[1]);
  if (minutes > 0 && minutes < 60 && 60 % minutes === 0) return `每 ${minutes} 分钟`;
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(task.cron ?? "");
  return daily ? `每天 ${daily[2].padStart(2, "0")}:${daily[1].padStart(2, "0")}` : `重复 · ${task.cron ?? "—"}`;
}
function destination(task: ScheduledTask): string {
  if (task.platform === "web") return "网页对话";
  const kind = task.type === "direct" ? "私聊" : task.type === "shared" ? "共享会话" : "群聊";
  return `${platformLabel(task.platform)} · ${kind} ${displayChannelId(task.platform, task.channelId)}`;
}

async function load() {
  const token = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await api<SchedulesSnapshot>("/yesimbot/api/v1/schedules", undefined, { fresh: true });
    if (!disposed && token === generation) snapshot.value = result;
  } catch {
    if (!disposed && token === generation) error.value = "定时任务加载失败，请点击刷新重试。";
  } finally {
    if (!disposed && token === generation) loading.value = false;
  }
}
/**
 * What this list is about, as one value. The chat page hands over a new scope object with every chat update; only a
 * real change of subject may clear the list or close an open plan (user, 2026-11-19: reading a plan got kicked out).
 * The web owner sees the whole instance, so moving between web conversations changes nothing here.
 */
const subject = computed(() =>
  JSON.stringify(
    instanceWide.value ? [props.enabled, "web"] : [props.enabled, props.scope.platform, props.scope.selfId, props.scope.channelId, props.scope.type],
  ),
);
watch(
  subject,
  () => {
    snapshot.value = undefined;
    editing.value = "";
    selectedId.value = "";
    void load();
  },
  { immediate: true },
);

async function saved(task?: ScheduledTask) {
  editing.value = "";
  // The dialog closes once the plan is saved.
  selectedId.value = "";
  toast("定时任务已保存。");
  const list = snapshot.value?.tasks;
  const index = task && list ? list.findIndex((item) => item.id === task.id) : -1;
  // Replace only the saved row. A row this view does not list (another scope, or a raced refresh) is never inserted here.
  if (task && list && index >= 0) list[index] = task;
  else await load();
}
async function remove(task: ScheduledTask) {
  if (deleting.value || editing.value) return;
  deleting.value = task.id;
  try {
    if (
      !(await confirmDialog({
        title: `删除「${task.title}」？`,
        message: "计划和执行记录将一并删除，已提交的执行不受影响。此操作无法撤销。",
        confirmLabel: "删除任务",
        danger: true,
      })) ||
      disposed
    )
      return;
    const result = await api<{ ok: boolean }>("/yesimbot/api/v1/schedules/delete", { id: task.id, revision: task.revision });
    if (result?.ok !== true) throw new Error("unconfirmed");
    if (disposed) return;
    if (snapshot.value) snapshot.value.tasks = snapshot.value.tasks.filter((item) => item.id !== task.id);
    if (selectedId.value === task.id) selectedId.value = "";
    toast("定时任务已删除。");
  } catch (cause) {
    if (!disposed)
      toast(
        cause instanceof ApiError && cause.code === "schedule_changed" ? "任务已被修改或触发，请刷新后重新确认删除。" : "删除未能确认，请刷新列表检查后重试。",
        "danger",
      );
  } finally {
    if (!disposed) deleting.value = "";
  }
}
</script>

<style scoped>
@reference "../styles/app.css";
.tasks {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.tasks-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.task-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
  font-size: 0.875rem;
}
.task-meta dt {
  @apply text-muted-foreground;
}
.task-meta dd {
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.task-prompt {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.875rem;
  line-height: 1.7;
}
@media (max-width: 640px) {
  .task-meta {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

<template>
  <form class="schedule-editor" @submit.prevent="save">
    <label v-if="task.platform === 'onebot' || (task.platform === 'web' && task.type === 'direct')" class="field"
      >任务用途<PickerMenu v-model="form.purpose" field :options="PURPOSE_OPTIONS" :disabled="busy"
    /></label>
    <label class="field">任务标题<Input v-model="form.title" required maxlength="120" :disabled="busy" /></label>
    <div class="plan-fields">
      <label class="field"
        >执行计划
        <PickerMenu
          v-model="form.mode"
          field
          :options="form.purpose === 'heartbeat' ? MODE_OPTIONS.filter((option) => option.value !== 'once') : MODE_OPTIONS"
          :disabled="busy || terminal"
        />
      </label>
      <!-- Site pickers instead of the browser's time and date inputs: same height and look as every other field. -->
      <label v-if="form.mode === 'once'" class="field"
        >日期<PickerMenu v-model="onceDate" field :options="dateOptions" placeholder="选择日期" required :disabled="busy || terminal"
      /></label>
      <div v-if="form.mode !== 'cron'" class="field" role="group" aria-label="时间（北京时间）">
        <span>时间（北京时间）</span>
        <span class="time-pick"
          ><PickerMenu v-model="hour" field label="时" :options="HOUR_OPTIONS" :disabled="busy || terminal" /><span class="colon" aria-hidden="true">:</span
          ><PickerMenu v-model="minute" field label="分" :options="MINUTE_OPTIONS" :disabled="busy || terminal"
        /></span>
      </div>
      <label v-else class="field">Cron 表达式<Input v-model="form.cron" required maxlength="200" :disabled="busy || terminal" placeholder="0 9 * * *" /></label>
    </div>
    <label class="field">任务内容<Textarea v-model="form.prompt" required maxlength="2000" rows="8" :disabled="busy"></Textarea></label>
    <label class="field">做法记录<Textarea v-model="form.notes" maxlength="2000" rows="4" :disabled="busy"></Textarea></label>
    <label class="field"
      >{{ form.purpose === "heartbeat" ? "心跳方式" : "发送方式"
      }}<PickerMenu v-model="form.delivery" field :options="form.purpose === 'heartbeat' ? HEARTBEAT_DELIVERY_OPTIONS : DELIVERY_OPTIONS" :disabled="busy"
    /></label>
    <Alert v-if="error" variant="destructive" as="p" role="alert">{{ error }}</Alert>
    <div class="editor-actions">
      <Button type="button" variant="outline" :disabled="busy" @click="cancel">取消</Button
      ><Button type="submit" variant="default" :disabled="busy || !dirty">{{ busy ? "保存中…" : "保存" }}</Button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";

import type { ScheduledTask } from "../../../src/shared/schedules";
import { api, ApiError } from "../lib/api";
import { trackEditor } from "../lib/editor-guard";
import type { PickerOption } from "../lib/picker";
import PickerMenu from "./PickerMenu.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const props = defineProps<{ task: ScheduledTask }>();
const PURPOSE_OPTIONS: PickerOption[] = [
  { value: "task", label: "定时任务" },
  { value: "heartbeat", label: "主动检查（心跳）" },
];
const MODE_OPTIONS: PickerOption[] = [
  { value: "daily", label: "每天" },
  { value: "once", label: "仅一次" },
  { value: "cron", label: "自定义周期" },
];
const DELIVERY_OPTIONS: PickerOption<ScheduledTask["delivery"]>[] = [
  { value: "channel", label: "发送到所属会话" },
  { value: "silent", label: "静默执行" },
];
// A heartbeat may always send what it found; silent only hides how it checked.
const HEARTBEAT_DELIVERY_OPTIONS: PickerOption<ScheduledTask["delivery"]>[] = [
  { value: "silent", label: "静默：不显示检查过程，有事照常发消息" },
  { value: "channel", label: "显式：在对话里唤醒它" },
];
const two = (value: number) => String(value).padStart(2, "0");
const HOUR_OPTIONS: PickerOption[] = Array.from({ length: 24 }, (_, hour) => ({ value: two(hour), label: `${two(hour)} 时` }));
const MINUTE_OPTIONS: PickerOption[] = Array.from({ length: 60 }, (_, minute) => ({ value: two(minute), label: `${two(minute)} 分` }));
const emit = defineEmits<{ saved: [task?: ScheduledTask]; cancel: [] }>();
const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(props.task.cron ?? "");
const form = reactive({
  purpose: props.task.purpose ?? "task",
  title: props.task.title,
  prompt: props.task.prompt,
  notes: props.task.notes ?? "",
  delivery: props.task.delivery,
  mode: props.task.kind === "once" ? "once" : daily ? "daily" : "cron",
  time: daily ? `${daily[2].padStart(2, "0")}:${daily[1].padStart(2, "0")}` : "09:00",
  at: props.task.at ? new Date(Date.parse(props.task.at) + 8 * 3600_000).toISOString().slice(0, 16) : "",
  cron: props.task.cron ?? "0 9 * * *",
});
watch(
  () => form.purpose,
  (purpose) => {
    if (purpose === "heartbeat" && form.mode === "once") {
      form.mode = "cron";
      form.cron = "*/30 * * * *";
    }
  },
);
/** 每天 keeps `time` (HH:MM); 仅一次 keeps `at` (YYYY-MM-DDTHH:MM, Beijing time). The pickers read and write their parts. */
const clock = () => (form.mode === "once" ? form.at.slice(11, 16) || "09:00" : form.time);
function setClock(hour: string, minute: string) {
  if (form.mode === "once") form.at = `${onceDate.value || beijingDay(0)}T${hour}:${minute}`;
  else form.time = `${hour}:${minute}`;
}
const hour = computed({ get: () => clock().slice(0, 2), set: (value: string) => setClock(value, clock().slice(3, 5)) });
const minute = computed({ get: () => clock().slice(3, 5), set: (value: string) => setClock(clock().slice(0, 2), value) });
const onceDate = computed({
  get: () => form.at.slice(0, 10),
  set: (day: string) => (form.at = `${day}T${form.at.slice(11, 16) || "09:00"}`),
});
/** A Beijing calendar day, `offset` days from today, as YYYY-MM-DD. */
function beijingDay(offset: number) {
  return new Date(Date.now() + 8 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
}
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
/** The next 180 days, plus the task's own date when it lies outside them. */
const dateOptions = computed<PickerOption[]>(() => {
  const days = Array.from({ length: 180 }, (_, offset) => beijingDay(offset));
  if (onceDate.value && !days.includes(onceDate.value)) days.unshift(onceDate.value);
  const today = beijingDay(0);
  return days.map((day) => {
    const date = new Date(`${day}T00:00:00Z`);
    const relative = day === today ? "今天 · " : day === beijingDay(1) ? "明天 · " : "";
    const year = day.slice(0, 4) !== today.slice(0, 4) ? `${day.slice(0, 4)} 年` : undefined;
    return {
      value: day,
      label: `${relative}${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日 周${WEEKDAYS[date.getUTCDay()]}`,
      note: day < today ? "已过" : year,
    };
  });
});
const original = JSON.stringify(form);
const originalRule = JSON.stringify([form.mode, form.time, form.at, form.cron]);
const dirty = computed(() => JSON.stringify(form) !== original);
const terminal = props.task.state === "completed" || props.task.state === "cancelled";
const busy = ref(false);
const error = ref("");
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});

function patch(): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of ["title", "prompt", "delivery"] as const) if (form[key] !== props.task[key]) changes[key] = form[key];
  if (form.purpose !== (props.task.purpose ?? "task")) changes.purpose = form.purpose;
  // Cleared notes are sent as "" (the store drops them).
  if (form.notes.trim() !== (props.task.notes ?? "")) changes.notes = form.notes.trim();
  if (!terminal && JSON.stringify([form.mode, form.time, form.at, form.cron]) !== originalRule) {
    if (form.mode === "once") {
      const at = `${form.at.length === 16 ? form.at + ":00" : form.at}+08:00`;
      if (props.task.kind !== "once" || Date.parse(at) !== Date.parse(props.task.at ?? "")) Object.assign(changes, { kind: "once", at });
    } else {
      const parts = form.time.split(":");
      const cron = form.mode === "daily" ? `${Number(parts[1])} ${Number(parts[0])} * * *` : form.cron.trim();
      if (props.task.kind !== "cron" || cron !== props.task.cron) Object.assign(changes, { kind: "cron", cron });
    }
  }
  return changes;
}
trackEditor(
  () => dirty.value,
  () => busy.value,
);
async function save() {
  if (busy.value || !dirty.value) return;
  const changes = patch();
  if (!Object.keys(changes).length) {
    emit("cancel");
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const result = await api<{ ok: boolean; task?: ScheduledTask }>("/yesimbot/api/v1/schedules/update", {
      id: props.task.id,
      revision: props.task.revision,
      patch: changes,
    });
    if (result?.ok !== true) throw new Error("unconfirmed");
    if (!disposed) emit("saved", result.task);
  } catch (cause) {
    if (disposed) return;
    error.value =
      cause instanceof ApiError && cause.code === "schedule_changed"
        ? "任务已被修改或触发，请取消编辑并刷新后重试。"
        : cause instanceof ApiError && cause.code === "invalid_schedule"
          ? "请检查任务内容与执行时间：内容不能为空，一次性任务需设为未来时间，重复任务至少间隔 15 分钟。"
          : "保存未能确认，请刷新列表检查后重试。";
  } finally {
    if (!disposed) busy.value = false;
  }
}
/** 取消 and closing the dialog drop the edits without asking (user, 2026-11-16); only a save in flight keeps them. */
async function cancel() {
  if (busy.value || disposed) return;
  emit("cancel");
}
defineExpose({ cancel });
</script>

<style scoped>
@reference "../styles/app.css";

.schedule-editor {
  display: grid;
  gap: 16px;
  margin-top: 16px;
}
.plan-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
}
.time-pick {
  display: flex;
  align-items: center;
  gap: 8px;
}
.time-pick > .picker-menu {
  flex: 1;
}
.colon {
  @apply text-muted-foreground font-semibold;
}
.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.schedule-editor .muted {
  @apply text-xs;
}
</style>

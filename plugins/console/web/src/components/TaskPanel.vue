<template>
  <section ref="taskList" class="intent-scope space-y-3" aria-label="后台活动">
    <header class="flex items-center gap-2">
      <h3 class="mr-auto text-lg font-semibold">后台活动</h3>
      <Button
        variant="ghost"
        size="icon-sm"
        class="intent-target rounded-full text-muted-foreground"
        aria-label="刷新后台任务"
        :disabled="loading || !!busy"
        @click="refresh"
        ><RefreshCw class="size-4" :class="{ 'animate-spin': loading }"
      /></Button>
    </header>
    <p v-if="error && !selected" class="arrive text-sm text-destructive" role="alert">{{ error }}</p>
    <p v-if="!scoped.length && !loading && !error" class="arrive px-2 text-sm text-muted-foreground">暂无任务</p>
    <LoadingRows v-if="loading && !scoped.length" label="正在读取后台活动" />
    <template v-for="group in groups" :key="group.label">
      <section v-if="group.items.length" class="task-group arrive space-y-1">
        <div class="flex min-h-6 items-center gap-2 pl-2">
          <h4 class="mr-auto text-xs text-muted-foreground">{{ group.label }}</h4>
          <Button v-if="group.archivable" variant="ghost" size="xs" class="group-action text-muted-foreground" :disabled="!!busy" @click="archive(group.items)"
            ><Archive />全部归档</Button
          >
        </div>
        <LimitedList
          :items="group.items"
          :open="listOpen === group.label"
          :button-label="`查看全部 ${group.items.length} 项…`"
          :dialog-title="group.label"
          @update:open="(value: boolean) => (listOpen = value ? group.label : '')"
        >
          <template #row="{ item: task }">
            <button type="button" class="side-row" :disabled="!!busy" @click="openTask(task, $event)">
              <span
                class="side-row-icon"
                :class="{
                  'text-destructive': task.status === 'failed',
                  'text-primary': active(task),
                }"
                ><component :is="iconFor(task)" class="size-4" :class="{ 'animate-spin': task.status === 'running' }"
              /></span>
              <span class="min-w-0 flex-1">
                <strong class="side-row-title">{{ title(task) }}</strong>
                <span class="side-row-meta"
                  ><span>{{ statusLabel(task) }}</span
                  ><time>{{ formatTime(task.updatedAt) }}</time></span
                >
              </span>
            </button>
          </template>
        </LimitedList>
      </section>
    </template>
    <Dialog :open="!!selected" @update:open="updateOpen">
      <DialogContent
        class="task-window h-[min(780px,calc(100dvh-3rem))] max-h-none w-[min(1040px,calc(100vw-3rem))] gap-0 overflow-clip rounded-[22px] p-0 sm:max-w-none max-[760px]:h-dvh max-[760px]:w-screen max-[760px]:rounded-none max-[760px]:border-0"
        :aria-describedby="undefined"
        @close-auto-focus="restoreFocus"
      >
        <div v-if="selected" class="task-layout" :class="{ 'tab-open': tabOpen }">
          <aside class="task-side">
            <header class="task-head">
              <DialogTitle class="task-title">{{ title(selected) }}</DialogTitle>
              <p class="task-meta">
                {{ statusLabel(selected) }} · {{ formatTime(selected.updatedAt) }}<template v-if="stepsTotal"> · 已执行 {{ stepsTotal }} 步</template>
              </p>
            </header>
            <div ref="tabList" class="task-tabs" role="tablist" aria-orientation="vertical" aria-label="任务和每次工具调用" @keydown="moveTab">
              <button
                type="button"
                role="tab"
                class="task-tab"
                :aria-selected="tab === ''"
                :tabindex="tab === '' ? 0 : -1"
                aria-controls="task-pane"
                @click="pick('')"
              >
                <span class="tab-icon" aria-hidden="true"><LayoutList class="size-4" /></span>
                <span class="tab-text"><strong>概览</strong></span>
              </button>
              <button
                v-for="item in tabs"
                :key="item.step.id"
                type="button"
                role="tab"
                class="task-tab"
                :class="item.step.status"
                :aria-selected="tab === item.step.id"
                :tabindex="tab === item.step.id ? 0 : -1"
                aria-controls="task-pane"
                @click="pick(item.step.id)"
              >
                <span class="tab-icon" aria-hidden="true"
                  ><LoaderCircle v-if="item.step.status === 'running'" class="size-4 animate-spin" /><component :is="item.icon" v-else class="size-4"
                /></span>
                <span class="tab-text"
                  ><strong>{{ item.view.label }}</strong
                  ><span v-if="item.view.summary" class="tab-line" :class="{ mono: !!item.view.command }">{{ item.view.summary }}</span></span
                >
              </button>
              <p v-if="stepsError" class="tab-note text-destructive" role="alert">{{ stepsError }}</p>
              <LoadingRows v-else-if="stepsLoading && !steps.length" label="正在读取执行记录" :count="2" />
              <p v-else-if="!steps.length" class="tab-note">{{ live(selected.status) ? "还没有执行任何操作" : "没有执行记录" }}</p>
            </div>
          </aside>
          <section id="task-pane" ref="pane" class="task-pane" role="tabpanel" aria-live="polite">
            <Button variant="ghost" size="sm" class="task-back" type="button" @click="tabOpen = false"><ArrowLeft class="size-4" />返回</Button>
            <WorkStepView v-if="shownStep" :step="shownStep.step" :index="shownStep.index" />
            <template v-else>
              <header class="pane-head">
                <h3 class="pane-title min-w-0 flex-1">{{ statusLabel(selected) }}</h3>
                <Button v-if="!active(selected)" variant="outline" size="sm" :disabled="!!busy" @click="archive([selected])"
                  ><Archive class="size-4" />归档</Button
                >
              </header>
              <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
              <p v-if="selected.status === 'unknown'" class="text-sm text-muted-foreground">{{ interruptedNote(selected) }}</p>
              <section v-if="pendingHandoff(selected)" class="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                <h4 class="text-sm font-medium">需要你处理</h4>
                <p class="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{{ selected.handoff.instruction }}</p>
                <p v-if="selected.handoff.deviceId" class="text-sm text-muted-foreground">在电脑面板完成操作并交还电脑后，点击继续。</p>
                <p class="text-sm text-muted-foreground">超过一天没有处理，任务会自动结束。</p>
                <Button size="sm" :disabled="!!busy" @click="act(selected, 'resolve-handoff')">已处理，继续任务</Button>
              </section>
              <section v-if="selected.result" class="min-w-0 space-y-2">
                <h4 class="text-sm font-medium">执行结果</h4>
                <ChatMarkdown :text="selected.result" />
              </section>
              <p v-if="selected.notification === 'unknown'" class="text-sm text-muted-foreground">结果未确认送达对话，请以这里的记录为准；任务没有重新执行。</p>
              <ul v-if="selected.artifacts?.length" class="space-y-1 text-sm text-muted-foreground">
                <li v-for="artifact in selected.artifacts" :key="artifact" class="break-all">{{ artifact }}</li>
              </ul>
              <template v-if="active(selected)">
                <label class="grid gap-2 text-sm font-medium"
                  >补充说明<Textarea
                    v-model="drafts[selected.id]"
                    rows="3"
                    maxlength="8000"
                    placeholder="补充说明…"
                    aria-label="补充任务说明"
                    :disabled="!!busy"
                /></label>
                <div class="flex justify-end gap-2">
                  <Button variant="outline" size="sm" :disabled="!!busy" @click="act(selected, 'cancel')">取消任务</Button
                  ><Button size="sm" :disabled="!!busy || !drafts[selected.id]?.trim()" @click="act(selected, 'update')">提交补充</Button>
                </div>
              </template>
              <section class="min-w-0 space-y-2">
                <h4 class="text-sm font-medium">任务内容</h4>
                <p class="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{{ selected.instruction }}</p>
              </section>
            </template>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  </section>
</template>
<script setup lang="ts">
import {
  Archive,
  ArrowLeft,
  Check,
  CircleHalfDottedCheck as CircleDashed,
  HelpCircle as CircleHelp,
  CloseCircle as CircleX,
  Clock as Clock3,
  ListSquare as LayoutList,
  Loader as LoaderCircle,
  Refresh as RefreshCw,
  User as UserRound,
} from "reicon-vue";
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";

import type { TaskStepsResponse, WorkStep } from "../../../src/shared/work";
import { api, ApiError } from "../lib/api";
import { trackEditor } from "../lib/editor-guard";
import { formatTime } from "../lib/format";
import { toast } from "../lib/toast";
import { useTopic } from "../lib/use-topic";
import { describeStep, stepIcon } from "../lib/work-steps";
import ChatMarkdown from "./ChatMarkdown.vue";
import LimitedList from "./LimitedList.vue";
import LoadingRows from "./LoadingRows.vue";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import WorkStepView from "./WorkStepView.vue";

/** How often an open running task's steps are read again. */
const STEPS_REFRESH_MS = 3000;

type Status = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "unknown";
interface Task {
  id: string;
  instruction: string;
  channel: string;
  session: string;
  handoff?: { id: string; state: "pending" | "resolved" | "cancelled"; instruction: string; deviceId?: string };
  status: Status;
  updatedAt: number;
  result?: string;
  artifacts?: string[];
  notification?: "pending" | "claimed" | "delivered" | "unknown" | "obsolete";
  pauseReason?: "context_budget";
  /** A later task carries on this paused task's work; it waits for nothing. */
  continuedBy?: string;
}
const props = defineProps<{ conversation?: { channel: string; session?: string } }>();
const labels: Record<Status, string> = {
  queued: "等待执行",
  running: "执行中",
  waiting: "需要补充",
  succeeded: "已完成",
  failed: "未完成",
  cancelled: "已取消",
  unknown: "已中断",
};
const live = (status: Status) => ["queued", "running", "waiting"].includes(status);
/** Still open: queued, running, or waiting for something — not a paused task another task carries on. */
const active = (task: Task) => live(task.status) && !task.continuedBy;
const taskList = ref<HTMLElement>(),
  tabList = ref<HTMLElement>(),
  pane = ref<HTMLElement>(),
  selectedId = ref(""),
  // The open task's tab: "" is 概览, otherwise a step's call ID. `follow` keeps a running task on its newest step;
  // `tabOpen` shows the tab instead of the list on a narrow screen.
  tab = ref(""),
  follow = ref(false),
  tabOpen = ref(false),
  listOpen = ref(""),
  items = ref<Task[]>([]),
  loading = ref(true),
  error = ref(""),
  busy = ref(""),
  // What the open task did and is doing (see loadSteps).
  steps = ref<WorkStep[]>([]),
  stepsTotal = ref(0),
  stepsLoading = ref(false),
  stepsError = ref("");
const drafts = reactive<Record<string, string>>({});
const scoped = computed(() =>
  props.conversation
    ? items.value.filter((t) => t.channel === props.conversation!.channel && (!props.conversation!.session || t.session === props.conversation!.session))
    : [],
);
trackEditor(
  () => scoped.value.some((task) => !!drafts[task.id]?.trim()),
  () => !!busy.value,
);
function iconFor(task: Task) {
  if (pendingHandoff(task)) return UserRound;
  return { queued: Clock3, running: LoaderCircle, waiting: CircleHelp, succeeded: Check, failed: CircleX, cancelled: CircleX, unknown: CircleDashed }[
    task.status
  ];
}
function pendingHandoff(task: Task): task is Task & { handoff: NonNullable<Task["handoff"]> } {
  return task.status === "waiting" && task.handoff?.state === "pending";
}
function statusLabel(task: Task) {
  if (task.continuedBy) return "已暂停，后续任务接着做";
  if (task.status === "waiting" && task.pauseReason === "context_budget") return "已暂停";
  return pendingHandoff(task) ? "等待你处理" : labels[task.status];
}
function title(task: Task) {
  return task.instruction.split("\n")[0]?.slice(0, 100) || "后台任务";
}

/** Says who checks an interrupted task; a result that never reached the conversation is explained further down. */
function interruptedNote(task: Task) {
  const handover =
    task.notification === "obsolete"
      ? "原来的对话已经结束，结果没有交给 bot。"
      : task.notification === "unknown"
        ? ""
        : "结果交给对话里的 bot 核实，不需要你处理。";
  return `任务停止时还有操作的结果没确认，没有自动重试。${handover}`;
}
const selected = computed(() => scoped.value.find((task) => task.id === selectedId.value));
// Only another conversation closes an open task; a new snapshot of the same one (a new object) does not.
watch(
  () => JSON.stringify([props.conversation?.channel ?? "", props.conversation?.session ?? ""]),
  () => (selectedId.value = ""),
);
let lastTrigger: HTMLElement | undefined;
function openTask(task: Task, event?: MouseEvent) {
  if (busy.value) return;
  lastTrigger = event?.currentTarget as HTMLElement | undefined;
  error.value = "";
  listOpen.value = "";
  selectedId.value = task.id;
  // A running task opens on what it is doing now; one that ended opens on its result.
  tab.value = "";
  follow.value = live(task.status);
  tabOpen.value = false;
}

// ---------- Tabs: 概览, then each tool call in order ----------
const tabs = computed(() => steps.value.map((step, index) => ({ step, index, view: describeStep(step), icon: stepIcon(step.tool) })));
const shownStep = computed(() => (tab.value ? tabs.value.find((item) => item.step.id === tab.value) : undefined));
function pick(id: string) {
  tab.value = id;
  follow.value = !!id && id === steps.value.at(-1)?.id && !!selected.value && live(selected.value.status);
  tabOpen.value = true;
  pane.value?.scrollTo({ top: 0 });
}
/** Up and down move between the tabs, as in any vertical tab list; Home and End go to the first and the last. */
function moveTab(event: KeyboardEvent) {
  const buttons = [...(tabList.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
  const at = buttons.indexOf(event.target as HTMLButtonElement);
  if (at < 0) return;
  const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
  if (next === undefined || !buttons[next]) return;
  event.preventDefault();
  buttons[next].click();
  buttons[next].focus();
}
// Following, a new step becomes the open tab and is scrolled into sight; a step the user picked stays open.
watch(
  () => steps.value.at(-1)?.id,
  (last) => {
    if (!follow.value || !last) return;
    tab.value = last;
    void nextTick(() => tabList.value?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }));
  },
);
watch(
  () => selected.value?.status,
  (status) => {
    if (status && !live(status)) follow.value = false;
  },
);
/** Closing never asks (user, 2026-11-16): an unsent 补充说明 goes with the dialog. */
function updateOpen(open: boolean) {
  if (open || busy.value) return;
  if (selected.value) drafts[selected.value.id] = "";
  selectedId.value = "";
}
function restoreFocus(event: Event) {
  event.preventDefault();
  const target = lastTrigger?.isConnected ? lastTrigger : taskList.value?.querySelector<HTMLElement>("button:not(:disabled)");
  target?.focus();
}
/** Newest activity first: each group lists its tasks by last update, and shows only the first few inline. */
const newestFirst = (list: Task[]) => [...list].sort((a, b) => b.updatedAt - a.updatedAt);
/**
 * A task that stopped with some result unconfirmed is finished work like any other: the main conversation receives it
 * and checks what happened itself (user, 2026-11-20: 「任何任务都不在需要我核实，让主bot核实就行了」).
 */
const groups = computed(() => [
  { label: "需要你处理", items: newestFirst(scoped.value.filter((t) => t.status === "waiting" && !t.continuedBy)) },
  { label: "正在进行", items: newestFirst(scoped.value.filter((t) => t.status === "queued" || t.status === "running")) },
  { label: "已结束", items: newestFirst(scoped.value.filter((t) => !active(t))), archivable: true },
]);
/**
 * Archived tasks leave the panel; the bot still finds them with task_status (user, 2026-11-26: 「后台任务，允许归档，
 * 归档后webui上看不到了，但是bot仍然可以通过命令查询」). The toast's 撤销 brings them back.
 */
async function archive(list: Task[], archived = true) {
  if (busy.value || !list.length) return;
  busy.value = "archive";
  const ids = new Set(list.map((task) => task.id));
  try {
    await api<{ ids: string[] }>("/yesimbot/api/v1/tasks/archive", { ids: [...ids], archived });
    if (disposed) return;
    if (archived) {
      items.value = items.value.filter((task) => !ids.has(task.id));
      if (ids.has(selectedId.value)) selectedId.value = "";
      listOpen.value = "";
      toast("已归档", "ok", undefined, { label: "撤销", run: () => void archive(list, false) });
    } else {
      items.value = [...items.value.filter((task) => !ids.has(task.id)), ...list];
      toast("已撤销");
    }
  } catch {
    if (!disposed) toast(archived ? "没能归档，请稍后再试。" : "没能撤销，请稍后再试。", "danger");
  } finally {
    busy.value = "";
  }
}
function applySnapshot(next: Task[]) {
  items.value = next;
}
let disposed = false,
  stepsOf = "",
  stepsTimer: ReturnType<typeof setTimeout> | undefined,
  stepsController: AbortController | undefined;
const topic = useTopic<{ items: Task[] }>("tasks");
watch(
  () => topic.data,
  (data) => {
    if (data) {
      applySnapshot(data.items);
      loading.value = false;
      error.value = "";
    }
  },
  { immediate: true },
);
watch(
  () => topic.failed || topic.unavailable,
  (failed) => {
    if (failed) {
      loading.value = false;
      error.value = "暂时无法读取任务，请稍后再试。";
    }
  },
  { immediate: true },
);
const controller = new AbortController();
async function refresh() {
  loading.value = true;
  try {
    const data = await api<{ items: Task[] }>("/yesimbot/api/v1/tasks", undefined, { fresh: true, signal: controller.signal });
    if (!disposed) {
      applySnapshot(data.items);
      error.value = "";
    }
    return true;
  } catch {
    if (!disposed) error.value = "暂时无法读取任务，请稍后重试。";
    return false;
  } finally {
    loading.value = false;
  }
}
async function act(task: Task, action: "cancel" | "update" | "resolve-handoff") {
  if (busy.value) return;
  busy.value = task.id;
  try {
    const updated = await api<Task>("/yesimbot/api/v1/tasks/update", {
      id: task.id,
      action,
      ...(action === "update" || action === "resolve-handoff" ? { instruction: drafts[task.id] ?? "" } : {}),
      ...(action === "resolve-handoff" ? { handoffId: task.handoff?.id } : {}),
    });
    if (disposed) return;
    items.value = items.value.map((item) => (item.id === updated.id ? updated : item));
    drafts[task.id] = "";
    error.value = "";
    if (!(await refresh()) && !disposed) error.value = "操作已保存，暂时无法刷新任务列表，请稍后重试。";
  } catch (cause) {
    if (disposed) return;
    error.value =
      cause instanceof ApiError && cause.code === "task_handoff_not_ready"
        ? "请先交还电脑并确认它在线；若原会话已经结束，此任务不能继续。"
        : cause instanceof ApiError && cause.code === "task_handoff_stale"
          ? "这次交接已结束或已更新，请刷新任务状态。"
          : "未能确认操作结果，请查看最新状态后再试。";
  } finally {
    busy.value = "";
  }
}

// ---------- Steps ----------
/**
 * What the open task did and is doing (user, 2026-11-20: 「我点开这个后台任务不就是为了看进度吗？至少我得知道，执行了哪些命令，
 * 正在执行什么命令吧？」). While it runs, the steps are read again from the first one still running, and only that tail
 * is replaced.
 */
async function loadSteps() {
  clearTimeout(stepsTimer);
  const task = selected.value;
  if (!task || disposed) return;
  if (stepsOf !== task.id) {
    stepsOf = task.id;
    steps.value = [];
    stepsTotal.value = 0;
    stepsError.value = "";
  }
  const running = steps.value.findIndex((step) => step.status === "running");
  const from = running < 0 ? steps.value.length : running;
  stepsController?.abort();
  const request = (stepsController = new AbortController());
  stepsLoading.value = true;
  try {
    const data = await api<TaskStepsResponse>(`/yesimbot/api/v1/tasks/steps?id=${encodeURIComponent(task.id)}&from=${from}`, undefined, {
      fresh: true,
      signal: request.signal,
    });
    if (disposed || stepsOf !== task.id || request.signal.aborted) return;
    if (data.total < from)
      steps.value = (
        await api<TaskStepsResponse>(`/yesimbot/api/v1/tasks/steps?id=${encodeURIComponent(task.id)}`, undefined, { fresh: true, signal: request.signal })
      ).steps;
    else steps.value.splice(from, steps.value.length - from, ...data.steps);
    stepsTotal.value = Math.max(data.total, steps.value.length);
    stepsError.value = "";
  } catch {
    if (!disposed && !request.signal.aborted) stepsError.value = "暂时无法读取执行记录，稍后会再试。";
  } finally {
    if (stepsController === request) stepsLoading.value = false;
  }
  if (disposed || stepsOf !== task.id || request.signal.aborted) return;
  const current = selected.value;
  if (current?.id === task.id && (current.status === "queued" || current.status === "running" || steps.value.some((step) => step.status === "running")))
    stepsTimer = setTimeout(loadSteps, STEPS_REFRESH_MS);
}
watch(
  () => selected.value?.id,
  (id) => {
    clearTimeout(stepsTimer);
    stepsController?.abort();
    if (id) void loadSteps();
    else {
      stepsOf = "";
      steps.value = [];
      stepsTotal.value = 0;
    }
  },
);
// A status change (it ended, or started) reads the tail once more.
watch(
  () => selected.value?.status,
  (status, before) => {
    if (status && before && status !== before) void loadSteps();
  },
);

onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
  clearTimeout(stepsTimer);
  stepsController?.abort();
});
</script>
<style scoped>
@reference "../styles/app.css";

/* UI-EXCEPTION task-window: one task's window, its tabs (概览 and each tool call) left and the open tab right, like 设置. */
.task-layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}
.task-side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  padding: 24px 12px 12px;
  background: var(--sidebar);
  border-right: 1px solid var(--group-line);
}
.task-head {
  display: grid;
  gap: 4px;
  padding: 0 12px;
}
.task-title {
  display: -webkit-box;
  overflow: hidden;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
.task-meta {
  color: var(--text-3);
  font-size: 14px;
}
.task-tabs {
  display: grid;
  align-content: start;
  gap: 4px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.task-tab {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 12px;
  color: var(--text-2);
  text-align: left;
  transition:
    background-color var(--t-fast) ease,
    color var(--t-fast) ease;
}
.task-tab:hover {
  background: var(--group);
  color: var(--text);
}
.task-tab[aria-selected="true"] {
  background: var(--group-hover);
  color: var(--text);
}
.task-tab:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.tab-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 20px;
}
.task-tab[aria-selected="true"] .tab-icon,
.task-tab.running .tab-icon {
  @apply text-primary;
}
.task-tab.failed .tab-icon {
  @apply text-destructive;
}
.tab-text {
  display: grid;
  min-width: 0;
  font-size: 14px;
  line-height: 20px;
}
.tab-text strong {
  font-weight: 500;
}
.task-tab[aria-selected="true"] .tab-text strong {
  font-weight: 600;
}
.tab-line {
  overflow: hidden;
  color: var(--text-3);
  font-size: 14px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-line.mono {
  font-family: var(--mono);
}
.tab-note {
  padding: 8px 12px;
  color: var(--text-3);
  font-size: 14px;
}
.task-pane {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: start;
  gap: 20px;
  min-width: 0;
  min-height: 0;
  /* Clear of the window's close button in the corner. */
  padding: 28px 56px 32px 32px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.task-back {
  display: none;
  justify-self: start;
}
/* A group's own action shows when the pointer or focus is on that group; touch screens always show it. */
@media (hover: hover) {
  .task-group .group-action {
    opacity: 0;
    transition: opacity var(--t-fast) ease;
  }
  .task-group:hover .group-action,
  .task-group:focus-within .group-action {
    opacity: 1;
  }
}
.pane-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.pane-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
@media (max-width: 760px) {
  /* Phones: the list fills the window; a tab opens over it with 返回. */
  .task-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .task-side {
    border-right: 0;
  }
  /* Clear of the window's close button. */
  .task-head {
    padding-right: 44px;
  }
  .task-layout.tab-open .task-side,
  .task-layout:not(.tab-open) .task-pane {
    display: none;
  }
  .task-pane {
    padding: 16px;
  }
  .task-back {
    display: inline-flex;
  }
}
</style>

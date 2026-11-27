<template>
  <section class="thread" :class="{ embedded }" :aria-label="label">
    <header class="thread-head">
      <!-- The title is the way to every other conversation: it opens the list. -->
      <Button variant="ghost" class="h-auto min-h-9 whitespace-normal" as-child v-if="back"
        ><button class="head-text switcher" type="button" aria-label="切换会话" aria-haspopup="dialog" :title="`${label} · 切换会话`" @click="emit('back')">
          <img v-if="avatar && !avatarFailed" class="head-face" :src="avatar" alt="" referrerpolicy="no-referrer" @error="avatarFailed = true" />
          <span v-else class="head-face initial" aria-hidden="true">{{ label.slice(0, 1) }}</span>
          <span class="switcher-text"
            ><strong class="truncate">{{ label }}</strong
            ><small class="truncate">{{ subtitle }}</small></span
          >
          <Icon name="chevron" class="switcher-chevron" /></button
      ></Button>
      <div v-else class="head-text still">
        <img v-if="avatar && !avatarFailed" class="head-face" :src="avatar" alt="" referrerpolicy="no-referrer" @error="avatarFailed = true" />
        <span v-else class="head-face initial" aria-hidden="true">{{ label.slice(0, 1) }}</span>
        <span class="switcher-text"
          ><strong class="truncate">{{ label }}</strong
          ><small class="truncate">{{ subtitle }}</small></span
        >
      </div>
      <label class="inline-flex items-center gap-3 text-sm font-medium traces" title="显示思考和工具记录"
        ><Switch v-model="traces" /><span class="traces-label">思考和工具</span></label
      >
      <!-- Rarely used and (archive) not to be hit by accident: one menu, so the name keeps the room. -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child
          ><Button variant="ghost" size="icon-sm" type="button" aria-label="更多操作" title="更多操作"><Ellipsis class="size-4" /></Button
        ></DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-44">
          <DropdownMenuItem @select="schedulesOpen = true">定时任务</DropdownMenuItem>
          <DropdownMenuItem v-if="channel.activeSession && !activeEmpty && !detailPath" :disabled="archiving" @select="archive">{{
            archiving ? "正在归档…" : "归档当前会话"
          }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Sheet v-model:open="schedulesOpen">
        <SheetContent class="flex flex-col gap-4 p-5 sm:max-w-xl">
          <SheetTitle class="pr-10">{{ label }} · 定时任务</SheetTitle>
          <SheetDescription class="sr-only">任务在此会话中触发和回复。</SheetDescription>
          <div class="min-h-0 flex-1 overflow-y-auto"><ScheduledTasks :scope="channel" /></div>
        </SheetContent>
      </Sheet>
      <slot name="actions" />
    </header>

    <div ref="scrollerEl" class="messages" role="log" aria-live="polite" :aria-label="`${label}的记录`" @scroll.passive="onScroll">
      <div class="column">
        <Alert v-if="error" variant="destructive" as="p" role="alert"
          >{{ error }} <Button variant="outline" size="sm" type="button" @click="reload">重试</Button></Alert
        >
        <div v-if="!loaded && !error" class="loading" aria-busy="true">
          <Skeleton v-for="n in 4" :key="n" class="skeleton" :style="{ width: `${[52, 70, 38, 60][n - 1]}%`, height: n % 2 ? '40px' : '56px' }"></Skeleton>
        </div>
        <template v-else-if="loaded">
          <p class="top muted">{{ loadingMore ? "正在加载更早的记录…" : "" }}</p>
          <p v-if="!rows.length" class="empty-state">暂无记录</p>
          <template v-for="row in rows" :key="row.node.id">
            <p v-if="row.session" class="day session" role="separator">
              <span>{{ row.session }}</span>
            </p>
            <p v-if="row.day" class="day" role="separator">
              <span>{{ row.day }}</span>
            </p>
            <!-- Someone in the chat: name over the first of their messages in a row. -->
            <div
              v-if="row.node.kind === 'user'"
              class="message them"
              :class="{ first: row.first || row.node.whisper, whisper: row.node.whisper, fresh: isFresh(row.node.timestamp) }"
            >
              <span v-if="row.first || row.node.whisper" class="avatar" aria-hidden="true">{{
                row.node.whisper ? "你" : initial(senderName(row.node.sender))
              }}</span>
              <span v-else class="avatar-space" aria-hidden="true"></span>
              <div class="body">
                <div v-if="row.node.whisper" class="meta">
                  <strong>你 · 私话</strong><span>群里看不到</span><time>{{ clock(row.node.timestamp) }}</time>
                </div>
                <div v-else-if="row.first" class="meta">
                  <strong :title="row.node.sender">{{ senderName(row.node.sender) }}</strong
                  ><time>{{ clock(row.node.timestamp) }}</time>
                </div>
                <div class="bubble">
                  <p v-if="row.node.text">{{ row.node.text }}</p>
                  <Assets v-if="row.node.assets?.length" :assets="row.node.assets" />
                </div>
              </div>
            </div>
            <!-- The bot: on the right of the same column. -->
            <div
              v-else-if="row.node.kind === 'assistant'"
              class="message bot"
              :class="{ first: row.first || row.node.whisper, whisper: row.node.whisper, fresh: isFresh(row.node.timestamp) }"
            >
              <div class="body">
                <div v-if="row.node.whisper" class="meta">
                  <time>{{ clock(row.node.timestamp) }}</time
                  ><strong>私下回你</strong>
                </div>
                <div v-else-if="row.first || row.node.delivery === '发送失败'" class="meta">
                  <time>{{ clock(row.node.timestamp) }}</time
                  ><span v-if="row.node.delivery && row.node.delivery !== '已发送'" :class="{ bad: row.node.delivery === '发送失败' }">{{
                    row.node.delivery
                  }}</span>
                </div>
                <div class="bubble">
                  <ChatMarkdown :text="row.node.reply || ''" />
                  <Assets v-if="row.node.assets?.length" :assets="row.node.assets" />
                  <button
                    v-if="traces && row.node.thought"
                    type="button"
                    class="trace trace-button thought in-message"
                    @click="openRecord(row.node, $event, undefined, true)"
                  >
                    <span class="trace-title">思考</span><span class="record-link">查看详情</span>
                  </button>
                </div>
              </div>
              <BotAvatar v-if="row.first || row.node.whisper" class="bot-avatar" />
              <span v-else class="avatar-space" aria-hidden="true"></span>
            </div>
            <button v-else-if="row.node.kind === 'thought'" type="button" class="trace trace-button thought" @click="openRecord(row.node, $event)">
              <span class="trace-title">思考</span><time>{{ clock(row.node.timestamp) }}</time
              ><span class="record-link">查看详情</span>
            </button>
            <button
              v-else-if="row.node.kind === 'tool-call'"
              type="button"
              class="trace trace-button tool"
              :class="{ bad: row.result?.error }"
              @click="openRecord(row.node, $event, row.result)"
            >
              <span class="trace-title"
                >{{ row.result?.error ? "调用失败" : "调用" }} <code>{{ row.node.toolName || "工具" }}</code></span
              ><time>{{ clock(row.node.timestamp) }}</time
              ><span class="record-link">查看详情</span>
            </button>
            <button
              v-else-if="row.node.kind === 'tool-result'"
              type="button"
              class="trace trace-button tool"
              :class="{ bad: row.node.error }"
              @click="openRecord(row.node, $event)"
            >
              <span class="trace-title"
                >{{ row.node.error ? "结果异常" : "结果" }} <code>{{ row.node.toolName || "工具" }}</code></span
              ><time>{{ clock(row.node.timestamp) }}</time
              ><span class="record-link">查看详情</span>
            </button>
            <button
              v-else-if="row.node.kind === 'will'"
              type="button"
              class="line record-line will"
              :class="{ go: row.node.decision === 'trigger' }"
              @click="openRecord(row.node, $event)"
            >
              {{ decisionLabel(row.node.decision) }}<template v-if="row.node.repeats"> × {{ row.node.repeats.length }}</template
              ><time>{{ clock(row.node.timestamp) }}</time
              ><span class="record-link">查看详情</span>
            </button>
            <button v-else type="button" class="line record-line event" :class="{ bad: row.node.error }" @click="openRecord(row.node, $event)">
              <Badge :variant="badgeTone(row.node.error && 'danger')" as="span">{{ eventTitle(row.node) }}</Badge
              ><time>{{ clock(row.node.timestamp) }}</time
              ><span class="record-link">查看详情</span>
            </button>
          </template>
          <!-- Just archived: the new session has nothing yet, so the line closes the column instead of opening one. -->
          <p v-if="archivedTail" class="day session" role="separator"><span>以上已归档</span></p>
        </template>
      </div>
    </div>
    <Button v-if="!atBottom && rows.length" variant="outline" size="sm" class="jump" :class="{ raised: !!$slots.composer }" type="button" @click="scrollToEnd">
      回到最新 ↓
    </Button>
    <ConversationRecordDialog :record="recordDetail" @close="recordDetail = undefined" @close-auto-focus="restoreRecordFocus" />
    <slot name="composer" />
  </section>
</template>
<script setup lang="ts">
import { platformLabel } from "@yesimbot/contracts/platforms";
import { More as Ellipsis } from "reicon-vue";
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type PropType } from "vue";

import { api } from "../../lib/api";
import { archiveConversation } from "../../lib/archive-conversation";
import { readView, writeView } from "../../lib/cache";
import { channelAvatar } from "../../lib/channel-avatar";
import { conversationRecord, type ConversationRecordDetail } from "../../lib/conversation-record";
import { readableReplies, readableTimeline, withoutDeliveredSends } from "../../lib/conversation-replies";
import { formatSessionName, formatTime } from "../../lib/format";
import { senderName } from "../../lib/talk";
import { isWebPlatform } from "../../lib/web-platform";
import { buildTurnGroups, decisionLabel, eventTitle, foldToolResults, mergeEntries, visibleNodes, type MainNode } from "../../pages/conversation-detail-model";
import BotAvatar from "../../shell/BotAvatar.vue";
import Icon from "../../shell/Icon.vue";
import type { ConversationAssetView, ConversationChannelSummary, ConversationDetail, ConversationEntryView } from "../../state/history-types";
import ChatMarkdown from "../ChatMarkdown.vue";
import ConversationRecordDialog from "../ConversationRecordDialog.vue";
import ScheduledTasks from "../ScheduledTasks.vue";
import { Alert } from "../ui/alert";
import { Badge, badgeTone } from "../ui/badge";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";

/**
 * One chat's history as one continuous column, newest at the bottom. Scrolling up reads further back, past
 * archived session files, until the very first record. Thoughts and tool calls stay hidden until asked for.
 */
const schedulesOpen = ref(false);
const archiving = ref(false);
const props = defineProps<{
  embedded?: boolean;
  channel: ConversationChannelSummary;
  label: string;
  /** Phones show a back button to the conversation list. */
  back?: boolean;
  /** Where its records are read. */
  detailPath?: string;
}>();
const emit = defineEmits<{ back: []; outputs: [assets: ConversationAssetView[]] }>();
async function archive() {
  const session = props.channel.activeSession;
  if (!session || archiving.value) return;
  archiving.value = true;
  try {
    await archiveConversation({ channel: props.channel.key, session, label: props.label }, () =>
      props.channel.activeSession ? { channel: props.channel.key, session: props.channel.activeSession } : undefined,
    );
  } finally {
    archiving.value = false;
  }
}
const PAGE = 30;

const Assets = defineComponent({
  props: { assets: { type: Array as PropType<ConversationAssetView[]>, required: true } },
  setup: (assetProps) => () =>
    h(
      "div",
      { class: "assets" },
      assetProps.assets.map((asset) =>
        h("a", { key: asset.id, class: "asset", href: asset.dataUrl, target: "_blank", title: asset.title || asset.id }, [
          asset.kind === "image" && asset.dataUrl
            ? h("img", { src: asset.dataUrl, alt: asset.title || "图片" })
            : h("span", { class: "asset-placeholder" }, asset.kind === "image" ? "图片" : asset.title || "文件"),
        ]),
      ),
    ),
});

const recordDetail = shallowRef<ConversationRecordDetail>();
let recordTrigger: HTMLElement | undefined;
function openRecord(node: MainNode, event: MouseEvent, result?: MainNode, thoughtOnly = false) {
  recordTrigger = event.currentTarget as HTMLElement;
  recordDetail.value = conversationRecord(node, result, thoughtOnly);
}
function restoreRecordFocus(event: Event) {
  event.preventDefault();
  if (recordTrigger?.isConnected) recordTrigger.focus();
}
const traces = ref(false);

const avatar = computed(() => channelAvatar(props.channel));
const avatarFailed = ref(false);
watch(avatar, () => (avatarFailed.value = false));
const subtitle = computed(() => `${platformLabel(props.channel.platform)} · ${props.channel.type === "direct" ? "私聊" : "群聊"}`);

// ---------- Records: newest file first, then back through older files ----------
const entries = ref<ConversationEntryView[]>([]);
const loaded = ref(false);
const loadingMore = ref(false);
const error = ref("");
/** The file being read backward and where in it; older files follow once it is exhausted. */
const older = shallowRef<{ file: number; cursor?: string; more: boolean }>({ file: -1, more: false });
let generation = 0;
let latestPending: number | undefined;
let disposed = false;
const files = computed(() => props.channel.sessions.map((session) => session.filename).sort());
const viewKey = computed(
  () => `conversation:${props.detailPath ?? ""}:${props.channel.key}${props.channel.platform === "web" ? ":" + files.value.join(",") : ""}`,
);
const exhausted = computed(() => loaded.value && !older.value.more && older.value.file <= 0 && !loadingMore.value);

/** Entry IDs are offsets within one file; the file name keeps them apart across files. */
const tag = (session: string, list: ConversationEntryView[]) => list.map((entry) => ({ ...entry, id: `${session}#${entry.id}` }));
const page = (session: string, cursor?: string) =>
  api<ConversationDetail>(props.detailPath ?? "/yesimbot/api/v1/conversations/detail", {
    channel: props.channel.key,
    session,
    limit: PAGE,
    ...(cursor ? { cursor } : {}),
  });

async function loadLatest() {
  const newest = files.value.at(-1);
  if (!newest) {
    loaded.value = true;
    return;
  }
  const token = generation;
  if (latestPending === token) return;
  latestPending = token;
  try {
    const result = await page(newest);
    if (disposed || token !== generation) return;
    const fresh = tag(newest, result.entries);
    if (!loaded.value) {
      entries.value = fresh;
      older.value = { file: files.value.length - 1, cursor: result.nextCursor, more: result.hasMore };
      loaded.value = true;
      error.value = "";
      await nextTick();
      scrollToEnd();
      void fill();
      return;
    }
    const follow = atBottom.value;
    entries.value = mergeEntries(entries.value, fresh);
    error.value = "";
    if (follow) {
      await nextTick();
      scrollToEnd();
    }
  } catch (cause) {
    if (!disposed && token === generation && !loaded.value) error.value = cause instanceof Error ? cause.message : "读不到这段记录。";
  } finally {
    if (latestPending === token) latestPending = undefined;
  }
}

async function loadMore() {
  if (!loaded.value || loadingMore.value || (!older.value.more && older.value.file <= 0)) return;
  const token = generation;
  const target = older.value.more ? older.value : { file: older.value.file - 1, cursor: undefined, more: true };
  const session = files.value[target.file];
  if (!session) return;
  loadingMore.value = true;
  const scroller = scrollerEl.value;
  try {
    const result = await page(session, target.cursor);
    if (disposed || token !== generation) return;
    const top = scroller?.scrollTop ?? 0;
    const height = scroller?.scrollHeight ?? 0;
    entries.value = mergeEntries(tag(session, result.entries), entries.value);
    older.value = { file: target.file, cursor: result.nextCursor, more: result.hasMore };
    await nextTick();
    if (scroller) scroller.scrollTop = top + Math.max(0, scroller.scrollHeight - height);
  } catch (cause) {
    if (!disposed && token === generation) error.value = cause instanceof Error ? cause.message : "读不到更早的记录。";
  } finally {
    if (!disposed && token === generation) loadingMore.value = false;
  }
  void fill();
}
/** Keeps reading back until the column is taller than the window, so scrolling up is always possible. */
async function fill() {
  await nextTick();
  const element = scrollerEl.value;
  if (element && element.scrollHeight <= element.clientHeight + 40) void loadMore();
}

function reload() {
  recordDetail.value = undefined;
  generation++;
  entries.value = [];
  loaded.value = false;
  loadingMore.value = false;
  error.value = "";
  older.value = { file: -1, more: false };
  void loadLatest();
}
watch(() => props.channel.key, reload);
// Web sessions are separate conversations; never merge a replacement with the old page.
watch(
  () => files.value.at(-1),
  (file, previous) => {
    if (previous && file !== previous) {
      if (props.channel.platform === "web") reload();
      else void loadLatest();
    }
  },
);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  const saved = readView<{ entries: ConversationEntryView[]; older: typeof older.value; files: string[]; top: number; bottom: boolean }>(viewKey.value);
  if (saved && JSON.stringify(saved.files) === JSON.stringify(files.value)) {
    entries.value = saved.entries;
    older.value = saved.older;
    loaded.value = true;
    atBottom.value = saved.bottom;
    void nextTick(() => {
      if (scrollerEl.value) scrollerEl.value.scrollTop = saved.bottom ? scrollerEl.value.scrollHeight : saved.top;
    });
  }
  void loadLatest();
  timer = setInterval(() => document.visibilityState === "visible" && void loadLatest(), 3000);
});
onBeforeUnmount(() => {
  if (loaded.value && entries.value.length <= 1500)
    writeView(viewKey.value, {
      entries: entries.value,
      older: older.value,
      files: [...files.value],
      top: scrollerEl.value?.scrollTop ?? 0,
      bottom: atBottom.value,
    });
  disposed = true;
  generation++;
  clearInterval(timer);
});

/** The pictures and files the bot itself sent here, newest first, for the conversation's card. */
watch(
  () => entries.value,
  (list) =>
    emit(
      "outputs",
      list
        .filter((entry) => entry.kind !== "user" && entry.assets?.length)
        .flatMap((entry) => entry.assets ?? [])
        .reverse()
        .slice(0, 6),
    ),
  { immediate: true },
);

// ---------- What is shown ----------
interface Row {
  node: MainNode;
  /** A tool call's own result, folded into the call's row. */
  result?: MainNode;
  day?: string;
  /** First of a run from the same side, so its name, face and time show once. */
  first: boolean;
  /** Where an archived session ends and the next begins (one chat's sessions read as one column). */
  session?: string;
}
/** The session file a shown record came from: ids are tagged `<file>#<id>`, replies `reply:<file>#<id>`. */
const sessionOf = (id: string) => /([0-9A-Za-zTZ_-]+\.jsonl)#/.exec(id)?.[1];
const GAP = 5 * 60_000;
/** Messages that arrive while it is open rise into place; what was already there just shows. */
const openedAt = Date.now();
const isFresh = (timestamp: number | string) => new Date(timestamp).getTime() > openedAt;
const rows = computed<Row[]>(() => {
  const view = traces.value ? withoutDeliveredSends(readableTimeline(entries.value)) : readableReplies(entries.value);
  const { nodes, resultOf } = foldToolResults(
    buildTurnGroups(view).flatMap((group) => visibleNodes(group, { filter: "all", keyword: "", readableOnly: !traces.value })),
  );
  const result: Row[] = [];
  let previous: MainNode | undefined;
  let previousDay = "";
  let previousSession: string | undefined;
  for (const node of nodes) {
    const session = sessionOf(node.id);
    const newSession = !!previous && !!session && !!previousSession && session !== previousSession;
    if (session) previousSession = session;
    const day = new Date(node.timestamp).toDateString();
    const sameSide =
      previous &&
      previous.kind === node.kind &&
      (node.kind !== "user" || previous.sender === node.sender) &&
      node.timestamp - previous.timestamp < GAP &&
      day === previousDay;
    const folded = resultOf(node);
    result.push({
      node,
      first: !sameSide || newSession,
      ...(folded ? { result: folded } : {}),
      ...(day !== previousDay ? { day: dayLabel(node.timestamp) } : {}),
      ...(newSession ? { session: `以上已归档 · 新会话从 ${formatSessionName(session!)} 开始` } : {}),
    });
    previous = node;
    previousDay = day;
  }
  return result;
});
/**
 * The current session has no records yet (user, 2026-11-27: 「我尝试一直归档这个会话，但是失败了」): after an archive the
 * column looked unchanged and 归档 stayed on offer, though there was nothing left to archive.
 */
const activeEmpty = computed(() => props.channel.sessions.find((session) => session.isActive)?.size === 0);
const archivedTail = computed(() => {
  const last = rows.value.at(-1);
  const session = last && sessionOf(last.node.id);
  return !props.detailPath && !!session && !!props.channel.activeSession && session !== props.channel.activeSession;
});
function dayLabel(value: number) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.getFullYear() === today.getFullYear()
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}
const clock = (value: number) => formatTime(value).slice(-5);
const initial = (name?: string) => [...(name || "对方").trim()][0] ?? "?";

// ---------- Scrolling ----------
const scrollerEl = ref<HTMLElement>();
const atBottom = ref(true);
function onScroll() {
  const element = scrollerEl.value;
  if (!element) return;
  atBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  if (element.scrollTop < 160) void loadMore();
}
function scrollToEnd() {
  const element = scrollerEl.value;
  if (element) element.scrollTop = element.scrollHeight;
  atBottom.value = true;
}
// Showing or hiding traces changes the height under the reader; stay at the bottom if they were there.
watch(traces, async () => {
  const follow = atBottom.value;
  await nextTick();
  if (follow) scrollToEnd();
  void fill();
});
defineExpose({ scrollToEnd });
</script>
<style scoped>
/* UI-EXCEPTION chat-layout: chronological bubbles, sender alignment and attachment sizing have no shadcn chat component; controls and theme are shared. */
@reference "../../styles/app.css";

.thread {
  position: relative;
  overflow: hidden;
  border-radius: 20px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  container: thread / inline-size;
}
.thread-head {
  border-bottom: 1px solid var(--group-line);
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 68px;
  padding: 12px 20px;
}
.head-text {
  min-width: 0;
  display: grid;
}
.traces {
  @apply text-sm text-subtle;
  flex: none;
}
/* The title as a button: ☰ name ⌄, opening every conversation. */
/* With the list pinned the title is not a button, but it reads the same. */
.head-text.still {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.thread-head > .traces {
  margin-left: auto;
}
.head-face {
  @apply rounded-full bg-group-tile;
  flex: none;
  width: 32px;
  height: 32px;
  object-fit: cover;
}
.head-face.initial {
  @apply text-subtle font-sans text-lg;
  display: grid;
  place-items: center;
  font-weight: 600;
}
.head-face.initial :deep(.icon) {
  width: 19px;
  height: 19px;
}
.switcher {
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: -8px 0 -8px -8px;
  padding: 8px 12px 8px 8px;
  transition: background 0.15s;
  text-align: left;
  cursor: pointer;
}
.switcher:hover {
  background: var(--group-hover);
}
.switcher-text {
  display: grid;
  min-width: 0;
}
.switcher-text strong {
  @apply text-base;
  font-weight: 600;
}
.switcher-text small {
  @apply text-xs text-muted-foreground;
}

.switcher :deep(.switcher-chevron) {
  flex: none;
  width: 14px;
  height: 14px;
  transform: rotate(90deg);
}
.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* One centred column holds everything: their messages on its left, the bot's on its right, traces across it. */
/* One track no wider than the column, so a long tool call or line wraps or truncates instead of widening it. */
.column {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  padding: 20px 24px 28px;
}
/* A quick load never flashes the placeholder: it fades in only after a quarter second. */
.loading {
  display: grid;
  gap: 12px;
  padding-top: 12px;
  opacity: 0;
  animation: show-late 0.2s ease 0.25s forwards;
}
@keyframes show-late {
  to {
    opacity: 1;
  }
}
.message.fresh {
  animation: rise 0.2s cubic-bezier(0.2, 0, 0, 1);
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.top {
  @apply text-xs;
  min-height: 18px;
  margin: 4px 0;
  text-align: center;
}
/* A day: a thin rule across the column with the date in its middle. */
.day {
  @apply text-muted-foreground text-xs;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 4px;
}
.day::before,
.day::after {
  background: var(--group-line);
  content: "";
  flex: 1;
  height: 1px;
}
.message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 82%;
}
.message.first {
  margin-top: 12px;
}
.message.bot {
  justify-self: end;
}
.avatar,
.avatar-space,
.bot-avatar {
  flex: none;
  width: 30px;
}
.avatar {
  @apply rounded-full bg-group-tile text-subtle text-xs font-semibold;
  display: grid;
  place-items: center;
  height: 30px;
}
.bot-avatar {
  --avatar-size: 30px;
}
/* One track as wide as the message allows, and a bubble no wider than it: a wide table then scrolls inside its
   bubble instead of pushing the bubble past the column's clipped edge. */
.body {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
}
.bot .body {
  justify-items: end;
}
.meta {
  @apply text-xs text-muted-foreground;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.meta strong {
  @apply text-subtle;
  font-weight: 500;
}
.bubble {
  @apply text-sm;
  max-width: 100%;
  background: var(--bubble-user);
  padding: 12px 16px;
  border-radius: 8px 16px 16px 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.bot .bubble {
  @apply bg-group-tile border-0;
  white-space: normal;
  border-radius: 14px 4px 14px 14px;
}
.bubble p {
  margin: 0;
}
.bad {
  @apply text-destructive;
}
/* Private words and private answers: the chat never saw them. */
.whisper .bubble {
  @apply bg-transparent;
  border: 1.5px dashed var(--line-strong);
}
.bot.whisper .bubble {
  @apply border-primary;
}
.whisper .meta strong {
  @apply text-brand-text;
}
.bubble :deep(.assets) {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.bubble :deep(.asset) {
  @apply text-xs text-muted-foreground;
  display: grid;
  gap: 4px;
  width: 120px;
}
.bubble :deep(.asset img) {
  @apply rounded-lg;
  width: 120px;
  height: 90px;
  object-fit: cover;
}
.bubble :deep(.asset-placeholder) {
  @apply rounded-lg bg-surface-3 text-subtle;
  display: grid;
  place-items: center;
  height: 64px;
}
.trace {
  @apply rounded-lg bg-group-tile text-sm;
}
.trace.in-message {
  @apply bg-transparent;
  margin-top: 8px;
  white-space: normal;
}
.trace-button {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  text-align: left;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  min-width: 0;
  cursor: pointer;
}
.trace-title {
  @apply text-subtle;
  flex: none;
  font-weight: 500;
  white-space: nowrap;
}
.trace-title code {
  @apply font-mono text-xs text-brand-text;
}
.record-link {
  @apply text-xs text-muted-foreground;
  flex-shrink: 0;
}
.trace time,
.line time {
  @apply text-xs text-muted-foreground;
  flex: none;
  margin-left: auto;
}
.record-line {
  width: 100%;
  padding: 4px 0;
  text-align: left;
}
.trace-button:hover,
.record-line:hover {
  background: var(--group-hover);
}
.thought {
  background: var(--group-hover);
}
.line {
  @apply text-xs text-muted-foreground;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.will.go {
  @apply text-ok;
}
.jump {
  @apply shadow-sm;
  position: absolute;
  right: 20px;
  bottom: 20px;
}
.jump.raised {
  bottom: 84px;
}
.empty-state {
  padding: 32px 0;
  text-align: center;
}
/* The switch keeps its words beside the screen; only a phone-narrow column drops them. */
@container thread (max-width: 360px) {
  .traces-label {
    display: none;
  }
}
@container thread (max-width: 560px) {
  .column {
    padding: 8px 12px 16px;
  }
  .message {
    max-width: 92%;
  }
}
</style>

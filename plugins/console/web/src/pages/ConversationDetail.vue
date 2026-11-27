<template>
  <div :class="[props.embedded ? 'embedded-detail' : 'page', 'detail']">
    <header class="detail-head">
      <nav v-if="!props.embedded" class="crumbs" aria-label="位置">
        <Button variant="ghost" size="icon-sm" title="返回列表" aria-label="返回列表" @click="goBack">←</Button>
        <RouterLink :to="returnTo">{{ props.listLabel }}</RouterLink>
        <span class="muted">/</span>
        <span>会话详情</span>
      </nav>
      <div v-if="!props.embedded" class="title-row">
        <div>
          <component :is="props.embedded ? 'h4' : 'h1'">{{ sessionLabel }} 的会话</component>
          <p v-if="detail" class="summary">
            <span>已显示 {{ displayedMessageCount }} 条对话</span><span>{{ detail.summary.thoughtCount }} 次思考</span
            ><span>{{ detail.summary.toolCallCount }} 次工具调用</span
            ><span :class="{ bad: detail.summary.errorCount }">{{ detail.summary.errorCount }} 个错误</span>
          </p>
        </div>
        <span v-if="detail" class="muted loaded">已加载 {{ detail.entries.length }} 条</span>
      </div>
      <p v-if="props.embedded && runtimeDetails && detail" class="summary">
        {{ detail.entries.length }} 条记录 · {{ detail.summary.thoughtCount }} 次思考 · {{ detail.summary.toolCallCount }} 次工具调用
      </p>
      <div class="toolbar">
        <Button v-if="props.embedded" variant="ghost" size="sm" :aria-pressed="runtimeDetails" @click="runtimeDetails = !runtimeDetails">
          {{ runtimeDetails ? "返回对话" : "运行详情" }}<span v-if="runtimeErrors"> · {{ runtimeErrors }} 个异常</span>
        </Button>
        <ToggleGroup
          type="single"
          :model-value="filter"
          variant="outline"
          class="max-w-full overflow-x-auto"
          v-if="!props.embedded || runtimeDetails"
          role="group"
          aria-label="记录类型"
        >
          <ToggleGroupItem :value="item.value" as-child v-for="item in filters" :key="item.value"
            ><button type="button" :aria-pressed="filter === item.value" @click="filter = item.value">
              {{ item.label }}
            </button></ToggleGroupItem
          >
        </ToggleGroup>
        <label class="search"
          ><span class="sr-only">搜索会话记录</span
          ><Input v-model="query" type="search" :placeholder="props.embedded && !runtimeDetails ? '搜索对话' : '搜索消息、思考、工具参数或结果'"
        /></label>
      </div>
    </header>

    <Alert v-if="error" variant="destructive" as="p" role="alert">{{ error }}</Alert>
    <Card class="gap-3 p-5 max-sm:p-4" as-child v-if="loading && !detail"
      ><div class="card stack">
        <Skeleton v-for="n in 5" :key="n" class="skeleton" :style="{ height: n % 2 ? '44px' : '64px', width: n % 2 ? '60%' : '80%' }"></Skeleton></div
    ></Card>

    <Card class="gap-0 overflow-hidden p-0" as-child v-else-if="detail"
      ><section ref="timelineScroller" class="card flush timeline" @scroll.passive="handleTimelineScroll">
        <div class="timeline-top">
          <Button v-if="detail.hasMore" type="button" variant="outline" size="sm" :disabled="loadingMore || loading" @click="loadMore">
            {{ loadingMore ? "正在加载更早记录…" : `加载更早 ${CONVERSATION_PAGE_SIZE} 条` }}
          </Button>
          <span v-else-if="!props.embedded || runtimeDetails" class="muted">已到最早记录</span>
        </div>
        <template v-if="visibleGroups.length">
          <div v-for="group in visibleGroups" :key="group.id" class="turn">
            <div v-for="node in group.mainNodes" :key="node.id" class="node" :class="[node.kind, { error: node.error }]">
              <template v-if="node.kind === 'user'">
                <span class="avatar">{{ (node.sender || "用").slice(0, 1) }}</span>
                <div class="bubble-wrap">
                  <div class="meta">
                    <strong>{{ node.sender || "用户" }}</strong
                    ><time>{{ stamp(node.timestamp) }}</time>
                  </div>
                  <div class="bubble">
                    <p v-if="node.text">{{ node.text }}</p>
                    <div v-if="node.assets?.length" class="assets">
                      <a
                        v-for="asset in node.assets"
                        :key="asset.id"
                        class="asset"
                        :href="asset.dataUrl"
                        :download="asset.kind === 'file' ? asset.title || asset.id : undefined"
                        target="_blank"
                        :title="asset.id"
                      >
                        <img v-if="asset.kind === 'image' && asset.dataUrl" :src="asset.dataUrl" :alt="asset.id" />
                        <span v-else class="asset-placeholder">{{ asset.kind === "image" ? "图片" : asset.title || "文件" }}</span>
                        <small>{{ formatBytes(asset.size) }}</small>
                      </a>
                    </div>
                  </div>
                </div>
              </template>

              <template v-else-if="node.kind === 'assistant'">
                <span class="avatar bot"><BrandMark /></span>
                <div class="bubble-wrap">
                  <div class="meta">
                    <strong>机器人</strong><time>{{ stamp(node.timestamp) }}</time
                    ><span v-if="node.delivery" :class="{ 'bad-text': node.delivery === '发送失败' }">{{ node.delivery }}</span>
                  </div>
                  <div class="bubble">
                    <ChatMarkdown :text="node.reply || ''" />
                    <small v-if="node.unsupportedParts" class="muted">含其他内容，可在运行详情查看</small>
                    <button v-if="node.thought" type="button" class="trace trace-button trace-thought" @click="openRecord(node, $event, true)">
                      <span class="trace-title">思考</span><span class="record-link">查看详情</span>
                    </button>
                    <div v-if="node.assets?.length" class="assets">
                      <a v-for="asset in node.assets" :key="asset.id" class="asset" :href="asset.dataUrl" target="_blank" :title="asset.id">
                        <img v-if="asset.kind === 'image' && asset.dataUrl" :src="asset.dataUrl" :alt="asset.id" />
                        <span v-else class="asset-placeholder">{{ asset.title || "文件" }}</span>
                      </a>
                    </div>
                  </div>
                </div>
              </template>

              <button v-else-if="node.kind === 'thought'" type="button" class="trace trace-button trace-thought" @click="openRecord(node, $event)">
                <span class="trace-title">思考</span><time>{{ stamp(node.timestamp) }}</time
                ><span class="record-link">查看详情</span>
              </button>
              <button v-else-if="node.kind === 'tool-call'" type="button" class="trace trace-button tool" @click="openRecord(node, $event)">
                <span class="trace-title"
                  >调用 <code>{{ node.toolName || "工具" }}</code></span
                ><time>{{ stamp(node.timestamp) }}</time
                ><span class="record-link">查看详情</span>
              </button>
              <button
                v-else-if="node.kind === 'tool-result'"
                type="button"
                class="trace trace-button tool"
                :class="{ bad: node.error }"
                @click="openRecord(node, $event)"
              >
                <span class="trace-title"
                  >{{ node.error ? "异常" : "结果" }} <code>{{ node.toolName || "工具" }}</code></span
                ><time>{{ stamp(node.timestamp) }}</time
                ><span class="record-link">查看详情</span>
              </button>
              <button
                v-else-if="node.kind === 'will'"
                type="button"
                class="trace-line record-line will"
                :class="{ trigger: node.decision === 'trigger' }"
                @click="openRecord(node, $event)"
              >
                <span class="will-label"
                  >{{ decisionLabel(node.decision) }}<template v-if="node.repeats"> × {{ node.repeats.length }}</template></span
                ><span v-if="hasDebug(node)">策略参数</span><time>{{ stamp(node.timestamp) }}</time
                ><span class="record-link">查看详情</span>
              </button>
              <button v-else type="button" class="trace-line record-line" @click="openRecord(node, $event)">
                <Badge :variant="badgeTone(node.error && 'danger')" as="span">{{ eventTitle(node) }}</Badge
                ><time>{{ stamp(node.timestamp) }}</time
                ><span class="record-link">查看详情</span>
              </button>
            </div>
          </div>
        </template>
        <div v-else class="empty-state">
          {{ props.embedded && !runtimeDetails ? (query ? "没有匹配的对话。" : "此会话暂无回复，可查看运行详情。") : "当前过滤条件下没有记录。" }}
        </div>
      </section></Card
    >
    <ConversationRecordDialog :record="recordDetail" @close="recordDetail = undefined" @close-auto-focus="restoreRecordFocus" />
  </div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import ChatMarkdown from "../components/ChatMarkdown.vue";
import ConversationRecordDialog from "../components/ConversationRecordDialog.vue";
import { Alert } from "../components/ui/alert";
import { Badge, badgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { conversationRecord, type ConversationRecordDetail } from "../lib/conversation-record";
import { readableTimeline, readableReplies } from "../lib/conversation-replies";
import { formatBytes, formatSessionName, formatTime } from "../lib/format";
import { historyReturnTo } from "../lib/history-navigation";
import { useRouteState } from "../lib/route-state";
import BrandMark from "../shell/BrandMark.vue";
import type { ConversationDetail as DetailPayload, ConversationRequest } from "../state/history-types";
import {
  buildTurnGroups,
  decisionLabel,
  eventTitle,
  mergeEntries,
  summarizeEntries,
  visibleNodes,
  type MainNode,
  type RecordFilter,
} from "./conversation-detail-model";

const props = defineProps<{
  embedded?: boolean;
  channel?: string;
  session?: string;
  listPath: string;
  listAliases?: readonly string[];
  listQuery?: Readonly<Record<string, string>>;
  listLabel: string;
  loadPage: (request: ConversationRequest) => Promise<DetailPayload>;
}>();

const route = useRoute();
const router = useRouter();
const returnTo = computed(() => historyReturnTo(route.query.returnTo, props.listPath, { aliases: props.listAliases, query: props.listQuery }));
const CONVERSATION_PAGE_SIZE = 10;
const TIMELINE_LOAD_THRESHOLD = 120;
const TIMELINE_BOTTOM_THRESHOLD = 2;
const detail = ref<DetailPayload>();
const loading = ref(false);
const error = ref("");
const query = useRouteState(props.embedded ? "recordQ" : "q", "");
const filter = useRouteState<RecordFilter>(props.embedded ? "recordType" : "filter", "all");
const runtimeDetails = ref(false);
const displayedMessageCount = computed(
  () => readableReplies(detail.value?.entries ?? []).filter((entry) => entry.kind === "user" || entry.kind === "assistant").length,
);
const runtimeErrors = computed(() => {
  const entries = detail.value?.entries ?? [];
  const failedSends = readableReplies(entries).filter((entry) => entry.delivery === "发送失败");
  const pairedIds = new Set(failedSends.map((entry) => entry.toolCallId).filter(Boolean));
  return failedSends.length + entries.filter((entry) => (entry.error || entry.eventType?.includes("failed")) && !pairedIds.has(entry.toolCallId)).length;
});
const loadingMore = ref(false);
const timelineScroller = ref<HTMLElement | null>(null);
let timer: number | undefined;
let loadGeneration = 0;
let disposed = false;

const filters = [
  { value: "all", label: "全部" },
  { value: "chat", label: "对话" },
  { value: "thought", label: "思考" },
  { value: "tool", label: "工具" },
  { value: "event", label: "事件" },
] as const;

const channel = computed(() => (props.embedded ? (props.channel ?? "") : String(route.params.channel ?? "")));
const sessionName = computed(() => (props.embedded ? (props.session ?? "") : String(route.params.session ?? "")));
const sessionLabel = computed(() => formatSessionName(sessionName.value));
const turnGroups = computed(() =>
  detail.value
    ? buildTurnGroups(
        props.embedded ? (runtimeDetails.value ? detail.value.entries : readableReplies(detail.value.entries)) : readableTimeline(detail.value.entries),
      )
    : [],
);
/** Turns with their visible nodes for the current filter and search; empty turns are dropped. */
const visibleGroups = computed(() => {
  const view = { filter: filter.value, keyword: query.value, readableOnly: !!props.embedded && !runtimeDetails.value };
  return turnGroups.value.map((group) => ({ ...group, mainNodes: visibleNodes(group, view) })).filter((group) => group.mainNodes.length > 0);
});
const stamp = (value: number) => formatTime(value, "second");
const recordDetail = ref<ConversationRecordDetail>();
let recordTrigger: HTMLElement | undefined;
function openRecord(node: MainNode, event: MouseEvent, thoughtOnly = false) {
  recordTrigger = event.currentTarget as HTMLElement;
  const result =
    node.kind === "tool-call" && node.toolCallId
      ? turnGroups.value.flatMap((group) => group.mainNodes).find((item) => item.kind === "tool-result" && item.toolCallId === node.toolCallId)
      : undefined;
  recordDetail.value = conversationRecord(node, result, thoughtOnly);
}
function restoreRecordFocus(event: Event) {
  event.preventDefault();
  if (recordTrigger?.isConnected) recordTrigger.focus();
}
const hasDebug = (node: MainNode) => (node.repeats ?? [node]).some((item) => item.willDebug !== undefined);

async function loadLatest(reset = false): Promise<void> {
  if (!channel.value || !sessionName.value) return;
  if ((loading.value || loadingMore.value) && !reset) return;
  const generation = ++loadGeneration;
  if (reset) {
    loadingMore.value = false;
    detail.value = undefined;
  }
  const preserveExistingDetail = !reset && Boolean(detail.value);
  loading.value = true;
  error.value = "";
  try {
    const request: ConversationRequest = { channel: channel.value, session: sessionName.value, limit: CONVERSATION_PAGE_SIZE };
    const latest = await props.loadPage(request);
    if (disposed || generation !== loadGeneration) return;
    if (!preserveExistingDetail || !detail.value) {
      detail.value = latest;
      await nextTick();
      if (!disposed && generation === loadGeneration) scrollToBottom();
    } else {
      // The user may have scrolled while the request was in flight. Decide from
      // their position immediately before rendering, not when polling started.
      const followLatest = isAtBottom(timelineScroller.value);
      const entries = mergeEntries(detail.value.entries, latest.entries);
      detail.value = { ...detail.value, entries, summary: summarizeEntries(entries, latest.summary.sizeBytes) };
      if (followLatest) {
        await nextTick();
        if (!disposed && generation === loadGeneration) scrollToBottom();
      }
    }
  } catch (cause) {
    if (!disposed && generation === loadGeneration) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (!disposed && generation === loadGeneration) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  const current = detail.value;
  if (!current?.hasMore || !current.nextCursor || loading.value || loadingMore.value) return;
  const generation = loadGeneration;
  const scroller = timelineScroller.value;
  loadingMore.value = true;
  error.value = "";
  try {
    const request: ConversationRequest = { channel: channel.value, session: sessionName.value, limit: CONVERSATION_PAGE_SIZE, cursor: current.nextCursor };
    const older = await props.loadPage(request);
    if (disposed || generation !== loadGeneration || detail.value !== current) return;
    const previousScrollTop = scroller?.scrollTop ?? 0;
    const previousScrollHeight = scroller?.scrollHeight ?? 0;
    const entries = mergeEntries(older.entries, current.entries);
    detail.value = { ...current, entries, hasMore: older.hasMore, nextCursor: older.nextCursor, summary: summarizeEntries(entries, older.summary.sizeBytes) };
    await nextTick();
    if (!disposed && generation === loadGeneration && scroller) {
      scroller.scrollTop = previousScrollTop + Math.max(0, scroller.scrollHeight - previousScrollHeight);
    }
  } catch (cause) {
    if (!disposed && generation === loadGeneration) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (!disposed && generation === loadGeneration) loadingMore.value = false;
  }
}

function handleTimelineScroll(event: Event): void {
  const element = event.currentTarget as HTMLElement | null;
  if (!element || element.scrollTop > TIMELINE_LOAD_THRESHOLD) return;
  void loadMore();
}

function isAtBottom(element: HTMLElement | null): boolean {
  if (!element) return false;
  return element.scrollHeight - element.clientHeight - element.scrollTop <= TIMELINE_BOTTOM_THRESHOLD;
}

function scrollToBottom(): void {
  const element = timelineScroller.value;
  if (element) element.scrollTop = element.scrollHeight;
}

function goBack(): void {
  void router.push(returnTo.value);
}

watch(
  [channel, sessionName],
  () => {
    // Invalidate immediately, including empty identities and A → B → A changes.
    loadGeneration++;
    detail.value = undefined;
    recordDetail.value = undefined;
    loading.value = false;
    loadingMore.value = false;
    error.value = "";
    void loadLatest(true);
  },
  { flush: "sync" },
);

onMounted(() => {
  void loadLatest(true);
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void loadLatest();
  }, 3_000);
});

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration++;
  if (timer !== undefined) window.clearInterval(timer);
});
</script>

<style scoped>
/* UI-EXCEPTION history-layout: timeline rows and message bubbles are domain composition; detail dialogs and controls use shadcn. */
@reference "../styles/app.css";

.embedded-detail {
  padding: 8px 16px 16px;
  flex: 1;
  min-height: 0;
  grid-template-rows: auto auto minmax(0, 1fr);
  min-width: 0;
  display: grid;
  gap: 12px;
}
.embedded-detail h4 {
  @apply text-sm;
}
.embedded-detail .timeline {
  @apply border-0 rounded-none;
  height: auto;
  grid-row: 3;
  min-height: 0;
}
.embedded-detail .toolbar .search {
  min-width: 0;
  flex: 1 1 200px;
}
.embedded-detail .summary {
  flex-wrap: wrap;
}

.detail {
  gap: 16px;
}
.detail-head {
  display: grid;
  gap: 12px;
}
.crumbs {
  @apply text-sm;
  display: flex;
  align-items: center;
  gap: 8px;
}
.title-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.title-row h1 {
  @apply font-sans text-3xl font-semibold;
}
.summary {
  @apply text-sm text-muted-foreground;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 4px;
}
.summary .bad {
  @apply text-destructive;
}
.loaded {
  @apply text-xs;
}
.toolbar .search {
  flex: 1 1 260px;
  max-width: 420px;
}
.timeline {
  @apply bg-card;
  height: calc(100dvh - 250px);
  min-height: 420px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 0 24px;
}
.timeline-top {
  @apply text-xs;
  display: flex;
  justify-content: center;
  padding: 16px;
}
.turn {
  padding: 4px 24px;
}
.turn + .turn {
  border-top: 1px dashed var(--line);
  padding-top: 12px;
  margin-top: 8px;
}
.node {
  margin: 8px 0;
}
.node.user,
.node.assistant {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  max-width: 820px;
}
.node.assistant {
  margin-left: auto;
  flex-direction: row-reverse;
}
.avatar {
  @apply rounded-full bg-surface-3 text-subtle text-xs font-semibold;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
}
.avatar.bot {
  overflow: hidden;
}
.avatar.bot svg {
  width: 100%;
  height: 100%;
}
.bubble-wrap {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.node.assistant .bubble-wrap {
  justify-items: end;
}
.meta {
  @apply text-xs text-muted-foreground;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.meta strong {
  @apply text-subtle font-medium;
}
.bubble {
  @apply bg-muted border border-border text-sm;
  padding: 8px 12px;
  border-radius: 8px 16px 16px 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.node.assistant .bubble {
  @apply bg-brand-soft;
  border-radius: 14px 4px 14px 14px;
  border-color: transparent;
}
.assets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.asset {
  @apply text-xs text-muted-foreground;
  display: grid;
  gap: 4px;
  width: 120px;
}
.asset img {
  @apply rounded-lg border border-border;
  width: 120px;
  height: 90px;
  object-fit: cover;
}
.asset-placeholder {
  @apply rounded-lg bg-surface-3 text-subtle;
  display: grid;
  place-items: center;
  height: 90px;
}
.trace {
  @apply border border-border rounded-lg bg-card text-sm;
  margin-left: 40px;
  max-width: 860px;
}
.trace-button {
  width: calc(100% - 40px);
  text-align: left;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  min-width: 0;
}
.trace-button:hover,
.record-line:hover {
  @apply bg-muted rounded-lg;
}
.trace-icon {
  @apply text-muted-foreground;
  width: 16px;
  text-align: center;
  flex: none;
}
.trace-title {
  @apply text-subtle font-medium;
  white-space: nowrap;
  flex: none;
}
.trace-title code {
  @apply font-mono text-xs text-brand-text;
}
.record-link {
  @apply text-xs text-muted-foreground;
  flex-shrink: 0;
}
.bubble .trace-button {
  width: 100%;
  margin-left: 0;
  margin-top: 8px;
}
.record-line {
  width: calc(100% - 40px);
  padding: 8px 0;
  text-align: left;
}
.trace time,
.trace-line time {
  @apply text-xs text-muted-foreground;
  margin-left: auto;
  white-space: nowrap;
  flex: none;
}
.trace-thought {
  @apply bg-muted;
}
.trace.bad {
  border-color: color-mix(in srgb, var(--danger) 40%, var(--line));
}
.trace.bad .trace-icon,
.bad-text {
  @apply text-destructive;
}
.trace-line {
  @apply text-sm;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: 40px;
  flex-wrap: wrap;
}
.will {
  @apply text-xs text-muted-foreground;
  gap: 8px;
}
.will-label::before {
  @apply rounded-full bg-input;
  content: "";
  display: inline-block;
  width: 5px;
  height: 5px;
  margin: 0 8px 4px 0;
}
.will.trigger .will-label::before {
  @apply bg-ok;
}
@media (max-width: 640px) {
  .timeline {
    height: calc(100dvh - 280px);
  }
  .turn {
    padding: 4px 12px;
  }
  .trace,
  .trace-line {
    width: 100%;
    margin-left: 0;
  }
  .title-row h1 {
    @apply text-2xl;
  }
}
</style>

<style scoped>
.embedded-detail .timeline-top:empty {
  display: none;
}
.embedded-detail .turn {
  padding: 4px 4px;
}
.embedded-detail .node.assistant {
  margin-left: 0;
  flex-direction: row;
}
.embedded-detail .node.assistant .bubble-wrap {
  justify-items: start;
}
.embedded-detail .toolbar {
  flex-wrap: wrap;
}
.embedded-detail .toolbar .search {
  max-width: none;
  flex-basis: 140px;
}
.embedded-detail .meta {
  flex-wrap: wrap;
}
</style>

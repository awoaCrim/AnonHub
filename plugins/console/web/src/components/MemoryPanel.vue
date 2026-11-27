<template>
  <section ref="fileList" class="intent-scope space-y-2" aria-label="记忆文件" @click.capture="rememberFocus">
    <Alert v-if="error" variant="destructive"
      >{{ error }}<Button variant="outline" size="sm" :disabled="loading || busy" @click="load()">重新读取</Button></Alert
    >
    <header class="flex items-center gap-1">
      <h3 class="mr-auto text-lg font-semibold">记忆</h3>
      <Button
        variant="ghost"
        size="icon-sm"
        class="intent-target rounded-full text-muted-foreground"
        aria-label="刷新记忆文件"
        :disabled="loading || busy"
        @click="load()"
        ><RefreshCw class="size-4" :class="{ 'animate-spin': loading }"
      /></Button>
    </header>
    <LoadingRows v-if="loading && !loaded" label="正在读取记忆文件" />
    <p v-else-if="loaded && !items.length && !error" class="arrive px-2 text-sm text-muted-foreground">暂无文档</p>
    <div v-if="items.length" class="arrive-list grid gap-1">
      <button v-for="item in items" :key="item.id" type="button" class="side-row memory-file" :disabled="busy" @click="edit(item)">
        <span class="side-row-icon"><FileText class="size-4" /></span>
        <strong class="side-row-title min-w-0 flex-1">{{ documentTitle(item.content) }}</strong>
        <span
          v-if="item.attachments?.length"
          class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
          :aria-label="`${item.attachments.length} 个附件`"
          ><Paperclip class="size-3.5" />{{ item.attachments.length }}</span
        >
        <span class="shrink-0 text-xs text-muted-foreground">{{ labels[item.visibility] }}</span>
      </button>
    </div>
    <Button v-if="cursor" variant="ghost" size="sm" class="w-full rounded-full" :disabled="loading || busy" @click="load(true)">{{
      loading ? "正在读取…" : "加载更多记忆"
    }}</Button>
    <Dialog :open="!!opened && !!selected" @update:open="updateOpen">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" :aria-describedby="undefined" @close-auto-focus="restoreFocus">
        <template v-if="selected">
          <DialogHeader class="pr-6">
            <DialogTitle class="truncate leading-normal">{{ documentTitle(selected.content) }}</DialogTitle>
          </DialogHeader>
          <label class="grid gap-2 text-sm"
            >记忆正文<Textarea
              v-model="draft"
              aria-label="记忆正文"
              class="min-h-72 leading-relaxed"
              :aria-invalid="!!problem"
              @change="commit()"
              @input="problem = ''"
          /></label>
          <p v-if="problem" class="text-sm text-destructive" role="alert">{{ problem }}</p>
          <section v-if="selected.attachments?.length" class="grid gap-1 text-sm" aria-label="附件">
            附件<ChatAttachments :attachments="attachmentsOf(selected)" @open="viewing = $event" />
          </section>
          <section class="space-y-4 rounded-lg border p-3 text-sm" aria-label="来源、范围与版本">
            <h3 class="font-medium">来源、范围与版本</h3>
            <PickerMenu :model-value="visibility" field label="可见范围" :options="visibilityOptions" @update:model-value="setVisibility" />
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt class="text-muted-foreground">来源</dt>
              <dd class="break-all">{{ sourceOf(selected) }}</dd>
              <dt class="text-muted-foreground">更新</dt>
              <dd>{{ selected.updatedAt ? formatTime(selected.updatedAt) : "未记录" }}</dd>
              <dt class="text-muted-foreground">版本</dt>
              <dd>{{ selected.revision }}</dd>
            </dl>
            <Button variant="ghost" size="sm" class="text-destructive" :disabled="busy" @click="remove(selected)"><Trash2 class="size-4" />删除记忆</Button>
          </section>
        </template>
      </DialogContent>
    </Dialog>
    <AttachmentViewer :attachment="viewing" @close="viewing = undefined" />
  </section>
</template>
<script setup lang="ts">
import { platformLabel } from "@yesimbot/contracts/platforms";
import { DocumentText as FileText, Paperclip, Refresh as RefreshCw, Trash2 } from "reicon-vue";
import { computed, onBeforeUnmount, ref } from "vue";

import type { ChatAttachment } from "../../../src/shared/chat";
import { api, ApiError } from "../lib/api";
import { confirmDialog } from "../lib/dialog";
import { documentTitle } from "../lib/document-summary";
import { trackEditor } from "../lib/editor-guard";
import { formatTime } from "../lib/format";
import { toast } from "../lib/toast";
import AttachmentViewer from "./AttachmentViewer.vue";
import ChatAttachments from "./ChatAttachments.vue";
import LoadingRows from "./LoadingRows.vue";
import PickerMenu from "./PickerMenu.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Textarea } from "./ui/textarea";
type Visibility = "owner" | "conversation" | "shared";

interface Memory {
  id: string;
  content: string;
  visibility: Visibility;
  revision: number;
  updatedAt?: number;
  source?: { platform?: string; channelId?: string };
  attachments?: { index: number; name?: string; mediaType: string; byteLength: number }[];
}
/** Pictures a browser shows in place; anything else opens as a file. */
const SHOWN_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
defineProps<{ opened?: boolean }>();
const emit = defineEmits<{ open: []; close: [] }>();
const fileList = ref<HTMLElement>(),
  items = ref<Memory[]>([]),
  cursor = ref<string>(),
  loaded = ref(false),
  loading = ref(false),
  busy = ref(false),
  error = ref("");
const selected = ref<Memory>(),
  viewing = ref<ChatAttachment>(),
  draft = ref(""),
  visibility = ref<Visibility>("owner"),
  problem = ref("");
/** Text typed but not saved yet: it is saved when the box loses focus or the dialog closes. */
const dirty = computed(() => !!selected.value && (draft.value !== selected.value.content || visibility.value !== selected.value.visibility));
const labels = { owner: "主人私有", conversation: "原会话", shared: "公开共享" };
const visibilityOptions = computed(() => ["owner", "conversation", "shared"].map((value) => ({ value, label: labels[value as Visibility] })));
let disposed = false,
  queued = false,
  lastTrigger: HTMLElement | undefined;
trackEditor(
  () => dirty.value,
  () => busy.value,
);
onBeforeUnmount(() => {
  disposed = true;
});
function attachmentsOf(item: Memory): ChatAttachment[] {
  return (item.attachments ?? []).map((attachment) => {
    const image = SHOWN_IMAGES.has(attachment.mediaType);
    return {
      kind: image ? "image" : "file",
      name: attachment.name ?? `${image ? "图片" : "文件"} ${attachment.index}`,
      url: `/yesimbot/api/v1/memory/attachment?${new URLSearchParams({ id: item.id, index: String(attachment.index) })}`,
      size: attachment.byteLength,
    };
  });
}

function sourceOf(item: Memory) {
  return item.source?.platform ? `${platformLabel(item.source.platform)}${item.source.channelId ? ` · ${item.source.channelId}` : ""}` : "原有记忆";
}

async function load(more = false) {
  if (loading.value || busy.value) return;
  loading.value = true;
  error.value = "";
  try {
    const result = await api<{ memories: Memory[]; nextCursor?: string }>(
      `/yesimbot/api/v1/memory${more && cursor.value ? "?cursor=" + encodeURIComponent(cursor.value) : ""}`,
      undefined,
      { fresh: true },
    );
    if (!disposed) {
      items.value = more ? [...items.value, ...result.memories] : result.memories;
      cursor.value = result.nextCursor;
      loaded.value = true;
      if (selected.value) {
        const current = items.value.find((item) => item.id === selected.value?.id);
        if (current) select(current);
        else {
          selected.value = undefined;
          emit("close");
        }
      }
    }
  } catch (cause) {
    if (!disposed)
      error.value =
        cause instanceof ApiError && cause.code === "memory_unavailable" ? "记忆服务尚未就绪，暂时无法读取文件。" : "记忆文件暂时无法读取，请稍后重试。";
  } finally {
    loading.value = false;
  }
}

function select(item: Memory) {
  selected.value = item;
  draft.value = item.content;
  visibility.value = item.visibility;
  problem.value = "";
}

function rememberFocus(event: MouseEvent) {
  lastTrigger = (event.target as Element).closest<HTMLElement>("button") ?? lastTrigger;
}

function restoreFocus(event: Event) {
  event.preventDefault();
  const target = lastTrigger?.isConnected ? lastTrigger : fileList.value?.querySelector<HTMLElement>("button:not(:disabled)");
  target?.focus();
}

function edit(item: Memory) {
  if (busy.value) return;
  select(item);
  emit("open");
}

function updateOpen(open: boolean) {
  if (!open) close();
}

function setVisibility(value: string) {
  visibility.value = value as Visibility;
  void commit();
}

/** Closing saves what was typed (an emptied text is not saved) and never asks. */
function close() {
  if (busy.value) return;
  if (dirty.value && draft.value.trim()) void commit();
  selected.value = undefined;
  emit("close");
}

/**
 * Saves the open memory's text and range once they differ from the saved copy (user, 2026-11-26: 即改即存), with 撤销.
 * A save asked for while one runs follows it. A failed save keeps the typed text; a conflict shows the latest copy.
 */
async function commit(target?: { id: string; content: string; visibility: Visibility }) {
  const item = target ? items.value.find((row) => row.id === target.id) : selected.value;
  if (!item) return;
  const content = target?.content ?? draft.value,
    range = target?.visibility ?? visibility.value;
  if (content === item.content && range === item.visibility) return;
  if (!content.trim()) {
    problem.value = "记忆正文不能为空。";
    return;
  }
  if (busy.value) {
    queued = true;
    return;
  }
  const before = { id: item.id, content: item.content, visibility: item.visibility };
  busy.value = true;
  error.value = "";
  try {
    const result = await api<Memory>("/yesimbot/api/v1/memory", {
      action: "update",
      id: item.id,
      revision: item.revision,
      content,
      ...(range !== item.visibility ? { visibility: range } : {}),
    });
    if (disposed) return;
    items.value = items.value.map((row) => (row.id === item.id ? result : row));
    if (selected.value?.id === item.id) {
      selected.value = result;
      if (target) select(result);
    }
    toast(target ? "已撤销" : "已保存", "ok", undefined, target ? undefined : { label: "撤销", run: () => void commit(before) });
  } catch (cause) {
    if (disposed) return;
    if (cause instanceof ApiError && cause.code === "memory_revision_conflict") {
      toast("这份记忆刚在别处更新，已显示最新内容。", "danger");
      await refreshOne(item.id);
    } else toast("没能保存，请稍后重试。", "danger");
  } finally {
    busy.value = false;
    if (queued && !disposed) {
      queued = false;
      void commit();
    }
  }
}

/** Rereads the list after a conflict and shows the latest copy of the open memory. */
async function refreshOne(id: string) {
  busy.value = false;
  await load();
  const latest = items.value.find((row) => row.id === id);
  if (latest && selected.value?.id === id) select(latest);
}

async function remove(item: Memory) {
  if (await confirmDialog({ title: "删除这份记忆？", message: "删除后不再用于后续回复，不会删除原聊天记录。", confirmLabel: "删除记忆", danger: true }))
    await removeNow(item);
}

async function removeNow(item: Memory) {
  busy.value = true;
  error.value = "";
  try {
    await api("/yesimbot/api/v1/memory", { action: "delete", id: item.id, revision: item.revision });
    if (disposed) return;
    items.value = items.value.filter((row) => row.id !== item.id);
    selected.value = undefined;
    emit("close");
    toast("记忆已删除。");
  } catch {
    if (!disposed) toast("没能删除，请稍后重试。", "danger");
  } finally {
    busy.value = false;
  }
}
void load();
</script>

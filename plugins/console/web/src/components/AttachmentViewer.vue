<template>
  <Dialog :open="!!attachment" @update:open="(open) => !open && emit('close')">
    <DialogContent
      :show-close-button="false"
      class="h-[min(920px,calc(100dvh-2rem))] w-[min(1120px,calc(100vw-2rem))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:rounded-none max-sm:border-0"
    >
      <header class="bar">
        <div class="flex min-w-0 flex-1 items-baseline gap-3">
          <DialogTitle class="truncate text-lg font-semibold" :title="attachment?.name">{{ attachment?.name }}</DialogTitle>
          <p v-if="cut" class="shrink-0 text-sm text-muted-foreground max-sm:hidden" role="status">{{ cut }}</p>
          <DialogDescription class="sr-only">{{ detail }}</DialogDescription>
        </div>
        <ToggleGroup
          v-if="modes.length && text !== undefined"
          type="single"
          variant="outline"
          size="sm"
          :model-value="mode"
          aria-label="显示方式"
          @update:model-value="(value) => value && (mode = value as 'preview' | 'source')"
        >
          <ToggleGroupItem v-for="item in modes" :key="item.value" :value="item.value" class="px-3 text-xs">{{ item.label }}</ToggleGroupItem>
        </ToggleGroup>
        <Button
          v-if="text !== undefined"
          variant="ghost"
          size="icon-sm"
          :aria-label="copied ? '已复制' : '复制全文'"
          :title="copied ? '已复制' : '复制全文'"
          @click="copy"
          ><Check v-if="copied" class="size-4" /><Copy v-else class="size-4"
        /></Button>
        <Button v-if="downloadUrl" variant="ghost" size="icon-sm" as="a" :href="downloadUrl" :download="attachment?.name" aria-label="下载" title="下载"
          ><Download class="size-4"
        /></Button>
        <DialogClose as-child>
          <Button variant="ghost" size="icon-sm" aria-label="关闭"><X class="size-4" /></Button>
        </DialogClose>
      </header>

      <div class="body">
        <div v-if="shownImage" class="stage">
          <img :src="shownImage" :alt="attachment?.name" :class="{ actual }" :title="actual ? '适应窗口' : '原始大小'" @click="actual = !actual" />
        </div>
        <p v-else-if="loading" class="center text-sm text-muted-foreground" aria-busy="true">正在打开…</p>
        <div v-else-if="error" class="center">
          <Alert variant="warn" as="p">{{ error }}</Alert>
        </div>
        <article v-else-if="mode === 'preview' && format.view === 'markdown' && text !== undefined" class="document">
          <ChatMarkdown :text="text" />
        </article>
        <div v-else-if="mode === 'preview' && table" class="table-wrap">
          <table>
            <thead>
              <tr>
                <th v-for="(cell, index) in table.rows[0]" :key="index">{{ cell }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in table.rows.slice(1)" :key="index">
                <td v-for="(cell, column) in row" :key="column">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <pre v-else-if="code !== undefined" class="code"><code v-html="code"></code></pre>
        <pre v-else-if="text !== undefined" class="plain">{{ text }}</pre>
        <iframe v-else-if="media && format.view === 'pdf'" :src="media" :title="attachment?.name" class="pdf"></iframe>
        <div v-else-if="media && format.view === 'video'" class="stage"><video :src="media" controls playsinline></video></div>
        <div v-else-if="media && format.view === 'audio'" class="center"><audio :src="media" controls></audio></div>
        <div v-else-if="attachment" class="center gap-4 text-center">
          <File class="size-10 text-muted-foreground" aria-hidden="true" />
          <p class="text-sm text-muted-foreground">不能在网页里预览</p>
          <Button v-if="downloadUrl" as="a" :href="downloadUrl" :download="attachment.name"><Download class="size-4" />下载</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
<script setup lang="ts">
import { Check, Copy, Download, File, X } from "reicon-vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";

import type { ChatAttachment } from "../../../src/shared/chat";
import { escapeHtml, formatJson, highlightCode, parseTable, TABLE_ROWS } from "../lib/file-preview";
import { fileFormat } from "../lib/file-types";
import { formatBytes } from "../lib/format";
import ChatMarkdown from "./ChatMarkdown.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

/** Shown text stops here; the rest is in the download. */
const TEXT_LIMIT = 500_000;

/**
 * One chat attachment, opened in a window that gives nearly all its room to the file: an image at full size, Markdown
 * rendered, JSON indented, a CSV as a table, code highlighted, a PDF, audio or video in the browser's own player, and
 * anything else as a download. A file is read once; what the server says it is and its name decide how it is shown.
 */
const props = defineProps<{ attachment?: ChatAttachment }>();
const emit = defineEmits<{ close: [] }>();
const loading = ref(false),
  error = ref(""),
  text = ref<string>(),
  /** The highlighted source, when the file is shown as code. */
  code = ref<string>(),
  table = ref<{ rows: string[][]; more: boolean }>(),
  /** An image, PDF or recording the file turned out to be, as a local URL. */
  blobUrl = ref<string>(),
  truncated = ref(false),
  /** Markdown and tables: rendered, or their source. */
  mode = ref<"preview" | "source">("preview"),
  actual = ref(false),
  copied = ref(false);
let generation = 0,
  copiedTimer: ReturnType<typeof setTimeout> | undefined;

const format = computed(() => fileFormat(props.attachment?.name ?? ""));
/** Markdown and tables can be read rendered or as their source. */
const modes = computed(() =>
  format.value.view === "markdown"
    ? [
        { value: "preview", label: "预览" },
        { value: "source", label: "源码" },
      ]
    : format.value.view === "table"
      ? [
          { value: "preview", label: "表格" },
          { value: "source", label: "源码" },
        ]
      : [],
);
/** Console URLs download through the server; a not-yet-sent local preview has nothing to download. */
const served = computed(() => !!props.attachment?.url?.startsWith("/"));
const fileImage = ref<string>();
const shownImage = computed(() => (props.attachment?.kind === "image" ? props.attachment.url : fileImage.value));
const media = computed(() => (fileImage.value ? undefined : blobUrl.value));
const downloadUrl = computed(() => (served.value ? `${props.attachment!.url}&download=1` : undefined));
/** Shown only when part of the file is left out; its kind and size are for screen readers. */
const cut = computed(() => (truncated.value ? "只显示了前一部分" : table.value?.more && mode.value === "preview" ? `只显示前 ${TABLE_ROWS} 行` : ""));
const detail = computed(() => {
  const attachment = props.attachment;
  if (!attachment) return "";
  return [attachment.kind === "image" ? "图片" : format.value.label || "文件", attachment.size ? formatBytes(attachment.size) : ""].filter(Boolean).join(" · ");
});

function release() {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
  blobUrl.value = fileImage.value = undefined;
}
onBeforeUnmount(() => {
  generation++;
  clearTimeout(copiedTimer);
  release();
});

watch(
  () => props.attachment,
  async (attachment) => {
    const token = ++generation;
    release();
    text.value = code.value = table.value = undefined;
    error.value = "";
    truncated.value = actual.value = copied.value = false;
    mode.value = "preview";
    loading.value = false;
    if (!attachment?.url || attachment.kind === "image") return;
    loading.value = true;
    try {
      const response = await fetch(attachment.url, { credentials: "same-origin", headers: { Accept: "*/*" } });
      if (!response.ok) {
        const reason = ((await response.json().catch(() => ({}))) as { message?: string }).message;
        throw Error(reason === "computer_offline" ? "电脑现在不在线，连上之后才能打开这个文件。" : "打不开这个文件，它可能已经被删除了。");
      }
      const type = response.headers.get("content-type") ?? "";
      const blob = await response.blob();
      if (token !== generation) return;
      const { view, type: mediaType } = format.value;
      if (type.startsWith("image/")) fileImage.value = blobUrl.value = URL.createObjectURL(blob);
      else if (type.startsWith("text/")) {
        const words = await blob.text();
        if (token !== generation) return;
        truncated.value = words.length > TEXT_LIMIT;
        text.value = truncated.value ? words.slice(0, TEXT_LIMIT) : words;
      } else if (mediaType && (view !== "pdf" || navigator.pdfViewerEnabled)) blobUrl.value = URL.createObjectURL(new Blob([blob], { type: mediaType }));
    } catch (cause) {
      if (token === generation) error.value = cause instanceof Error && /[一-龥]/.test(cause.message) ? cause.message : "网络连接不上，稍后再试。";
    } finally {
      if (token === generation) loading.value = false;
    }
  },
  { immediate: true },
);

// What the text looks like in the chosen mode: a table is parsed once, source and code are highlighted as asked.
watch([text, mode], async ([words, shown]) => {
  const token = generation;
  const { view, language, delimiter } = format.value;
  if (words === undefined) return;
  if (view === "table" && !table.value && delimiter) {
    const parsed = await parseTable(words, delimiter).catch(() => undefined);
    if (token === generation) table.value = parsed;
  }
  const source =
    view === "json"
      ? highlightCode(formatJson(words), "json")
      : view === "code"
        ? highlightCode(words, language)
        : shown === "source" && view === "markdown"
          ? highlightCode(words, "markdown")
          : shown === "source" && view === "table"
            ? Promise.resolve(escapeHtml(words))
            : undefined;
  const html = source && (await source.catch(() => escapeHtml(words)));
  if (token === generation) code.value = html;
});

async function copy() {
  if (text.value === undefined) return;
  try {
    await navigator.clipboard.writeText(text.value);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1500);
  } catch {
    error.value = "复制失败，请手动选择文字。";
  }
}
</script>
<style scoped>
@reference "../styles/app.css";

/* Syntax colours (GitHub's), light and dark, on the code itself: DialogContent's box is outside these scoped styles. */
.code {
  --code-comment: #6e7781;
  --code-keyword: #cf222e;
  --code-string: #0a3069;
  --code-number: #0550ae;
  --code-title: #8250df;
  --code-builtin: #953800;
  --code-tag: #116329;
  --code-inserted: #116329;
  --code-deleted: #82071e;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .code {
    --code-comment: #8b949e;
    --code-keyword: #ff7b72;
    --code-string: #a5d6ff;
    --code-number: #79c0ff;
    --code-title: #d2a8ff;
    --code-builtin: #ffa657;
    --code-tag: #7ee787;
    --code-inserted: #7ee787;
    --code-deleted: #ffa198;
  }
}
:root[data-theme="dark"] .code {
  --code-comment: #8b949e;
  --code-keyword: #ff7b72;
  --code-string: #a5d6ff;
  --code-number: #79c0ff;
  --code-title: #d2a8ff;
  --code-builtin: #ffa657;
  --code-tag: #7ee787;
  --code-inserted: #7ee787;
  --code-deleted: #ffa198;
}

/* One slim bar: the name, how to show it, copy, download, close. Everything under it is the file. */
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 12px 12px 12px 24px;
  border-bottom: 1px solid var(--line);
}
.body {
  position: relative;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
}
/* A picture or video fits the window; a click shows an image at its own size, scrolling when it is larger. */
.stage {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: auto;
  background: var(--surface-2);
}
.stage > img,
.stage > video {
  display: block;
  max-width: 100%;
  max-height: 100%;
  margin: auto;
  object-fit: contain;
}
.stage > img {
  cursor: zoom-in;
}
.stage > img.actual {
  max-width: none;
  max-height: none;
  cursor: zoom-out;
}
.document {
  max-width: 820px;
  margin: 0 auto;
  padding: 32px 48px 64px;
  font-size: 16px;
  line-height: 1.75;
}
.code,
.plain {
  min-height: 100%;
  margin: 0;
  padding: 16px 24px 32px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 14px;
  line-height: 1.65;
  tab-size: 4;
}
/* Code keeps its lines and scrolls sideways; plain text wraps like prose. */
.code {
  width: max-content;
  min-width: 100%;
  white-space: pre;
}
.plain {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.code :deep(.hljs-comment),
.code :deep(.hljs-quote) {
  color: var(--code-comment);
  font-style: italic;
}
.code :deep(.hljs-keyword),
.code :deep(.hljs-selector-tag),
.code :deep(.hljs-meta .hljs-keyword),
.code :deep(.hljs-doctag),
.code :deep(.hljs-template-tag),
.code :deep(.hljs-type),
.code :deep(.hljs-variable.language_) {
  color: var(--code-keyword);
}
.code :deep(.hljs-string),
.code :deep(.hljs-regexp),
.code :deep(.hljs-meta .hljs-string) {
  color: var(--code-string);
}
.code :deep(.hljs-number),
.code :deep(.hljs-literal),
.code :deep(.hljs-attr),
.code :deep(.hljs-attribute),
.code :deep(.hljs-variable),
.code :deep(.hljs-template-variable),
.code :deep(.hljs-selector-attr),
.code :deep(.hljs-selector-class),
.code :deep(.hljs-selector-id),
.code :deep(.hljs-symbol),
.code :deep(.hljs-link) {
  color: var(--code-number);
}
.code :deep(.hljs-title),
.code :deep(.hljs-title.class_),
.code :deep(.hljs-title.function_),
.code :deep(.hljs-section) {
  color: var(--code-title);
}
.code :deep(.hljs-section) {
  font-weight: 600;
}
.code :deep(.hljs-built_in),
.code :deep(.hljs-meta),
.code :deep(.hljs-params) {
  color: var(--code-builtin);
}
.code :deep(.hljs-name),
.code :deep(.hljs-tag),
.code :deep(.hljs-bullet) {
  color: var(--code-tag);
}
.code :deep(.hljs-emphasis) {
  font-style: italic;
}
.code :deep(.hljs-strong) {
  font-weight: 600;
}
.code :deep(.hljs-addition) {
  color: var(--code-inserted);
}
.code :deep(.hljs-deletion) {
  color: var(--code-deleted);
}
/* The header stays in sight while the rows scroll under it. */
.table-wrap {
  min-width: 100%;
  width: max-content;
}
table {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
th,
td {
  max-width: 420px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
th:first-child,
td:first-child {
  padding-left: 24px;
}
th {
  @apply bg-muted font-medium;
  position: sticky;
  top: 0;
  white-space: nowrap;
}
tbody tr:hover td {
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
.pdf {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
audio {
  width: min(520px, 100%);
}
@media (max-width: 639px) {
  .bar {
    padding: max(8px, env(safe-area-inset-top)) 8px 8px 16px;
  }
  .document {
    padding: 24px 20px 48px;
  }
  .code,
  .plain {
    padding: 16px 16px 32px;
  }
}
</style>

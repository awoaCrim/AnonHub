<template>
  <Dialog :open="!closed" @update:open="!$event && close()"
    ><DialogContent
      class="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      :show-close-button="false"
      :aria-describedby="undefined"
      @close-auto-focus="restoreFocus"
    >
      <header class="fb-head">
        <DialogTitle>{{ mode === "directory" ? "选择文件夹" : "选择文件" }}</DialogTitle>
        <Button variant="ghost" size="icon-sm" type="button" class="rounded-full" aria-label="关闭" @click="close"><X class="size-4" /></Button>
      </header>
      <nav class="crumbs" aria-label="当前位置">
        <Button variant="ghost" class="h-auto min-h-9 whitespace-normal" as-child
          ><button type="button" class="crumb" :disabled="unavailable" @click="open('.')">数据目录</button></Button
        >
        <template v-for="crumb in crumbs" :key="crumb.path"
          ><span aria-hidden="true">/</span
          ><Button variant="ghost" class="h-auto min-h-9 whitespace-normal" as-child
            ><button type="button" class="crumb" :disabled="unavailable" @click="open(crumb.path)">{{ crumb.name }}</button></Button
          ></template
        >
      </nav>
      <label class="search fb-search"
        ><span class="sr-only">筛选</span><Input v-model="filter" type="search" placeholder="筛选当前文件夹" :disabled="unavailable"
      /></label>
      <div class="fb-list" role="listbox" :aria-busy="loading" aria-label="文件列表">
        <Alert v-if="error" variant="destructive" as="p">{{ error }}</Alert>
        <template v-else-if="loading && !listing"><Skeleton v-for="n in 5" :key="n" class="skeleton" style="height: 34px; margin: 4px 0"></Skeleton></template>
        <template v-else>
          <Button variant="ghost" class="h-auto min-h-9 whitespace-normal" as-child v-if="listing?.parent"
            ><button type="button" class="fb-row" :disabled="unavailable" @click="open(listing.parent)">
              <span class="fb-icon" aria-hidden="true">↰</span><span class="fb-name">上一级</span>
            </button></Button
          >
          <Button variant="ghost" class="h-auto min-h-9 whitespace-normal" as-child v-for="entry in entries" :key="entry.path"
            ><button
              type="button"
              role="option"
              class="fb-row"
              :class="{ picked: picked === entry.path, dim: entry.type === 'file' && (!matches(entry) || mode === 'directory') }"
              :aria-selected="picked === entry.path"
              :disabled="unavailable || (entry.type === 'file' && (!matches(entry) || mode === 'directory'))"
              :title="entry.type === 'directory' ? '双击打开' : '双击选择'"
              @click="select(entry)"
              @dblclick="activate(entry)"
              @keydown.enter.prevent="activate(entry)"
            >
              <span class="fb-icon" aria-hidden="true">{{ entry.type === "directory" ? "📁" : "📄" }}</span>
              <span class="fb-name">{{ entry.name }}</span>
              <small v-if="entry.type === 'file'">{{ formatBytes(entry.size) }}</small>
              <small v-else class="fb-open" @click.stop="open(entry.path)">打开 ›</small>
            </button></Button
          >
          <p v-if="!entries.length" class="empty-state">此文件夹是空的</p>
          <p v-if="listing?.truncated" class="muted fb-note">只显示前 500 项，请用筛选或进入子文件夹。</p>
        </template>
      </div>
      <footer class="fb-foot">
        <span class="mono muted truncate">{{ picked ?? (canPickFolder ? listing?.dir : "") ?? "" }}</span>
        <Button variant="outline" type="button" @click="close">取消</Button>
        <Button variant="default" type="button" :disabled="!canConfirm" @click="confirm">
          {{ picked || !canPickFolder ? "选择" : "选择此文件夹" }}
        </Button>
      </footer>
    </DialogContent></Dialog
  >
</template>

<script setup lang="ts">
import { X } from "reicon-vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import type { FileEntry, FileListing } from "../../../src/shared/files";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { fileError, formatBytes, listFiles } from "../lib/files";

const props = defineProps<{
  start: string;
  /** "file" picks files, "directory" picks folders, "any" allows both. */
  mode: "file" | "directory" | "any";
  extensions: string[];
  disabled?: boolean;
  returnFocusTo?: HTMLElement;
}>();
const emit = defineEmits<{ choose: [path: string]; close: [] }>();

const listing = ref<FileListing>();
const loading = ref(false);
const error = ref("");
const picked = ref<string>();
const filter = ref("");
const closed = ref(false);
const unavailable = computed(() => !!props.disabled || loading.value || closed.value);
let token = 0,
  disposed = false;

const crumbs = computed(() => {
  const dir = listing.value?.dir ?? ".";
  if (dir === ".") return [];
  const parts = dir.split("/");
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
});
const matches = (entry: FileEntry) =>
  entry.type === "directory" || !props.extensions.length || props.extensions.some((ext) => entry.name.toLowerCase().endsWith(ext));
const entries = computed(() =>
  (listing.value?.entries ?? []).filter(
    (entry) => (props.mode !== "directory" || entry.type === "directory") && (!filter.value || entry.name.toLowerCase().includes(filter.value.toLowerCase())),
  ),
);
const canPickFolder = computed(() => props.mode !== "file");
const selectedPath = computed(() => {
  if (!picked.value) return canPickFolder.value ? listing.value?.dir : undefined;
  const entry = listing.value?.entries.find((entry) => entry.path === picked.value);
  if (!entry) return undefined;
  return entry.type === "directory" ? (canPickFolder.value ? entry.path : undefined) : props.mode !== "directory" && matches(entry) ? entry.path : undefined;
});
const canConfirm = computed(() => !unavailable.value && !error.value && !!selectedPath.value);

async function open(dir: string) {
  if (disposed || unavailable.value) return;
  const current = ++token;
  loading.value = true;
  error.value = "";
  picked.value = undefined;
  filter.value = "";
  try {
    let result: FileListing;
    try {
      result = await listFiles(dir);
    } catch (e) {
      if (disposed || current !== token) return;
      if (dir === ".") throw e;
      result = await listFiles(".");
    }
    if (!disposed && current === token) listing.value = result;
  } catch (e) {
    if (disposed || current !== token) return;
    error.value = fileError(e);
  } finally {
    if (!disposed && current === token) loading.value = false;
  }
}

function activate(entry: FileEntry) {
  if (disposed || unavailable.value || error.value || !entries.value.some((item) => item.path === entry.path)) return;
  if (entry.type === "directory") void open(entry.path);
  else if (props.mode !== "directory" && matches(entry)) finish(entry.path);
}

/** A single tap opens folders unless folders themselves can be chosen (then "打开 ›" opens them). */
function select(entry: FileEntry) {
  if (disposed || unavailable.value || error.value || !entries.value.some((item) => item.path === entry.path)) return;
  if (entry.type === "directory" && !canPickFolder.value) void open(entry.path);
  else if (entry.type === "directory" || (props.mode !== "directory" && matches(entry))) picked.value = entry.path;
}

function confirm() {
  if (!disposed && canConfirm.value) finish(selectedPath.value!);
}

function finish(path: string) {
  closed.value = true;
  ++token;
  emit("choose", path);
}

function close() {
  if (disposed || closed.value) return;
  closed.value = true;
  ++token;
  loading.value = false;
  emit("close");
}

function restoreFocus(event: Event) {
  const target = props.returnFocusTo;
  if (!target?.isConnected) return;
  event.preventDefault();
  if (!target.matches(":disabled")) target.focus({ preventScroll: true });
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) {
      ++token;
      loading.value = false;
      picked.value = undefined;
    } else if (!listing.value) void open(props.start || ".");
  },
  { flush: "sync" },
);

onMounted(async () => {
  await nextTick();
  void open(props.start || ".");
});
onUnmounted(() => {
  disposed = true;
  ++token;
});
</script>

<style scoped>
@reference "../styles/app.css";

.fb-head,
.fb-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 16px;
}
.fb-head {
  @apply border-b border-border;
}
.fb-head h3 {
  @apply text-base;
  flex: 1;
}
.fb-foot {
  @apply border-t border-border;
}
.fb-foot > span {
  @apply text-xs;
  flex: 1;
  min-width: 0;
}
.crumbs {
  @apply text-sm text-muted-foreground;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 12px 16px 0;
}
.crumb {
  padding: 4px 4px;
  cursor: pointer;
}
.fb-search {
  margin: 12px 16px 8px;
}
.fb-list {
  flex: 1;
  min-height: 200px;
  overflow-y: auto;
  padding: 4px 12px 12px;
}
.fb-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px 8px;
  text-align: left;
  cursor: pointer;
}
.fb-row.picked {
  @apply bg-brand-soft text-brand-text;
}
.fb-row.dim {
  opacity: 0.45;
}
.fb-icon {
  width: 18px;
  text-align: center;
  flex: none;
}
.fb-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fb-open {
  @apply rounded-md;
  padding: 4px 8px;
}
.fb-open:hover {
  @apply bg-card text-brand-text;
}
.fb-note {
  @apply text-xs;
  padding: 8px 8px;
}
</style>

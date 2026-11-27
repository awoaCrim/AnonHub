<template>
  <div class="path-field" :class="{ dragging }" @dragover.prevent="dragOver" @dragleave.self="dragging = false" @drop.prevent="dropped">
    <div class="path-row">
      <Input
        :id="inputId"
        type="text"
        class="mono-input"
        autocomplete="off"
        spellcheck="false"
        :value="value"
        :placeholder="placeholder"
        :disabled="unavailable"
        @change="type(($event.target as HTMLInputElement).value)"
      />
      <Button v-if="allowsFile" variant="outline" type="button" :disabled="unavailable" @click="openPicker">上传</Button>
      <Button variant="outline" type="button" :disabled="unavailable" @click="startBrowsing">浏览</Button>
      <!-- UI-EXCEPTION native-file: the hidden native picker exposes FileList and click() to the browser upload flow; the visible action is shadcn Button. -->
      <input
        ref="picker"
        type="file"
        class="sr-only"
        tabindex="-1"
        aria-label="选择上传文件"
        :disabled="unavailable || !allowsFile"
        :accept="extensions.join(',') || undefined"
        @change="picked"
      />
    </div>
    <Progress v-if="progress !== undefined" :model-value="Math.round(progress * 100)" aria-label="文件上传进度" />
    <p v-if="error" class="path-error" role="alert">{{ error }}</p>
    <div v-if="thumb" class="file-card">
      <img :src="thumb" alt="" />
      <div class="file-card-text">
        <strong>{{ value.split("/").at(-1) }}</strong>
      </div>
    </div>
    <p v-if="status" class="path-status" :class="status.tone">{{ status.text }}</p>
    <div v-if="dragging" class="drop-hint" aria-hidden="true">松开以上传{{ fileKinds ? ` ${fileKinds}` : "" }}</div>
    <FileBrowser
      v-if="browsing"
      :start="startDir"
      :mode="mode"
      :extensions="extensions"
      :disabled="unavailable"
      :return-focus-to="browserTrigger"
      @choose="choose"
      @close="browsing = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from "vue";

import type { FileStat } from "../../../src/shared/files";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { fileError, formatBytes, MAX_UPLOAD_BYTES, previewUrl, statFile, uploadFile } from "../lib/files";
import FileBrowser from "./FileBrowser.vue";
import { SCHEMA_SCOPE } from "./schema-model";

type Filter = "file" | "directory" | { name?: string; extensions?: string[] };
const props = defineProps<{ modelValue: unknown; extra?: unknown; placeholder: string; inputId?: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: string | undefined] }>();
const scope = inject(SCHEMA_SCOPE, ref(""));

const filters = computed<Filter[]>(() => {
  const list = (props.extra as { filters?: unknown } | undefined)?.filters;
  return Array.isArray(list) ? (list as Filter[]) : [];
});
const extensions = computed(() =>
  filters.value.flatMap((f) =>
    typeof f === "object" && Array.isArray(f.extensions) ? f.extensions.map((e) => (e.startsWith(".") ? e : "." + e).toLowerCase()) : [],
  ),
);
const fileKinds = computed(() =>
  filters.value
    .filter((f): f is { name?: string } => typeof f === "object")
    .map((f) => f.name)
    .filter(Boolean)
    .join("、"),
);
const allowsFile = computed(() => !filters.value.length || filters.value.some((f) => f !== "directory"));
const allowsDir = computed(() => !filters.value.length || filters.value.includes("directory"));
const mode = computed(() => (allowsFile.value && allowsDir.value ? "any" : allowsDir.value ? "directory" : "file"));
const value = computed(() => (typeof props.modelValue === "string" ? props.modelValue : ""));
const isImage = computed(() => /\.(png|jpe?g|gif|webp)$/i.test(value.value));

const info = ref<FileStat>();
const thumb = ref("");
const progress = ref<number>();
const uploading = ref(false);
const unavailable = computed(() => !!props.disabled || uploading.value);
const error = ref("");
const browsing = ref(false);
const dragging = ref(false);
const picker = ref<HTMLInputElement>();
const browserTrigger = ref<HTMLElement>();
let token = 0,
  uploadToken = 0,
  disposed = false,
  settled: string | undefined,
  timer: ReturnType<typeof setTimeout> | undefined,
  objectUrl = "";

function setThumb(url: string) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = url.startsWith("blob:") ? url : "";
  thumb.value = url;
}
onUnmounted(() => {
  disposed = true;
  ++token;
  ++uploadToken;
  if (timer) clearTimeout(timer);
  setThumb("");
});
watch(
  () => props.disabled,
  (disabled) => {
    if (!disabled) return;
    ++uploadToken;
    browsing.value = false;
    dragging.value = false;
  },
  { flush: "sync" },
);

async function inspect(path: string) {
  if (disposed) return;
  const current = ++token;
  if (!path) {
    info.value = undefined;
    setThumb("");
    return;
  }
  try {
    const result = await statFile(path);
    if (disposed || current !== token) return;
    info.value = result;
    if (!result.exists || result.type !== "file" || !isImage.value) {
      setThumb("");
      return;
    }
    const response = await fetch(previewUrl(path, result.mtime), { credentials: "same-origin" });
    if (!response.ok || disposed || current !== token) return;
    const blob = await response.blob();
    if (disposed || current !== token) return;
    setThumb(URL.createObjectURL(blob));
  } catch {
    if (!disposed && current === token) info.value = undefined;
  }
}
watch(
  value,
  (path) => {
    if (timer) clearTimeout(timer);
    // Picked and uploaded paths were already inspected; typing waits for a pause.
    if (path === settled) return;
    ++token;
    ++uploadToken;
    timer = setTimeout(() => void inspect(path), 450);
  },
  { immediate: true, flush: "sync" },
);
function choose(path: string) {
  if (disposed || unavailable.value) return;
  browsing.value = false;
  error.value = "";
  settled = path;
  emit("update:modelValue", path);
  void inspect(path);
}

function type(path: string) {
  if (disposed || unavailable.value) return;
  settled = undefined;
  emit("update:modelValue", path || undefined);
}

async function upload(file: File) {
  if (disposed || unavailable.value || !allowsFile.value) return;
  error.value = "";
  if (extensions.value.length && !extensions.value.some((ext) => file.name.toLowerCase().endsWith(ext))) {
    error.value = `请选择 ${extensions.value.join(" / ")} 文件。`;
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    error.value = `文件太大，最大 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB。`;
    return;
  }
  const current = ++uploadToken;
  const active = () => !disposed && !props.disabled && current === uploadToken;
  uploading.value = true;
  browsing.value = false;
  dragging.value = false;
  progress.value = 0;
  try {
    const result = await uploadFile(file, scope.value || "misc", (ratio) => {
      if (active()) progress.value = ratio;
    });
    if (!active()) return;
    settled = result.path;
    emit("update:modelValue", result.path);
    ++token;
    info.value = { path: result.path, exists: true, type: "file", size: result.size, mtime: Date.now() };
    if (isImageName(file.name)) setThumb(URL.createObjectURL(file));
    else setThumb("");
  } catch (e) {
    if (active()) error.value = fileError(e);
  } finally {
    if (!disposed) {
      uploading.value = false;
      progress.value = undefined;
    }
  }
}
const isImageName = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

function openPicker() {
  if (!disposed && !unavailable.value && allowsFile.value) picker.value?.click();
}

function startBrowsing(event?: MouseEvent) {
  if (disposed || unavailable.value) return;
  browserTrigger.value = event?.currentTarget as HTMLElement | undefined;
  browsing.value = true;
}

function dragOver() {
  if (!disposed && !unavailable.value && allowsFile.value) dragging.value = true;
}

function picked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void upload(file);
}

function dropped(event: DragEvent) {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file && allowsFile.value) void upload(file);
}
const startDir = computed(() => {
  const path = value.value;
  if (!path) return allowsFile.value ? "data/yesimbot/uploads" : ".";
  return info.value?.type === "directory" ? path : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
});
const status = computed(() => {
  if (progress.value !== undefined) return { tone: "", text: `上传中 ${Math.round(progress.value * 100)}%` };
  const stat = info.value;
  if (!value.value || !stat) return undefined;
  if (stat.outside) return { tone: "warn", text: "路径在数据目录之外，无法检查" };
  if (!stat.exists) {
    if ((props.extra as { allowCreate?: unknown } | undefined)?.allowCreate) return { tone: "", text: "尚不存在，会自动创建" };
    return { tone: "danger", text: mode.value === "file" ? "找不到这个文件，启动时会出错" : "找不到这个路径" };
  }
  if (stat.type === "directory") return { tone: "ok", text: mode.value === "file" ? "这是一个文件夹，需要选择文件" : "文件夹存在" };
  return { tone: mode.value === "directory" ? "warn" : "ok", text: `文件存在 · ${formatBytes(stat.size ?? 0)}` };
});
</script>

<style scoped>
@reference "../styles/app.css";

.path-field {
  position: relative;
  display: grid;
  gap: 8px;
}
.path-row {
  display: flex;
  gap: 8px;
}
.path-row input {
  flex: 1;
}
.progress {
  @apply rounded-full bg-muted;
  height: 4px;
  overflow: hidden;
}
.progress span {
  @apply bg-primary;
  display: block;
  height: 100%;
  transition: width 0.15s;
}
.path-error {
  @apply text-destructive text-sm;
  margin: 0;
}
.path-status {
  @apply text-xs text-muted-foreground;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.path-status.warn {
  color: var(--warn-text, var(--warn));
}
.path-status.danger {
  @apply text-destructive;
}
.file-card {
  @apply border border-border rounded-md bg-muted;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px;
}
.file-card img {
  @apply rounded-md bg-card;
  width: 64px;
  height: 86px;
  object-fit: cover;
  flex: none;
}
.file-card-text {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.file-card-text strong {
  @apply text-sm;
}
.dragging .path-row {
  visibility: hidden;
}
.drop-hint {
  @apply rounded-md bg-brand-soft text-brand-text font-medium text-sm;
  position: absolute;
  inset: -4px;
  display: grid;
  place-items: center;
  border: 2px dashed var(--accent);
  pointer-events: none;
}
</style>

<template>
  <div class="relative h-full w-full">
    <img ref="image" :src="src" :alt="label" draggable="false" class="block h-full w-full object-contain" />
    <textarea
      ref="input"
      class="absolute inset-0 h-full w-full resize-none cursor-default touch-none overflow-hidden border-0 bg-transparent text-transparent caret-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-label="label + '，可直接点击、拖动和输入文字'"
      autocomplete="off"
      autocapitalize="off"
      :spellcheck="false"
      @pointerdown="down"
      @pointerup="up"
      @pointermove="move"
      @pointercancel="cancel"
      @contextmenu.prevent="right"
      @wheel.prevent="wheel"
      @keydown="key"
      @input="typed"
      @compositionstart="composing = true"
      @compositionend="composed"
      @paste.prevent="paste"
    />
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
const props = defineProps<{ src: string; label: string; width?: number; height?: number; scale: number; busy: boolean }>();
const emit = defineEmits<{ action: [action: unknown]; key: [event: KeyboardEvent] }>();
const image = ref<HTMLImageElement>();
const input = ref<HTMLTextAreaElement>();
let composing = false;
let start: { x: number; y: number; clientX: number; clientY: number; id: number } | undefined;
let click: { x: number; y: number; button: string } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastMove = 0;
function point(event: MouseEvent) {
  const img = image.value;
  if (!img) return;
  const rect = img.getBoundingClientRect();
  const width = props.width || img.naturalWidth,
    height = props.height || img.naturalHeight;
  const fit = Math.min(rect.width / width, rect.height / height);
  const x = (event.clientX - rect.left - (rect.width - width * fit) / 2) / fit;
  const y = (event.clientY - rect.top - (rect.height - height * fit) / 2) / fit;
  if (x >= 0 && y >= 0 && x < width && y < height) return { x: Math.floor(x / props.scale), y: Math.floor(y / props.scale) };
}
function flush() {
  clearTimeout(timer);
  if (click) emit("action", { type: "click", ...click });
  click = undefined;
}
function down(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  input.value?.focus({ preventScroll: true });
  const xy = point(event);
  if (xy) {
    start = { ...xy, clientX: event.clientX, clientY: event.clientY, id: event.pointerId };
    input.value?.setPointerCapture(event.pointerId);
  }
}
function up(event: PointerEvent) {
  const from = start;
  start = undefined;
  if (!from || from.id !== event.pointerId) return;
  if (input.value?.hasPointerCapture(event.pointerId)) input.value.releasePointerCapture(event.pointerId);
  const to = point(event);
  if (!to) return;
  if (Math.hypot(event.clientX - from.clientX, event.clientY - from.clientY) > 4) {
    flush();
    emit("action", { type: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y });
  } else if (click && Math.hypot(click.x - to.x, click.y - to.y) < 8) {
    clearTimeout(timer);
    click = undefined;
    emit("action", { type: "click", ...to, button: "left", count: 2 });
  } else {
    flush();
    click = { ...to, button: "left" };
    timer = setTimeout(flush, 280);
  }
}
function cancel() {
  start = undefined;
}
function move(event: PointerEvent) {
  if (start || click || props.busy || Date.now() - lastMove < 150) return;
  const xy = point(event);
  if (xy) {
    lastMove = Date.now();
    emit("action", { type: "move", ...xy });
  }
}
function right(event: MouseEvent) {
  flush();
  input.value?.focus({ preventScroll: true });
  const xy = point(event);
  if (xy) emit("action", { type: "click", ...xy, button: "right" });
}
function wheel(event: WheelEvent) {
  flush();
  const xy = point(event);
  if (xy && event.deltaY) emit("action", { type: "scroll", ...xy, dy: -Math.sign(event.deltaY) * 3 });
}
function key(event: KeyboardEvent) {
  if (composing || event.isComposing) return;
  flush();
  // Paste must use the browser clipboard, not a stale remote clipboard.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
  emit("key", event);
}
function text(value: string) {
  flush();
  if (value) emit("action", { type: "text", text: value });
  if (input.value) input.value.value = "";
}
function typed(event: Event) {
  if (!composing) text((event.target as HTMLTextAreaElement).value);
}
function composed(event: CompositionEvent) {
  composing = false;
  text((event.target as HTMLTextAreaElement).value);
}
function paste(event: ClipboardEvent) {
  text(event.clipboardData?.getData("text/plain") ?? "");
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

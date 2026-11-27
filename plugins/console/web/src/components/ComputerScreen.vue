<template>
  <Card class="gap-0 p-5 max-sm:p-4" as-child
    ><section ref="root" class="card screen-card" :class="{ compact, embedded }" :style="ratio" aria-label="电脑屏幕">
      <div class="screen-head">
        <slot name="lead" />
        <div class="screen-name">
          <PickerMenu v-if="computers.length > 1" v-model="choice" label="选择电脑" :options="computerOptions">
            <strong class="truncate">{{ device?.name ?? "屏幕" }}</strong>
          </PickerMenu>
          <h2 v-else>{{ compact || embedded ? (device?.name ?? "屏幕") : "屏幕" }}</h2>
          <span v-if="canCapture && !stopped && tone === 'warn'" class="dot" :class="tone" :title="status" role="img" :aria-label="status"></span>
          <small v-if="compact && canCapture && !stopped" class="state">{{
            paused ? "已暂停" : problem ? "画面没有更新" : capturedAt ? "在线" : "正在连接"
          }}</small>
          <!-- The computer window says nothing while all is well. -->
          <small v-else-if="embedded && canCapture && !stopped && (paused || problem || !capturedAt)" class="state">{{
            paused ? "已暂停" : problem ? "画面没有更新" : "正在连接"
          }}</small>
        </div>
        <div class="tools">
          <ToggleGroup
            v-if="!compact && bothSources"
            type="single"
            variant="outline"
            size="sm"
            :model-value="source"
            aria-label="看哪里"
            :disabled="!!control.token.value || control.busy.value"
            @update:model-value="choose"
          >
            <ToggleGroupItem value="browser" class="px-3 text-xs">浏览器</ToggleGroupItem>
            <ToggleGroupItem value="desktop" class="px-3 text-xs">桌面</ToggleGroupItem>
          </ToggleGroup>
          <Button v-if="!compact && canTakeOver && canCapture && imageUrl" variant="outline" size="sm" :disabled="control.busy.value" @click="takeOver">{{
            control.token.value ? `交还${takeOverTarget}` : control.busy.value ? "正在接管…" : `接管${takeOverTarget}`
          }}</Button>
          <template v-if="embedded && imageUrl">
            <Button
              v-if="canCapture && !stopped"
              variant="ghost"
              size="icon-sm"
              :aria-pressed="paused"
              :aria-label="paused ? '继续刷新' : '暂停刷新'"
              :title="paused ? '继续刷新' : '暂停刷新'"
              @click="paused = !paused"
              ><Play v-if="paused" class="size-4" /><Pause v-else class="size-4"
            /></Button>
            <Button variant="ghost" size="icon-sm" aria-label="放大屏幕" title="放大屏幕" data-screen-zoom @click="openZoom"
              ><Maximize2 class="size-4"
            /></Button>
          </template>
        </div>
        <slot name="actions" />
      </div>

      <p v-if="control.token.value" class="text-xs text-muted-foreground" role="status">
        {{
          remoteDesktop && !remoteConnected
            ? "正在连接远程桌面，bot 已暂停操作。"
            : control.controlled.value === "browser"
              ? "已接管浏览器，bot 暂停操作。直接在画面上点击、滚动或输入文字（支持中文），桌面不受影响。"
              : "已接管，bot 暂停操作。直接点击画面、拖动或输入文字（支持中文）。"
        }}
      </p>
      <p v-if="control.error.value" class="text-sm text-destructive" role="alert">{{ control.error.value }}</p>
      <div class="viewer">
        <Teleport v-if="remoteDesktop" to="body" :disabled="!zoomed">
          <div class="frame remote-frame" :class="{ 'remote-fullscreen': zoomed }" :style="ratio">
            <RemoteDesktop
              :key="control.token.value"
              :device-id="selected!"
              :token="control.token.value"
              @connected="remoteConnected = true"
              @disconnected="desktopDisconnected"
            />
            <Button v-if="zoomed" variant="outline" size="sm" class="remote-close" @click="closeZoom">退出大图</Button>
          </div>
        </Teleport>
        <div v-else-if="imageUrl" class="frame" :style="ratio">
          <ComputerInput
            v-if="control.token.value"
            :src="imageUrl"
            :label="screenLabel"
            :width="size?.width"
            :height="size?.height"
            :scale="screenScale"
            :busy="control.busy.value"
            @action="control.send"
            @key="control.key"
          />
          <Button v-else variant="ghost" class="h-auto min-h-9 whitespace-normal" as-child
            ><button
              class="shot"
              type="button"
              :aria-label="compact ? '展开屏幕' : '放大屏幕'"
              :title="compact ? '展开屏幕' : undefined"
              :data-screen-zoom="!compact ? '' : undefined"
              @click="openScreen"
            >
              <img :src="imageUrl" :alt="screenLabel" /></button
          ></Button>
          <p v-if="problem" class="note" role="status">{{ problem }}</p>
          <Button variant="ghost" class="h-auto min-h-9 whitespace-normal" as-child v-if="canCapture && !stopped && !compact && !embedded"
            ><button
              class="pause"
              type="button"
              :aria-pressed="paused"
              :aria-label="paused ? '继续刷新' : '暂停刷新'"
              :title="paused ? '继续刷新' : '暂停刷新'"
              @click="paused = !paused"
            >
              <Icon :name="paused ? 'play' : 'pause'" /></button
          ></Button>
        </div>
        <div v-else class="placeholder" :class="{ waiting: !problem && canCapture && !stopped }">
          <Icon name="device" />
          <p>{{ problem || (canCapture ? "正在连接…" : "这台电脑没有开放桌面，在电脑的客户端里打开后就能看到。") }}</p>
          <RouterLink
            v-if="needsUpdate"
            :class="buttonVariants({ variant: 'outline', size: 'sm' })"
            :to="{ path: settingsPages.extensions.path, query: { section: 'yesimbot-workspace' } }"
            >下载新版客户端</RouterLink
          >
        </div>
      </div>

      <Dialog v-if="imageUrl && !remoteDesktop" v-model:open="zoomed">
        <DialogContent class="max-h-[95dvh] max-w-[95vw] p-2 sm:max-w-[95vw]" :aria-describedby="undefined" @close-auto-focus="restoreZoomFocus">
          <DialogTitle class="sr-only">屏幕大图</DialogTitle>
          <p v-if="control.error.value" class="text-sm text-destructive" role="alert">{{ control.error.value }}</p>
          <ComputerInput
            v-if="control.token.value"
            :src="imageUrl"
            :label="screenLabel"
            class="max-h-[85dvh]"
            :style="{ aspectRatio: size ? `${size.width}/${size.height}` : '1.6' }"
            :width="size?.width"
            :height="size?.height"
            :scale="screenScale"
            :busy="control.busy.value"
            @action="control.send"
            @key="control.key"
          />
          <img v-else :src="imageUrl" :alt="screenLabel" class="max-h-[90dvh] w-full object-contain" />
        </DialogContent>
      </Dialog></section
  ></Card>
</template>
<script setup lang="ts">
import type { DeviceView } from "@yesimbot/contracts";
import { Maximize as Maximize2, Pause, Play } from "reicon-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { ScreenStreamParser, type ScreenViewSource } from "../../../src/shared/device-screen";
import { useComputerControl } from "../lib/computer-control";
import {
  backoff,
  defaultScreenSource,
  hasBrowserControl,
  hasBrowserView,
  hasDesktop,
  pickScreenDevice,
  POLL_INTERVAL,
  screenProblem,
  STREAM_FIRST_RECORD_MS,
  STREAM_IDLE_MS,
  STREAM_RECONNECT_MS,
} from "../lib/computer-screen";
import { formatTime } from "../lib/format";
import type { PickerOption } from "../lib/picker";
import { settingsPages } from "../nav";
import Icon from "../shell/Icon.vue";
import ComputerInput from "./ComputerInput.vue";
import PickerMenu from "./PickerMenu.vue";
import RemoteDesktop from "./RemoteDesktop.vue";
import { Button, buttonVariants } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

/**
 * A bound computer's live screen, with exclusive manual input while taken over, beside the chat on 对话. It shows the bot's own
 * browser first (the bot works there, apart from the desktop); 桌面 switches to the desktop, and taking over always uses it. One long response brings a
 * new picture whenever the screen changes. A server or network that cannot stream gets one
 * picture a second instead. It runs only while on screen and the tab is visible, and can be paused.
 */
const props = defineProps<{
  computers: DeviceView[];
  /** A retained sidebar can hide without unmounting; stop capture and release its lease. */
  active?: boolean;
  preferredDeviceId?: string;
  /** In the conversation's card: a small picture that opens the full screen instead of zooming. */
  compact?: boolean;
  /** A screen inside an existing drawer, without a second card frame. */
  embedded?: boolean;
}>();
const emit = defineEmits<{ expand: [] }>();

const selected = ref(pickScreenDevice(props.computers, props.preferredDeviceId));
watch(
  () => props.preferredDeviceId,
  (id) => {
    if (id && props.computers.some((d) => d.deviceId === id)) selected.value = id;
  },
);
watch(
  () => props.computers,
  (devices) => (selected.value = pickScreenDevice(devices, selected.value ?? props.preferredDeviceId)),
);
const choice = computed({ get: () => selected.value ?? "", set: (value: string) => (selected.value = value) });
const computerOptions = computed<PickerOption[]>(() =>
  props.computers.map((item) => ({
    value: item.deviceId,
    label: item.name,
    note: !item.online ? "离线" : hasDesktop(item) || hasBrowserView(item) ? "" : "没有桌面",
  })),
);
const device = computed(() => props.computers.find((item) => item.deviceId === selected.value));
const source = ref<ScreenViewSource>(defaultScreenSource(device.value));
/** The owner picked 浏览器/桌面 for this computer; until then the view follows what the computer offers. */
let chosen = false;
const withDesktop = computed(() => !!device.value && hasDesktop(device.value));
const bothSources = computed(() => withDesktop.value && hasBrowserView(device.value!));
const canCapture = computed(() => !!device.value && (source.value === "browser" ? hasBrowserView(device.value) : hasDesktop(device.value)));
const screenLabel = computed(() => (source.value === "browser" ? `${device.value?.name ?? "电脑"}上 bot 的浏览器` : `${device.value?.name ?? "电脑"}的屏幕`));
watch(device, (now, before) => {
  if (now?.deviceId !== before?.deviceId) chosen = false;
  if (!chosen && !control.token.value) source.value = defaultScreenSource(now);
});

// Visible = this section intersects the viewport and the browser tab is in front.
const root = ref<HTMLElement>();
const onScreen = ref(typeof IntersectionObserver === "undefined");
const pageVisible = ref(typeof document === "undefined" || document.visibilityState !== "hidden");
const visible = computed(() => props.active !== false && onScreen.value && pageVisible.value);
const paused = ref(false);
const zoomed = ref(false);
let zoomTrigger: HTMLElement | undefined;
const control = useComputerControl(
  selected,
  paused,
  () => !!imageUrl.value && !problem.value && !paused.value && !stopped.value,
  () => (source.value === "browser" && device.value && hasBrowserControl(device.value) ? "browser" : "desktop"),
);
/** Taking over follows what is shown: the bot browser's tab when its client supports it, else the desktop. */
const browserTakeover = computed(() => source.value === "browser" && !!device.value && hasBrowserControl(device.value));
const canTakeOver = computed(() => (control.token.value ? true : browserTakeover.value || withDesktop.value));
const takeOverTarget = computed(() => ((control.token.value ? control.controlled.value === "browser" : browserTakeover.value) ? "浏览器" : "电脑"));

const remoteDesktop = computed(() => !!control.token.value && control.controlled.value === "desktop" && !!device.value?.features?.includes("desktop-stream"));
const remoteConnected = ref(false);
function openZoom(event: MouseEvent) {
  if (!imageUrl.value || props.active === false) return;
  zoomTrigger = event.currentTarget as HTMLElement;
  zoomed.value = true;
}

function openScreen(event: MouseEvent) {
  if (props.compact) emit("expand");
  else openZoom(event);
}

function restoreZoomFocus(event?: Event) {
  if (zoomed.value || props.active === false) {
    event?.preventDefault();
    return;
  }
  const target = zoomTrigger?.isConnected ? zoomTrigger : root.value?.querySelector<HTMLElement>("button[data-screen-zoom]:not(:disabled)");
  if (!target) return;
  event?.preventDefault();
  target.focus({ preventScroll: true });
}

function closeZoom() {
  if (!zoomed.value) return;
  zoomed.value = false;
  // A live remote desktop uses Teleport instead of Dialog's close auto-focus event.
  if (remoteDesktop.value) void nextTick(() => restoreZoomFocus());
}

function choose(value: unknown) {
  if (value !== "browser" && value !== "desktop") return;
  chosen = true;
  source.value = value;
}
/** Takes over what is shown; a browser whose client cannot be taken over yet falls back to the desktop. */
function takeOver() {
  if (!control.token.value && source.value === "browser" && !browserTakeover.value) choose("desktop");
  void control.toggle();
}

function desktopDisconnected() {
  control.error.value = "桌面连接已断开，请重新接管；输入不会自动重发。";
  control.release();
  remoteConnected.value = false;
}
watch(remoteDesktop, () => {
  remoteConnected.value = false;
});
watch(
  () => props.active,
  (active) => {
    if (active === false) {
      zoomed.value = false;
      control.release();
    }
  },
);
const imageUrl = ref("");
const capturedAt = ref(0);
const size = ref<{ width: number; height: number }>();
const screenScale = ref(1);
const ratio = computed(() => (size.value ? { "--ratio": String(size.value.width / size.value.height) } : undefined));
const problem = ref("");
/** The last capture failed because the client is too old: the placeholder links to the download. */
const needsUpdate = ref(false);
/** Retrying cannot help (no permission, unknown computer). */
const stopped = ref(false);
const tone = computed(() => (paused.value ? "idle" : problem.value ? "warn" : capturedAt.value ? "ok" : "idle"));
const status = computed(() =>
  paused.value ? "已暂停" : problem.value ? "画面没有更新" : capturedAt.value ? `更新于 ${formatTime(capturedAt.value, "clock")}` : "正在连接",
);

let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
let failures = 0;

function setImage(url: string) {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
  imageUrl.value = url;
}
function show(blob: Blob, meta: { capturedAt?: number; width?: number; height?: number; scaleFactor?: number }) {
  setImage(URL.createObjectURL(blob));
  screenScale.value = meta.scaleFactor ?? 1;
  capturedAt.value = meta.capturedAt || Date.now();
  size.value = meta.width && meta.height ? { width: meta.width, height: meta.height } : undefined;
  problem.value = "";
  needsUpdate.value = false;
  failures = 0;
}
/** Words a failure; true when retrying cannot help. */
function fail(status: number, body?: { message?: unknown; reason?: unknown }): boolean {
  const result = screenProblem(status, body, source.value);
  problem.value = result.text;
  needsUpdate.value = !!result.update;
  if (result.stop) stopped.value = true;
  return result.stop;
}
function stopScreen() {
  clearTimeout(timer);
  timer = undefined;
  request?.abort();
  request = undefined;
}
// Input must not cancel pending frames: continuous pointer motion would starve the stream.
// The backend serializes capture with desktop input.
const screenWanted = () => visible.value && !paused.value && canCapture.value && !stopped.value && !remoteDesktop.value;
function schedule(delay: number) {
  clearTimeout(timer);
  timer = screenWanted() ? setTimeout(() => void (pollOnly ? capture() : stream()), delay) : undefined;
}

/** Which computer and which of its views a request is for; an answer for another one is dropped. */
const viewKey = () => `${source.value}:${selected.value}`;
const screenQuery = () => `deviceId=${encodeURIComponent(selected.value!)}${source.value === "browser" ? "&source=browser" : ""}`;

/** The live stream; on a server without it, or when nothing comes through, single pictures instead. */
async function stream() {
  timer = undefined;
  if (!screenWanted()) return;
  const view = viewKey();
  const controller = (request = new AbortController());
  let heard = false;
  // Something on the way holds the response back (nothing in time, not even a problem): poll instead.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = (delay: number) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (controller.signal.aborted) return;
      problem.value = "画面连接中断，正在重新获取…";
      pollOnly = true;
      controller.abort();
      schedule(0);
    }, delay);
  };
  armWatchdog(STREAM_FIRST_RECORD_MS);
  controller.signal.addEventListener("abort", () => clearTimeout(watchdog), { once: true });
  try {
    const response = await fetch(`/yesimbot/api/v1/devices/screen/stream?${screenQuery()}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (controller.signal.aborted || view !== viewKey()) return;
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => undefined);
      // A server from before the stream still serves single pictures.
      if (response.status === 404 && body?.message !== "not_found") {
        pollOnly = true;
        return schedule(0);
      }
      if (!fail(response.status, body)) schedule(backoff(++failures));
      return;
    }
    const reader = response.body.getReader();
    // Stopping (pause, hidden, another computer) must end a read that is waiting for the next picture.
    controller.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
    const parser = new ScreenStreamParser();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const { header, image } of parser.push(value)) {
        heard = true;
        armWatchdog(STREAM_IDLE_MS);
        if (controller.signal.aborted || view !== viewKey()) return;
        if (header.type === "frame" && image) show(new Blob([image], { type: header.mediaType }), header);
        else if (header.type === "alive" && header.capturedAt) {
          capturedAt.value = header.capturedAt;
          problem.value = "";
        } else if (header.type === "problem" && fail(header.status, header.body)) return;
      }
    }
    // Stopped here (pause, watchdog): whoever stopped it decides what comes next.
    if (controller.signal.aborted) return;
    // Ended (its lifetime, or the server restarted): open the next one.
    schedule(heard ? STREAM_RECONNECT_MS : backoff(++failures));
  } catch {
    if (controller.signal.aborted) return;
    problem.value = "网络连接不上，稍后会自动重试。";
    needsUpdate.value = false;
    schedule(backoff(++failures));
  } finally {
    clearTimeout(watchdog);
    controller.abort();
    if (request === controller) request = undefined;
  }
}

/** One picture per request, every `POLL_INTERVAL`. */
async function capture() {
  timer = undefined;
  if (!screenWanted()) return;
  const view = viewKey();
  const controller = (request = new AbortController());
  const deadline = setTimeout(() => {
    problem.value = "截屏超时，正在重新获取…";
    controller.abort();
    schedule(backoff(++failures));
  }, STREAM_FIRST_RECORD_MS);
  try {
    const response = await fetch(`/yesimbot/api/v1/devices/screen?${screenQuery()}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (controller.signal.aborted || view !== viewKey()) return;
    if (!response.ok) {
      if (!fail(response.status, await response.json().catch(() => undefined))) schedule(backoff(++failures));
      return;
    }
    const blob = await response.blob();
    if (controller.signal.aborted || view !== viewKey()) return;
    const number = (name: string) => Number(response.headers.get(name)) || undefined;
    show(blob, {
      capturedAt: number("X-Captured-At"),
      width: number("X-Screen-Width"),
      height: number("X-Screen-Height"),
      scaleFactor: number("X-Screen-Scale"),
    });
    schedule(POLL_INTERVAL);
  } catch {
    if (controller.signal.aborted) return;
    problem.value = "网络连接不上，稍后会自动重试。";
    needsUpdate.value = false;
    schedule(backoff(++failures));
  } finally {
    clearTimeout(deadline);
    if (request === controller) request = undefined;
  }
}

/** Starts or stops after anything that decides whether the screen should run. */
function restart() {
  stopScreen();
  if (screenWanted()) void (pollOnly ? capture() : stream());
}
watch([visible, paused, canCapture, remoteDesktop], restart);
watch([visible, zoomed], ([showing, expanded]) => {
  if (!showing && !expanded) control.release();
});
watch(
  () => control.token.value,
  (token) => {
    // The view stays on what was taken over.
    if (token) source.value = control.controlled.value;
  },
);
watch([selected, source], () => {
  setImage("");
  capturedAt.value = 0;
  size.value = undefined;
  problem.value = "";
  needsUpdate.value = false;
  failures = 0;
  stopped.value = false;
  restart();
});

let observer: IntersectionObserver | undefined;
function onVisibility() {
  pageVisible.value = document.visibilityState !== "hidden";
  if (!pageVisible.value) control.release();
}
function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") closeZoom();
}
onMounted(() => {
  if (typeof IntersectionObserver !== "undefined" && root.value) {
    observer = new IntersectionObserver((entries) => (onScreen.value = entries.some((entry) => entry.isIntersecting)));
    observer.observe(root.value);
  }
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("keydown", onKey);
  restart();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("keydown", onKey);
  }
  stopScreen();
  setImage("");
});
</script>
<script lang="ts">
/** Once streaming did not work in this page (old server, a proxy holding it back), stay with pictures. */
let pollOnly = false;
</script>
<style scoped>
.frame.remote-fullscreen {
  position: fixed;
  inset: 24px;
  z-index: 80;
  width: auto;
  height: auto;
  aspect-ratio: auto;
  box-shadow: 0 0 0 30px rgb(0 0 0 / 70%);
}
.remote-close {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
}
/* UI-EXCEPTION screen-media: pixel coordinates, aspect ratio and letterboxing belong to the remote screenshot; zoom controls use Dialog and Button. */
@reference "../styles/app.css";

/* As tall as the conversation beside it; the picture sits at the top at its own shape, the card's own ground below it. */
.screen-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
}
/* Fill the computer dialog and fit the full screen between its toolbar and footer. */
.screen-card.embedded {
  @apply border-0 rounded-none bg-transparent shadow-none p-0;
  height: auto;
  flex: 1;
}
.embedded .viewer {
  min-height: 0;
}
.embedded .frame {
  @apply rounded-xl border border-border;
}
/* In the computer window the head is the window's only bar: back, the computer, its views and tools, then close. */
.embedded .screen-head {
  flex-wrap: wrap;
  row-gap: 8px;
  gap: 8px;
}
.embedded .screen-name {
  flex: 1;
}
.embedded .tools {
  margin-left: 0;
  gap: 4px;
}
.embedded .screen-head h2 {
  @apply text-sm font-medium;
  overflow-wrap: anywhere;
}
.embedded .state {
  @apply text-xs text-muted-foreground;
}
.screen-card.compact {
  @apply border-0 rounded-none bg-transparent shadow-none;
  height: auto;
  gap: 8px;
  padding: 0;
}
.compact .screen-head {
  gap: 8px;
}
.compact .state {
  @apply text-xs text-muted-foreground;
}
.compact .frame {
  @apply rounded-lg;
  box-shadow: inset 0 0 0 1px var(--line);
}
.compact .shot {
  cursor: pointer;
}
.compact .shot img {
  transition: transform 0.2s ease;
}
.compact .shot:hover img {
  transform: scale(1.02);
}
.compact .screen-head {
  min-height: 24px;
}
.compact .screen-head h2,
.compact .screen-head strong {
  @apply text-sm font-semibold;
}
.compact .viewer {
  flex: none;
  display: block;
  min-height: 0;
  container-type: normal;
}
.compact .frame {
  width: 100%;
}
.compact .placeholder {
  aspect-ratio: 2.4;
  padding: 12px;
}
.compact .placeholder p {
  @apply text-xs;
}
.screen-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 32px;
}
.screen-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.screen-head h2 {
  @apply text-base;
}
.screen-head strong {
  @apply text-base;
  font-weight: 600;
}
.tools {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
/* The picture is as large as the space allows in both directions, keeping its shape, and starts at the top:
   a wide screen in a tall pane leaves the card's ground below it, not a dark letterbox. */
.viewer {
  flex: 1;
  min-height: 240px;
  display: grid;
  place-items: start center;
  container-type: size;
  overflow: hidden;
}
.frame {
  @apply rounded-md;
  position: relative;
  width: min(100cqw, 100cqh * var(--ratio, 1.6));
  aspect-ratio: var(--ratio, 1.6);
  overflow: hidden;
  background: #000;
}
.shot {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  overflow: hidden;
  cursor: zoom-in;
}
.shot img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.note {
  @apply rounded-lg text-sm;
  position: absolute;
  left: 12px;
  bottom: 12px;
  max-width: calc(100% - 20px);
  margin: 0;
  padding: 4px 12px;
  background: rgb(0 0 0 / 66%);
  color: #fff;
  pointer-events: none;
}
.pause {
  position: absolute;
  top: 12px;
  right: 12px;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.frame:hover .pause,
.pause:focus-visible,
.pause[aria-pressed="true"] {
  opacity: 1;
}
@media (hover: none) {
  .pause {
    opacity: 0.7;
  }
}
.pause :deep(.icon) {
  width: 15px;
  height: 15px;
}
.placeholder {
  @apply rounded-md;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  width: 100%;
  max-height: 100%;
  aspect-ratio: 1.6;
  padding: 24px;
  overflow: hidden;
  @apply bg-muted;
  @apply text-muted-foreground;
  text-align: center;
}
.placeholder p {
  @apply text-sm;
  max-width: 360px;
  margin: 0;
  @apply text-foreground;
}
.placeholder.waiting {
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.65;
  }
}
/* A phone's sheet is as tall as the picture: the screen takes the full width, its toolbar a row of its own. */
@media (max-width: 639px) {
  .embedded .tools {
    order: 3;
    flex-basis: 100%;
  }
  .embedded .viewer {
    flex: none;
    display: block;
    container-type: normal;
  }
  .embedded .frame {
    width: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .placeholder.waiting {
    animation: none;
  }
  .pause {
    transition: none;
  }
}

.zoom {
  @apply bg-scrim;
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 32px;
  cursor: zoom-out;
}
.zoom img {
  @apply rounded-md shadow-sm;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.zoom .close {
  @apply bg-card;
  position: absolute;
  top: 16px;
  right: 16px;
}
</style>

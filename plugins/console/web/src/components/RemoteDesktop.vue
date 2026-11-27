<template>
  <div class="remote-desktop" @pointerdown.capture="focus" @contextmenu.prevent>
    <div ref="screen" class="remote-screen" />
    <textarea
      ref="input"
      class="desktop-keyboard"
      aria-label="远程电脑键盘输入"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      @keydown="key"
      @keyup="key"
      @compositionstart="composing = true"
      @compositionend="composed"
      @input="typed"
      @paste.prevent="paste"
    />
    <p v-if="!connected" class="remote-connecting" role="status">正在连接桌面…</p>
  </div>
</template>
<script setup lang="ts">
import type RFB from "@novnc/novnc/lib/rfb";
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{ deviceId: string; token: string }>();
const emit = defineEmits<{ disconnected: []; connected: [] }>();
const screen = ref<HTMLElement>();
const input = ref<HTMLTextAreaElement>();
const connected = ref(false);
let client: RFB | undefined;
let socket: WebSocket | undefined;
let disposed = false;
let composing = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function disconnected() {
  if (!disposed) emit("disconnected");
}
function focus() {
  input.value?.focus({ preventScroll: true });
}
function key(event: KeyboardEvent) {
  if (composing || event.isComposing || event.keyCode === 229 || event.key === "Process") return;
  // Let the native clipboard paste event provide current local text.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
  const canvas = screen.value?.querySelector("canvas");
  if (!canvas) return;
  canvas.dispatchEvent(
    new KeyboardEvent(event.type, {
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      bubbles: false,
      cancelable: true,
    }),
  );
  event.preventDefault();
  event.stopPropagation();
}
function text(value: string) {
  if (!connected.value || !client || value.length > 4000) return;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    const keysym = char === "\n" ? 0xff0d : char === "\t" ? 0xff09 : point <= 255 ? point : 0x01000000 + point;
    client.sendKey(keysym, null);
  }
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
onMounted(async () => {
  let Remote: typeof RFB;
  try {
    Remote = (await import("@novnc/novnc/lib/rfb")).default;
  } catch {
    disconnected();
    return;
  }
  if (disposed) return;
  const url = new URL("/yesimbot/api/v1/devices/desktop", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  timer = setTimeout(() => {
    socket?.close();
    disconnected();
  }, 15_000);
  socket.addEventListener("close", disconnected);
  socket.addEventListener("error", disconnected);
  socket.addEventListener(
    "open",
    () => {
      if (disposed || !screen.value) return socket?.close();
      socket!.send(JSON.stringify({ deviceId: props.deviceId, token: props.token }));
      try {
        client = new Remote(screen.value, socket!);
        client.scaleViewport = true;
        client.resizeSession = false;
        client.focusOnClick = false;
        client.addEventListener("connect", () => {
          clearTimeout(timer);
          connected.value = true;
          emit("connected");
          focus();
        });
        client.addEventListener("disconnect", disconnected);
        client.addEventListener("securityfailure", disconnected);
        client.addEventListener("credentialsrequired", () => {
          client?.disconnect();
          disconnected();
        });
      } catch {
        socket?.close();
        disconnected();
      }
    },
    { once: true },
  );
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  client?.disconnect();
  socket?.close();
});
</script>
<style scoped>
/* UI-EXCEPTION remote-desktop: noVNC owns canvas scaling and native pointer coordinates. */
.remote-desktop {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 180px;
  overflow: hidden;
  background: #000;
}
.remote-screen {
  width: 100%;
  height: 100%;
}
.desktop-keyboard {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 1px;
  height: 1px;
  opacity: 0;
  padding: 0;
  border: 0;
  resize: none;
}
.remote-connecting {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: white;
  pointer-events: none;
}
</style>

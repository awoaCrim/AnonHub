<template>
  <Transition name="reconnect">
    <div v-if="shown" class="reconnect-overlay" role="status" aria-live="polite">
      <div class="reconnect-card">
        <LoaderCircle class="reconnect-spinner" aria-hidden="true" />
        <p class="reconnect-title">正在重新连接…</p>
        <p class="reconnect-note">恢复后自动继续，未保存的修改不会丢失</p>
      </div>
    </div>
  </Transition>
</template>
<script setup lang="ts">
import { Loader as LoaderCircle } from "reicon-vue";

import { delayedFlag } from "./delayed-flag";

/**
 * The one disconnect notice for the shell (user, 2026-11-18: 「改成全屏加载，动态的，最好是半透明的，或者静默加载」).
 * A short drop stays silent; a longer one covers the page with a translucent loading layer until the live stream is back.
 */
const props = withDefaults(defineProps<{ reconnecting: boolean; delay?: number }>(), { delay: 1200 });
const shown = delayedFlag(() => props.reconnecting, props.delay);
</script>
<style scoped>
.reconnect-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.reconnect-card {
  display: grid;
  justify-items: center;
  gap: 8px;
  max-width: 320px;
  padding: 24px 28px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  box-shadow: 0 8px 28px rgb(0 0 0 / 10%);
  text-align: center;
}
.reconnect-spinner {
  width: 28px;
  height: 28px;
  margin-bottom: 4px;
  color: var(--text-2);
  animation: reconnect-spin 0.9s linear infinite;
}
.reconnect-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
}
.reconnect-note {
  font-size: 14px;
  color: var(--text-3);
}
.reconnect-enter-active,
.reconnect-leave-active {
  transition: opacity 0.25s ease;
}
.reconnect-enter-from,
.reconnect-leave-to {
  opacity: 0;
}
@keyframes reconnect-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .reconnect-spinner {
    animation-duration: 2.4s;
  }
  .reconnect-enter-active,
  .reconnect-leave-active {
    transition: none;
  }
}
</style>

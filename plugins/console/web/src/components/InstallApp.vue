<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="install-app gap-6 sm:max-w-sm">
      <DialogTitle class="text-lg font-semibold">安装 App</DialogTitle>
      <DialogDescription class="sr-only">AnonHub 安卓版</DialogDescription>
      <div v-if="!release && !failed" class="grid justify-items-center gap-4" role="status" aria-label="正在读取版本">
        <Skeleton v-if="place === 'computer'" class="qr" />
        <Skeleton class="h-10 w-full rounded-xl" />
      </div>
      <p v-else-if="!release" class="flex items-center justify-between gap-4 text-sm text-muted-foreground" role="status">
        暂不可用<Button variant="outline" size="sm" @click="load">重试</Button>
      </p>
      <div v-else class="grid justify-items-center gap-4">
        <!-- A code is for the phone's camera; on the phone itself the button is the download. -->
        <div v-if="place === 'computer' && qr" class="qr" role="img" :aria-label="`AnonHub ${release.versionName} 下载二维码`" v-html="qr"></div>
        <Button as="a" :href="release.url" download class="w-full">下载 Android 版</Button>
        <p class="text-sm text-muted-foreground">{{ release.versionName }} · {{ formatBytes(release.size) }}</p>
      </div>
    </DialogContent>
  </Dialog>
</template>
<script setup lang="ts">
import { ref, watch } from "vue";

import { loadAndroidRelease, qrSvg, type AndroidRelease } from "../lib/android-app";
import { formatBytes } from "../lib/format";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";

/** 安装 App (user, 2026-11-26): the published Android release, as a code to scan on a computer, a download on a phone. */
const props = defineProps<{ open: boolean; place: "computer" | "android" }>();
const emit = defineEmits<{ "update:open": [boolean] }>();
const release = ref<AndroidRelease>();
const qr = ref("");
const failed = ref(false);

async function load() {
  failed.value = false;
  try {
    const next = await loadAndroidRelease();
    if (props.place === "computer") qr.value = await qrSvg(new URL(next.url, location.origin).href);
    release.value = next;
  } catch {
    failed.value = true;
  }
}
// Read afresh each time it opens: a new version may have been published since.
watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
  { immediate: true },
);
</script>
<style scoped>
/* Scanners want dark on light, so the code keeps a white tile in the dark theme too. */
.qr {
  width: 200px;
  height: 200px;
  padding: 16px;
  border-radius: 16px;
  background: #fff;
  box-sizing: content-box;
}
.qr :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>

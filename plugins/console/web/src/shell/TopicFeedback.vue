<template>
  <Alert as="p" v-if="state.unavailable" role="status">{{ label || "此项数据" }}暂不可用。当前服务未提供此功能。</Alert>
  <Alert as="p" v-else-if="state.failed" variant="warn" role="status">
    {{ label || "数据" }}更新失败。{{ state.data !== undefined ? "保留上次数据，内容可能已过期。" : "请稍后重试。" }}
  </Alert>
  <Alert as="p" v-else-if="!shellNotice && state.data !== undefined && state.stale && !state.cached" variant="warn" role="status">
    连接中断，以下为上次数据，可能已过期。恢复连接后会自动更新。
  </Alert>
  <p v-else-if="state.data === undefined" role="status" class="late-in flex items-center gap-2 py-2 text-sm text-muted-foreground">
    <LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在读取{{ label || "数据" }}…
  </p>
</template>
<script setup lang="ts">
import { Loader as LoaderCircle } from "reicon-vue";
import { inject } from "vue";

import { Alert } from "../components/ui/alert";
import type { TopicState } from "../lib/live";
import { connectionNoticeKey } from "./connection-notice";
defineProps<{ state: TopicState; label?: string }>();
/** Inside the app shell its full-screen reconnect layer is the only disconnect notice; pages without it (setup) show their own. */
const shellNotice = inject(connectionNoticeKey, false);
</script>

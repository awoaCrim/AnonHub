<template>
  <div class="grid min-w-0 gap-5">
    <DialogHeader class="pr-6">
      <DialogTitle>{{ login.reason === "created" ? `${login.username} 的登录信息` : `${login.username} 的新登录信息` }}</DialogTitle>
      <DialogDescription class="sr-only">登录地址、用户名和密码</DialogDescription>
    </DialogHeader>
    <SettingsGroup title="仅显示一次">
      <GroupRow title="登录地址" :icon="Link2"
        ><template #detail
          ><span class="value">{{ url }}</span></template
        ></GroupRow
      >
      <GroupRow title="用户名" :icon="User"
        ><template #detail
          ><span class="value">{{ login.username }}</span></template
        ></GroupRow
      >
      <GroupRow title="密码" :icon="KeyRound"
        ><template #detail
          ><span class="value">{{ login.password }}</span></template
        ></GroupRow
      >
    </SettingsGroup>
    <p v-if="failed" class="text-sm text-muted-foreground" role="status">无法自动复制，请手动选中上面的文字复制。</p>
    <div class="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" class="rounded-full" @click="emit('close')">关闭</Button>
      <Button type="button" variant="default" class="rounded-full" @click="copy">{{ copied ? "已复制" : "复制全部" }}</Button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { Key as KeyRound, Link as Link2, User } from "reicon-vue";
import { computed, onUnmounted, ref } from "vue";

import type { FriendLogin } from "../state/accounts-state";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import { Button } from "./ui/button";
import { DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

/** The login a friend needs, ready to paste into a chat; shown inside a dialog. */
const props = defineProps<{ login: FriendLogin }>();
const emit = defineEmits<{ close: [] }>();
const url = computed(() => `${globalThis.location?.origin ?? ""}/login`);
const text = computed(() =>
  [
    "你的 AnonHub 已经开好了：",
    `登录地址：${url.value}`,
    `用户名：${props.login.username}`,
    `密码：${props.login.password}`,
    "登录后按提示一步步设置，就能用上你自己的 bot。",
  ].join("\n"),
);
const copied = ref(false),
  failed = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  try {
    await navigator.clipboard.writeText(text.value);
    copied.value = true;
    failed.value = false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), 2000);
  } catch {
    failed.value = true;
  }
}
onUnmounted(() => timer && clearTimeout(timer));
</script>
<style scoped>
@reference "../styles/app.css";

.value {
  @apply font-mono text-foreground;
  user-select: all;
}
</style>

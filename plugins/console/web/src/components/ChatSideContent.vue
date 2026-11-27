<template>
  <!-- Each panel fades in when it is shown again (a v-show restart replays the animation). -->
  <div v-show="panel === 'tasks'" class="arrive space-y-8">
    <TaskPanel :conversation="conversation" />
    <ScheduledTasks v-if="conversation" :scope="scheduleScope" />
  </div>
  <!-- The computer window has one bar: back, the computer and its tools, settings and close; the screen takes the rest. -->
  <div v-show="panel === 'computer'" class="arrive flex h-full min-h-0 flex-col gap-3">
    <ComputerScreen v-if="computers.length" :active="visible && panel === 'computer'" :computers="computers" :preferred-device-id="preferredDeviceId" embedded>
      <template #lead
        ><Button variant="ghost" size="icon-sm" class="rounded-full" aria-label="返回右栏" @click="emit('back')"><ArrowLeft class="size-4" /></Button
      ></template>
      <template #actions>
        <Button variant="ghost" size="icon-sm" class="rounded-full" as-child
          ><RouterLink to="/settings/computer" aria-label="管理电脑" title="管理电脑"><Settings2 class="size-4" /></RouterLink></Button
        ><Button variant="ghost" size="icon-sm" class="rounded-full" aria-label="收起右栏" @click="emit('close')"><X class="size-4" /></Button>
      </template>
    </ComputerScreen>
    <template v-else>
      <div class="flex min-h-8 items-center gap-2">
        <Button variant="ghost" size="icon-sm" class="rounded-full" aria-label="返回右栏" @click="emit('back')"><ArrowLeft class="size-4" /></Button>
        <h2 class="flex-1 text-sm font-medium">电脑</h2>
        <Button variant="ghost" size="icon-sm" class="rounded-full" as-child
          ><RouterLink to="/settings/computer" aria-label="管理电脑" title="管理电脑"><Settings2 class="size-4" /></RouterLink></Button
        ><Button variant="ghost" size="icon-sm" class="rounded-full" aria-label="收起右栏" @click="emit('close')"><X class="size-4" /></Button>
      </div>
      <div class="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 text-center">
        <span class="grid size-12 place-items-center rounded-xl bg-muted"><Monitor class="size-6 text-muted-foreground" /></span>
        <p v-if="devicesLoading" class="text-sm text-muted-foreground" role="status">正在读取电脑…</p>
        <h3 v-else-if="!devicesError" class="font-medium">当前使用内置沙箱</h3>
      </div>
    </template>
    <p v-if="devicesError" class="text-sm text-destructive" role="alert">{{ devicesError }}</p>
  </div>
  <ChatFiles v-show="panel === 'files'" class="arrive" :persona="persona" :document="document" />
</template>
<script setup lang="ts">
import type { DeviceView } from "@yesimbot/contracts";
import { WEB_CHAT, webChatUser } from "@yesimbot/contracts/platforms";
import { ArrowLeft, Monitor, Setting2 as Settings2, X } from "reicon-vue";
import { computed } from "vue";

import type { WebPersona } from "../lib/web-persona";
import ChatFiles from "./ChatFiles.vue";
import type { ChatPanel } from "./ChatSidebar.vue";
import ComputerScreen from "./ComputerScreen.vue";
import ScheduledTasks from "./ScheduledTasks.vue";
import TaskPanel from "./TaskPanel.vue";
import { Button } from "./ui/button";
const props = defineProps<{
  panel: ChatPanel;
  visible: boolean;
  computers: DeviceView[];
  devicesLoading?: boolean;
  devicesError?: string;
  preferredDeviceId?: string;
  persona: WebPersona;
  document?: "role" | "memory";
  conversation?: { id?: string; channel: string; session?: string };
}>();
const emit = defineEmits<{ back: []; close: [] }>();
// A string first: a new chat snapshot with the same conversation keeps the same scope object.
const conversationId = computed(() => props.conversation?.id ?? "");
const scheduleScope = computed(() => ({ platform: "web", type: "direct", selfId: WEB_CHAT.selfId, channelId: webChatUser(conversationId.value) }));
</script>

<template>
  <div class="space-y-5">
    <PickerMenu
      v-if="persona.canPick.value"
      v-model="roleValue"
      field
      label="此网页对话的角色"
      :options="persona.roleOptions.value"
      :disabled="persona.changing.value || roleDirty"
    />
    <div ref="roleFiles">
      <ChatRoleEditor :persona="persona" :opened="opened === 'role'" @open="opened = 'role'" @close="opened = undefined" @dirty="roleDirty = $event" />
    </div>
    <div ref="memoryFiles"><MemoryPanel :opened="opened === 'memory'" @open="opened = 'memory'" @close="opened = undefined" /></div>
  </div>
</template>
<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

import type { WebPersona } from "../lib/web-persona";
import ChatRoleEditor from "./ChatRoleEditor.vue";
import MemoryPanel from "./MemoryPanel.vue";
import PickerMenu from "./PickerMenu.vue";
const props = defineProps<{ persona: WebPersona; document?: "role" | "memory" }>();
const opened = ref<"role" | "memory">();
const roleDirty = ref(false),
  roleFiles = ref<HTMLElement>(),
  memoryFiles = ref<HTMLElement>();
const roleValue = props.persona.roleValue;
// Legacy links point at one section of this document library, without recreating separate tabs. Only a link that
// names a section scrolls to it: opening the panel scrolled to 角色卡 every time, and (before the chat layout clipped
// instead of hiding its overflow) dragged the whole chat up with it, leaving the bottom of the window blank.
watch(
  () => props.document,
  async (document) => {
    if (!document) return;
    await nextTick();
    if (!opened.value) (document === "memory" ? memoryFiles : roleFiles).value?.scrollIntoView?.({ block: "start" });
  },
  { immediate: true },
);
</script>

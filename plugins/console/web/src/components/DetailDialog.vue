<template>
  <!-- In the 设置 window it opens as a page of the window. -->
  <template v-if="host"
    ><Button type="button" variant="outline" size="sm" @click="setOpen(true)"
      ><slot name="trigger">{{ title }}</slot></Button
    ><SettingsSubpage :open="shown" :title="title" :description="description" @update:open="setOpen"><slot /></SettingsSubpage
  ></template>
  <Dialog v-else :open="open" @update:open="emit('update:open', $event)">
    <DialogTrigger as-child
      ><Button type="button" variant="outline" size="sm"
        ><slot name="trigger">{{ title }}</slot></Button
      ></DialogTrigger
    >
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-3xl" v-bind="description ? {} : { 'aria-describedby': undefined }">
      <DialogHeader class="pr-6"
        ><DialogTitle>{{ title }}</DialogTitle
        ><DialogDescription v-if="description">{{ description }}</DialogDescription></DialogHeader
      >
      <slot />
    </DialogContent>
  </Dialog>
</template>
<script setup lang="ts">
import { computed, inject, ref } from "vue";

import { subpageHostKey } from "../shell/settings-subpages";
import SettingsSubpage from "./SettingsSubpage.vue";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
// An omitted Boolean prop otherwise becomes false, which would lock an uncontrolled dialog closed.
const props = withDefaults(defineProps<{ title: string; description?: string; open?: boolean }>(), { open: undefined });
const emit = defineEmits<{ "update:open": [boolean] }>();
const host = inject(subpageHostKey, null);
const own = ref(false);
const shown = computed(() => props.open ?? own.value);
function setOpen(open: boolean) {
  own.value = open;
  emit("update:open", open);
}
</script>

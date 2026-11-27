<template>
  <GroupRow
    :id="ability.plugin"
    class="ability"
    :class="{ off: !entry?.enabled }"
    :title="ability.title"
    :icon="icon"
    :icon-tone="issue ? 'danger' : undefined"
    :clickable="openable"
    @open="emit('update:open', true)"
  >
    <template v-if="line" #detail
      ><span :class="{ 'text-destructive': !!issue }">{{ line }}</span></template
    >
    <Button v-if="!entry && addable" variant="outline" size="sm" class="rounded-full" :disabled="busy || !writable" @click="emit('add')">添加</Button>
    <Switch
      v-else-if="entry"
      :aria-label="`${ability.title}：${entry.enabled ? '已开启' : '已关闭'}`"
      :model-value="entry.enabled"
      :disabled="busy || !writable || entry.locked"
      @update:model-value="emit('toggle', $event)"
    />
  </GroupRow>
  <!-- Its settings open on their own, never inside the list (user, 2026-11-22: 「我不喜欢下拉式的，我需要的是弹窗」); in the
       设置 window as a page of it under the breadcrumb (user, 2026-11-23: 「最忌弹窗套弹窗」). -->
  <SettingsSubpage
    v-if="openable"
    :open="!!open"
    :title="ability.title"
    :dialog-class="cn('gap-5', ability.body === 'computer' ? 'sm:max-w-4xl' : 'sm:max-w-2xl')"
    @update:open="emit('update:open', $event)"
  >
    <!-- Its switch and what keeps it from working, first on its page as on a model service's (user, 2026-11-25). -->
    <SettingsGroup :label="`${ability.title}状态`">
      <GroupRow title="启用" :icon="Power">
        <Switch
          :aria-label="`启用${ability.title}`"
          :model-value="entry!.enabled"
          :disabled="busy || !writable || entry!.locked"
          @update:model-value="emit('toggle', $event)"
        />
      </GroupRow>
      <GroupRow v-if="issue" title="状态" :value="issue" tone="danger" :to="logs" />
    </SettingsGroup>
    <slot />
  </SettingsSubpage>
</template>
<script setup lang="ts">
import {
  Bulb as Brain,
  Calendar as CalendarClock,
  Gamepad as Gamepad2,
  GalleryAdd as ImagePlus,
  Envelope as Mail,
  Dialog as MessagesSquare,
  Monitor,
  Plug,
  Power,
  Search,
  SmileCircle as Smile,
} from "reicon-vue";
import { computed, type Component } from "vue";

import type { PluginConfigEntry } from "../../../src/shared/plugin-config";
import { useSession } from "../context";
import type { Ability } from "../lib/abilities";
import { cn } from "../lib/utils";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import SettingsSubpage from "./SettingsSubpage.vue";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

const props = defineProps<{
  ability: Ability;
  entry?: PluginConfigEntry;
  /** Not installed in this configuration yet, but it can be added. */
  addable?: boolean;
  issue?: string;
  open?: boolean;
  writable: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{ toggle: [boolean]; add: []; "update:open": [boolean] }>();

const ICONS: Record<string, Component> = {
  "yesimbot-memorizer": Brain,
  "yesimbot-search-service": Search,
  "yesimbot-schedule": CalendarClock,
  "yesimbot-image-tools": ImagePlus,
  "yesimbot-sticker-manager": Smile,
  "yesimbot-onebot-utils": MessagesSquare,
  "yesimbot-xiaoheihe": Gamepad2,
  "yesimbot-workspace": Monitor,
  "yesimbot-google": Mail,
  "yesimbot-mcp-client": Plug,
};
const icon = computed(() => ICONS[props.ability.plugin] ?? Plug);
/** Its settings open on their own; a capability with nothing to set has none. */
const openable = computed(() => !!props.entry && props.ability.body !== "none");
const session = useSession();
/** A start failure is read in the server log. */
const logs = computed(() => (props.entry?.status === "failed" && session.state.role === "owner" ? "/settings/system?tab=server" : undefined));
/** State only (user, 2026-11-21: no guidance text): a problem, or not added yet. */
const line = computed(() => props.issue ?? (!props.entry && props.addable ? "未添加" : ""));
</script>
<style scoped>
@reference "../styles/app.css";

.ability.off :deep(.row-icon) {
  color: var(--text-3);
}
</style>

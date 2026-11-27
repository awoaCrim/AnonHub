<template>
  <Card as-child class="gap-0 p-0"
    ><aside class="card conversation-card" :aria-label="`${title}的信息`">
      <header class="who">
        <img v-if="avatar && !avatarFailed" class="face" :src="avatar" alt="" @error="avatarFailed = true" />
        <BotAvatar v-else-if="kind === 'web'" class="bot-face" />
        <span v-else class="face initial" aria-hidden="true">{{ title.slice(0, 1) }}</span>
        <div class="grow">
          <h2 class="truncate">{{ kind === "web" ? bot.name : title }}</h2>
          <p class="truncate">{{ subtitle }}</p>
        </div>
        <Button v-if="closable" variant="ghost" size="icon-sm" class="text-faint -mr-2" aria-label="收起信息卡" title="收起信息卡" @click="emit('close')">
          <X />
        </Button>
      </header>

      <div class="actions">
        <template v-if="kind === 'channel'">
          <Button variant="ghost" size="sm" @click="emit('whisper')"><MessageCircle />私话</Button>
          <Button variant="ghost" size="sm" as-child
            ><RouterLink :to="platformLink"><LayoutGrid />平台设置</RouterLink></Button
          >
        </template>
        <template v-else-if="kind === 'web'">
          <Button variant="ghost" size="sm" @click="emit('create')"><Plus />新对话</Button>
          <DropdownMenu v-if="persona?.canPick.value">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="sm" :disabled="persona.changing.value"><Drama />角色</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-56">
              <DropdownMenuLabel class="text-faint text-xs font-normal">这个对话由谁说话</DropdownMenuLabel>
              <DropdownMenuRadioGroup v-model="roleModel">
                <template v-for="option in persona.roleOptions.value" :key="option.value">
                  <DropdownMenuSeparator v-if="option.divider" />
                  <DropdownMenuRadioItem :value="option.value">
                    <span class="truncate">{{ option.label }}</span>
                    <span v-if="option.note" class="text-faint ml-auto truncate pl-3 text-xs">{{ option.note }}</span>
                  </DropdownMenuRadioItem>
                </template>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button v-else variant="ghost" size="sm" as-child
            ><RouterLink :to="{ path: '/', query: { panel: 'files', document: 'role' } }"><Drama />角色</RouterLink></Button
          >
          <Button variant="ghost" size="sm" as-child
            ><RouterLink :to="settingsPages.models.path"><Sparkles />模型</RouterLink></Button
          >
        </template>
        <Button v-else variant="ghost" size="sm" as-child
          ><RouterLink :to="platformLink"><LayoutGrid />平台设置</RouterLink></Button
        >
      </div>

      <section v-if="computers.length && !screenOpen" class="part screen-part">
        <div class="part-head">
          <h3>电脑</h3>
          <Button variant="ghost" size="xs" class="text-subtle -mr-2" @click="emit('expand')"><Maximize2 />放大</Button>
        </div>
        <ComputerScreen compact :computers="computers" @expand="emit('expand')" />
      </section>

      <section v-if="schedules.available" class="part">
        <h3>{{ kind === "web" ? "定时任务" : "这个会话的定时任务" }}</h3>
        <ul v-if="tasks.length" class="tasks">
          <li v-for="task in tasks.slice(0, 4)" :key="task.id">
            <Icon name="history" />
            <span class="grow"
              ><strong class="truncate">{{ task.title }}</strong
              ><small>{{ task.state === "paused" ? "已暂停" : task.nextRunAt ? `下次 ${formatTime(task.nextRunAt)}` : "没有下一次" }}</small></span
            >
          </li>
        </ul>
        <p v-else class="none">没有</p>
        <p v-if="tasks.length > 4" class="none">还有 {{ tasks.length - 4 }} 个</p>
      </section>

      <!-- Only when there is something to show: an empty heading is noise. -->
      <section v-if="kind === 'channel' && outputs.length" class="part">
        <h3>它发出的图片和文件</h3>
        <ul class="outputs">
          <li v-for="asset in outputs" :key="asset.id">
            <a :href="asset.dataUrl" target="_blank" rel="noopener" :title="asset.title || asset.id">
              <img v-if="asset.kind === 'image' && asset.dataUrl" :src="asset.dataUrl" :alt="asset.title || '图片'" />
              <Icon v-else :name="asset.kind === 'image' ? 'image' : 'file'" />
            </a>
          </li>
        </ul>
      </section></aside
  ></Card>
</template>
<script setup lang="ts">
import type { DeviceView } from "@yesimbot/contracts";
import { platformLabel } from "@yesimbot/contracts/platforms";
import { Masks as Drama, Widget as LayoutGrid, Maximize as Maximize2, ChatRound as MessageCircle, Add as Plus, Stars as Sparkles, X } from "reicon-vue";
import { computed, onMounted, ref, watch } from "vue";

import type { ScheduledTask, SchedulesSnapshot } from "../../../../src/shared/schedules";
import { api } from "../../lib/api";
import { channelAvatar } from "../../lib/channel-avatar";
import { formatTime } from "../../lib/format";
import type { WebPersona } from "../../lib/web-persona";
import { settingsPages } from "../../nav";
import { injectBotIdentity } from "../../shell/bot-identity";
import BotAvatar from "../../shell/BotAvatar.vue";
import Icon from "../../shell/Icon.vue";
import type { ConversationAssetView, ConversationChannelSummary } from "../../state/history-types";
import ComputerScreen from "../ComputerScreen.vue";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * The open conversation's card on 对话: who it is, a few ways in, the computer's screen as a thumbnail,
 * and what belongs to this conversation (its scheduled tasks, what the bot sent). Read-only apart from the links.
 */
const props = defineProps<{
  kind: "web" | "channel";
  title: string;
  channel?: ConversationChannelSummary;
  computers: DeviceView[];
  /** The full screen is open beside the conversation, so the thumbnail steps aside. */
  screenOpen: boolean;
  outputs: ConversationAssetView[];
  closable?: boolean;
  /** The web chat's speaker: its face and name here, and the role this conversation uses. */
  persona?: WebPersona;
}>();
const emit = defineEmits<{ close: []; whisper: []; create: []; expand: [] }>();

const settingsBot = injectBotIdentity();
const bot = computed(() => props.persona?.bot.value ?? settingsBot.value);
const roleModel = computed({
  get: () => props.persona?.roleValue.value ?? "",
  set: (value: string) => props.persona && (props.persona.roleValue.value = value),
});
const avatarFailed = ref(false);
const avatar = computed(() => channelAvatar(props.channel));
watch(avatar, () => (avatarFailed.value = false));

const subtitle = computed(() => {
  if (props.kind === "web") return props.title ? `${props.title} · 网页对话` : "网页对话";
  const channel = props.channel!;
  const where = `${platformLabel(channel.platform)} ${channel.type === "direct" ? "私聊" : "群聊"}`;
  return channel.lastActivityAt ? `${where} · 最近 ${formatTime(channel.lastActivityAt)}` : where;
});
const platformLink = computed(() => ({
  path: settingsPages.platforms.path,
  query: { platform: props.channel?.platform ?? "" },
}));

// ---------- Scheduled tasks ----------
const schedules = ref<SchedulesSnapshot>({ available: false, tasks: [] });
onMounted(() => {
  void api<SchedulesSnapshot>("/yesimbot/api/v1/schedules", undefined, { fresh: true })
    .then((value) => (schedules.value = value))
    .catch(() => {});
});
/** A chat's own tasks; the web chat shows them all. Finished and cancelled ones are left out. */
const tasks = computed<ScheduledTask[]>(() =>
  schedules.value.tasks.filter(
    (task) =>
      (task.state === "enabled" || task.state === "paused") &&
      (props.kind === "web" ||
        (!!props.channel &&
          task.platform === props.channel.platform &&
          task.channelId === props.channel.channelId &&
          (!task.selfId || !props.channel.selfId || task.selfId === props.channel.selfId))),
  ),
);
</script>
<style scoped>
@reference "../../styles/app.css";

.conversation-card {
  display: grid;
  align-content: start;
  gap: 16px;
  padding: 16px;
}
.who {
  display: flex;
  align-items: center;
  gap: 12px;
}
.face {
  @apply rounded-full bg-surface-3;
  flex: none;
  width: 44px;
  height: 44px;
  object-fit: cover;
}
.initial {
  @apply text-subtle font-sans text-lg;
  display: grid;
  place-items: center;
  font-weight: 600;
}
.initial :deep(.icon) {
  width: 20px;
  height: 20px;
}
.grow {
  flex: 1;
  min-width: 0;
  display: grid;
}
.who h2 {
  @apply text-base;
  font-weight: 600;
}
.who p {
  @apply text-xs text-muted-foreground;
}
/* Light text buttons with their icon, in one row under the name. */
/* The same face as in the conversation's header and its messages. */
.bot-face {
  --avatar-size: 44px;
}
.actions {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: -4px -12px 0;
  padding-bottom: 12px;
}
/* The buttons reach into the card's padding so their text lines up; the rule under them does not. */
.actions::after {
  @apply bg-border;
  content: "";
  position: absolute;
  right: 12px;
  bottom: 0;
  left: 12px;
  height: 1px;
}
.actions :deep(svg) {
  @apply text-subtle;
}
.part-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.screen-part {
  @apply border-b border-border;
  padding-bottom: 16px;
}
.part {
  display: grid;
  gap: 8px;
}
.part h3 {
  @apply text-xs font-medium text-muted-foreground;
}
.none {
  @apply text-sm text-muted-foreground;
}
.tasks {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.tasks li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.tasks :deep(.icon) {
  @apply text-muted-foreground;
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 4px;
}
.tasks strong {
  @apply text-sm;
  font-weight: 500;
}
.tasks small {
  @apply text-xs text-muted-foreground;
}
.outputs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.outputs a {
  @apply rounded-lg bg-muted text-muted-foreground;
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  overflow: hidden;
}
.outputs img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>

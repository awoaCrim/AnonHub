<template>
  <Card class="gap-0 overflow-hidden p-0" as-child
    ><section class="card flush prompt-overview" aria-labelledby="prompt-title">
      <header class="head">
        <div class="grow">
          <h2 id="prompt-title">模型实际读到的提示词</h2>
          <p class="muted">按模型读到的顺序列出。能改的段落点右边的入口过去改；固定规则写在程序里，点开只能看。</p>
        </div>
        <label v-if="data?.conversations.length" class="field which"
          >预览会话<PickerMenu :model-value="data.conversation" field :options="conversationOptions" :disabled="loading" @update:model-value="load"
        /></label>
      </header>

      <Alert v-if="error" variant="destructive" as="p" role="alert"
        >{{ error }} <Button variant="outline" size="sm" type="button" :disabled="loading" @click="load(data?.conversation)">重试</Button></Alert
      >
      <div v-else-if="!data" class="loading" aria-busy="true">
        <Skeleton v-for="n in 6" :key="n" class="skeleton row-skeleton"></Skeleton>
      </div>
      <ol v-else class="segments">
        <li v-for="(segment, index) in data.segments" :key="segment.key" class="segment" :class="{ off: !segment.enabled }">
          <div class="segment-row">
            <button type="button" class="segment-trigger" :disabled="!segment.text" @click="setOpen(segment.key, true)">
              <span class="index">{{ index + 1 }}</span>
              <span class="name">{{ titleOf(segment) }}</span>
              <Badge :variant="SOURCE_TONES[segment.source]">{{ SOURCE_LABELS[segment.source] }}</Badge>
              <span class="state">{{ stateOf(segment) }}</span>
              <FileText v-if="segment.text" class="size-4 text-muted-foreground transition-transform" aria-hidden="true" />
              <span v-else class="size-4" aria-hidden="true" />
            </button>
            <RouterLink v-if="entryOf(segment)" class="entry" :to="entryOf(segment)!.to">{{ entryOf(segment)!.label }} →</RouterLink>
            <span v-else class="entry quiet">{{ segment.source === "auto" ? "自动" : "只读" }}</span>
          </div>
          <SettingsSubpage :open="openKey === segment.key" :title="titleOf(segment)" dialog-class="sm:max-w-3xl" @update:open="setOpen(segment.key, $event)">
            <SettingsGroup v-if="segment.text" :label="titleOf(segment)" plain>
              <pre class="whitespace-pre-wrap break-words p-4 text-sm leading-relaxed">{{ segment.text }}</pre>
            </SettingsGroup>
          </SettingsSubpage>
        </li>
      </ol>

      <template v-if="data?.tools.length">
        <button type="button" class="tools w-full border-t px-5 py-4 text-left text-sm font-medium" @click="toolsOpen = true">
          工具说明 <span class="muted">{{ data.tools.length }} 个工具，{{ totalToolChars }} 字</span>
        </button>
        <SettingsSubpage v-model:open="toolsOpen" title="工具说明" dialog-class="sm:max-w-3xl">
          <SettingsGroup label="工具说明">
            <GroupRow v-for="tool in data.tools" :key="tool.name" :title="tool.name" :value="`${tool.chars} 字`" />
          </SettingsGroup>
        </SettingsSubpage>
      </template></section
  ></Card>
</template>
<script setup lang="ts">
import { DocumentText as FileText } from "reicon-vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type { PromptOverview, PromptSegmentSource, PromptSegmentView } from "../../../src/shared/prompt";
import { api, ApiError } from "../lib/api";
import { featureLink } from "../lib/features";
import type { PickerOption } from "../lib/picker";
import { settingsPages } from "../nav";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import PickerMenu from "./PickerMenu.vue";
import SettingsSubpage from "./SettingsSubpage.vue";
import { Alert } from "./ui/alert";
import { Badge, type BadgeVariants } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

/**
 * 设置 › 角色 › 提示词: what one conversation's model receives, in order, each part labelled with where it
 * comes from and, when it can be changed, a link to where. Nothing here edits.
 */
const SOURCE_LABELS: Record<PromptSegmentSource, string> = { fixed: "固定", card: "角色卡", toggle: "开关", plugin: "插件", auto: "自动" };

const SOURCE_TONES: Record<PromptSegmentSource, BadgeVariants["variant"]> = {
  fixed: "secondary",
  card: "accent",
  toggle: "warn",
  plugin: "ok",
  auto: "outline",
};

/** Each plugin's prompt part by its agent name: what to call it and which feature switches it. */
const PLUGIN_PARTS: Record<string, { label: string; feature: string }> = {
  google: { label: "Google 服务", feature: "yesimbot-google" },
  "memory-agent": { label: "记忆", feature: "yesimbot-memorizer" },
  workspace: { label: "工作区和电脑", feature: "yesimbot-workspace" },
  "search-service": { label: "搜索", feature: "yesimbot-search-service" },
  "mcp-client": { label: "MCP 工具", feature: "yesimbot-mcp-client" },
  "sticker-manager": { label: "表情包", feature: "yesimbot-sticker-manager" },
};

type Link = { path: string; query?: Record<string, string> };
const roleTab = (_tab: string): Link => ({ path: "/", query: { panel: "files", document: "role" } });

const data = ref<PromptOverview>();
const loading = ref(false);
const error = ref("");
const openKey = ref("");
const toolsOpen = ref(false);

const conversationOptions = computed<PickerOption[]>(() =>
  (data.value?.conversations ?? []).map((item) => ({ value: item.key, label: item.label, note: item.kind })),
);
const totalToolChars = computed(() => (data.value?.tools ?? []).reduce((sum, tool) => sum + tool.chars, 0));

function titleOf(segment: PromptSegmentView): string {
  if (segment.source !== "plugin") return segment.title;
  return `插件：${PLUGIN_PARTS[segment.plugin ?? ""]?.label ?? segment.title}`;
}

function stateOf(segment: PromptSegmentView): string {
  if (!segment.enabled) return segment.source === "card" ? "为空" : "未开启";
  return segment.text === undefined ? "每条消息不同" : `${segment.chars} 字`;
}

function entryOf(segment: PromptSegmentView): { to: Link; label: string } | undefined {
  if (segment.key === "role" && segment.source === "card") return { to: roleTab("cards"), label: "编辑角色卡" };
  if (segment.key === "role") return { to: roleTab("cards"), label: "换成角色卡" };
  if (segment.key === "post-history") return { to: roleTab("cards"), label: "角色卡 › 高级" };
  if (segment.key === "inner-thought" || segment.key === "review")
    return { to: { path: settingsPages.system.path, query: { tab: "advanced" } }, label: "系统高级设置" };
  if (segment.source === "plugin") {
    const feature = PLUGIN_PARTS[segment.plugin ?? ""]?.feature;
    const to = feature ? featureLink(feature) : undefined;
    return to ? { to, label: "打开设置" } : undefined;
  }
  return undefined;
}

function setOpen(key: string, open: boolean) {
  if (open) openKey.value = key;
  else if (openKey.value === key) openKey.value = "";
}

let generation = 0,
  disposed = false;
onBeforeUnmount(() => {
  disposed = true;
  generation++;
});
async function load(conversation?: string) {
  if (disposed) return;
  const token = ++generation;
  openKey.value = "";
  loading.value = true;
  error.value = "";
  try {
    const result = await api<PromptOverview>(`/yesimbot/api/v1/prompt${conversation ? `?channel=${encodeURIComponent(conversation)}` : ""}`, undefined, {
      fresh: true,
    });
    if (disposed || token !== generation) return;
    data.value = result;
  } catch (cause) {
    if (disposed || token !== generation) return;
    const code = cause instanceof ApiError ? cause.code : "";
    error.value =
      code === "no_conversation"
        ? "还没有任何会话，先和它聊一句再来看。"
        : code === "bot_unavailable"
          ? "这个会话的账号不在线，换一个会话看看。"
          : "没能读到提示词，请稍后重试。";
  } finally {
    if (!disposed && token === generation) loading.value = false;
  }
}

onMounted(() => void load());
</script>
<style scoped>
@reference "../styles/app.css";

.prompt-overview {
  overflow: hidden;
}
.head {
  @apply border-b border-border;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px 24px;
  padding: 16px 20px;
}
.head .grow {
  flex: 1 1 320px;
  min-width: 0;
}
.head h2 {
  @apply text-base;
  font-weight: 600;
}
.head p {
  @apply text-sm;
  margin-top: 4px;
}
.which {
  width: min(280px, 100%);
}
[data-slot="alert"] {
  margin: 16px 20px;
}
.loading {
  display: grid;
  gap: 8px;
  padding: 16px 20px;
}
.row-skeleton {
  height: 36px;
}
.segments {
  margin: 0;
  padding: 0;
  list-style: none;
}
.segment + .segment {
  @apply border-t border-border;
}
.segment-row {
  @apply grid items-center gap-3 pr-5;
  grid-template-columns: minmax(0, 1fr) 112px;
}
.segment-trigger {
  @apply grid w-full items-center gap-3 py-3 pl-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset;
  grid-template-columns: 28px minmax(0, 1fr) 64px 96px 16px;
}
.segment-trigger:disabled {
  cursor: default;
}
.segment-trigger:hover:not(:disabled) {
  @apply bg-muted;
}
.index {
  @apply text-muted-foreground text-xs;
  font-variant-numeric: tabular-nums;
}
.name {
  @apply text-sm;
  min-width: 0;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.state {
  @apply text-xs text-muted-foreground;
  min-width: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.entry {
  @apply text-xs;
  white-space: nowrap;
}
.entry.quiet {
  @apply text-muted-foreground;
}
.off .name,
.off .index {
  @apply text-muted-foreground;
}
.text {
  @apply rounded-lg bg-muted text-sm;
  max-height: 420px;
  margin: 0 20px 16px 60px;
  padding: 12px 12px;
  overflow: auto;
  font-family: inherit;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tools {
  @apply border-t border-border;
}
.tools ul {
  @apply text-sm;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 4px 16px;
  margin: 0;
  padding: 0 20px 16px 60px;
  list-style: none;
}
.tools li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
/* Phones: the name on one line, its source and where to change it on the next. */
@media (max-width: 640px) {
  .head {
    padding: 16px 16px;
  }
  .segment-row {
    @apply gap-1 px-4 py-3;
    grid-template-columns: minmax(0, 1fr);
  }
  .segment-trigger {
    @apply gap-2 p-0;
    grid-template-columns: 22px 64px minmax(0, 1fr) 16px;
  }
  .name {
    grid-column: 2 / 4;
    white-space: normal;
  }
  .segment-trigger :deep([data-slot="badge"]) {
    grid-column: 2;
  }
  .segment-trigger > svg,
  .segment-trigger > span[aria-hidden] {
    grid-row: 1;
    grid-column: 4;
  }
  .state {
    text-align: left;
  }
  .entry {
    padding-left: 32px;
  }
  .text {
    margin: 0 16px 12px;
  }
  .tools ul {
    padding: 0 16px 12px;
  }
}
</style>

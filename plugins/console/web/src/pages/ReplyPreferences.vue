<template>
  <div class="page grouped reply-preferences">
    <TopicFeedback :state="plugins" label="对话" />
    <ReplyTriggers v-if="plugins.data" :entry="core" :writable="plugins.data?.writable ?? false" />
    <BotBehavior part="speaking" />
    <BotBehavior part="memory" />
  </div>
</template>
<script setup lang="ts">
import { computed } from "vue";

import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import ReplyTriggers from "../components/ReplyTriggers.vue";
import { flattenPlugins } from "../lib/plugin-config";
import { useTopic } from "../lib/use-topic";
import TopicFeedback from "../shell/TopicFeedback.vue";
import BotBehavior from "./BotBehavior.vue";

/** 对话 (user, 2026-11-21): when it replies, how it talks, and how long chats are kept. Everything saves on change. */
const plugins = useTopic<PluginsSnapshot>("plugins");
const core = computed(() => flattenPlugins(plugins.data?.tree ?? []).find((entry) => !entry.group && entry.name === "yesimbot"));
</script>

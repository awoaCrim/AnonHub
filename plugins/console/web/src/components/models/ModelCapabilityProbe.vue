<template>
  <GroupRow title="能力测试" :icon="FlaskConical">
    <template v-if="result?.error || result?.checks.length" #detail>
      <span v-if="result?.error" class="text-destructive" role="alert">{{ errors[result.error] }}</span>
      <span v-else class="checks" aria-live="polite"
        ><span v-for="check in result?.checks" :key="check.capability" :class="check.ok ? 'text-ok' : 'text-destructive'"
          >{{ labels[check.capability] }} {{ check.ok ? "通过" : "未通过" }}{{ check.error ? `（${capabilityFailureMessages[check.error]}）` : ""
          }}{{ check.capability === "text" && check.reasoningObserved ? " · 观察到推理" : "" }}</span
        ></span
      >
    </template>
    <Button v-if="result?.checks.length" type="button" variant="ghost" size="sm" @click="requestsOpen = true">请求记录</Button>
    <Button type="button" variant="outline" size="sm" :disabled="busy || !enabled" @click="run">{{ busy ? "正在测试…" : "测试" }}</Button>
  </GroupRow>
  <SettingsSubpage v-model:open="requestsOpen" title="请求记录" :description="model" dialog-class="sm:max-w-xl">
    <SettingsGroup v-for="check in result?.checks ?? []" :key="check.capability" :title="labels[check.capability]">
      <GroupRow v-for="id in check.requestIds" :key="id" :title="id" class="request-id" />
      <GroupRow v-if="!check.requestIds.length" title="未记录请求 ID" class="text-muted-foreground" />
    </SettingsGroup>
  </SettingsSubpage>
</template>

<script setup lang="ts">
import { TestTube as FlaskConical } from "reicon-vue";
import { ref, watch } from "vue";

import type { ModelCapabilityProbeResult } from "../../../../src/model-settings-types";
import { capabilityFailureMessages, requestModelCapabilityProbe } from "../../state/model-settings-state";
import GroupRow from "../group/GroupRow.vue";
import SettingsGroup from "../group/SettingsGroup.vue";
import SettingsSubpage from "../SettingsSubpage.vue";
import { Button } from "../ui/button";

const props = defineProps<{ connectionKey: string; model: string; enabled: boolean }>();
const result = ref<ModelCapabilityProbeResult>();
const busy = ref(false);
const requestsOpen = ref(false);
const labels = { text: "文本", tool: "工具往返", image: "图片读取" };
const errors: Record<NonNullable<ModelCapabilityProbeResult["error"]>, string> = {
  invalid_request: "测试请求无效",
  not_registered: "模型尚未就绪",
  rate_limited: "测试进行中或过于频繁",
  forbidden: "登录已失效或没有权限",
  network: "测试请求失败",
};
let generation = 0;
watch(
  () => [props.connectionKey, props.model, props.enabled],
  () => {
    generation++;
    result.value = undefined;
    requestsOpen.value = false;
  },
);
async function run() {
  if (!props.enabled || busy.value) return;
  const current = generation;
  busy.value = true;
  try {
    const outcome = await requestModelCapabilityProbe({ key: props.connectionKey, model: props.model, capabilities: ["text", "tool", "image"] });
    if (current === generation) result.value = outcome;
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
</style>

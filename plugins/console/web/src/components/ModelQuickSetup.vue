<template>
  <div class="grid min-w-0 gap-7">
    <Alert v-if="state.draft && !state.draft.writable" variant="warn" as="p" role="alert">
      {{ state.draft.reason || "当前配置暂不支持在此编辑。" }}
    </Alert>
    <SettingsGroup v-if="configured" title="回复模型">
      <GroupRow :title="configured" :icon="Check" icon-tone="ok" value="使用中" tone="ok" />
      <GroupRow title="模型设置" :icon="SlidersHorizontal" :to="'/settings/models'" />
    </SettingsGroup>
    <form v-else-if="state.draft" class="grid min-w-0 gap-7" @submit.prevent="submit">
      <fieldset class="grid min-w-0 gap-7 border-0 p-0" :disabled="state.saving || !state.draft.writable">
        <SettingsGroup title="模型服务">
          <GroupRow title="服务类型" :icon="Plug"
            ><PickerMenu v-model="form.endpoint" field label="服务类型" class="w-56 max-w-full" :options="protocolOptions"
          /></GroupRow>
          <GroupRow title="服务地址" :icon="Globe">
            <Input
              v-model.trim="form.baseURL"
              :class="fieldClass"
              aria-label="服务地址"
              type="url"
              inputmode="url"
              :placeholder="form.endpoint === 'google' ? 'https://generativelanguage.googleapis.com' : 'https://api.example.com/v1'"
            />
          </GroupRow>
          <GroupRow title="API 密钥" :icon="KeyRound">
            <Input v-model="form.apiKey" :class="fieldClass" aria-label="API 密钥" type="password" autocomplete="new-password" required placeholder="sk-…" />
          </GroupRow>
          <GroupRow
            title="连接检测"
            :icon="Activity"
            :value="result?.ok ? `找到 ${result.models.length} 个模型` : result?.error ? probeMessages[result.error] : ''"
            :tone="result?.ok ? 'ok' : result?.error ? 'danger' : undefined"
          >
            <Button type="button" variant="outline" size="sm" class="rounded-full" :disabled="probing || !form.apiKey" @click="probe">{{
              probing ? "正在检测…" : "检测"
            }}</Button>
          </GroupRow>
        </SettingsGroup>
        <SettingsGroup title="回复模型">
          <GroupRow title="模型" :icon="Bot">
            <SuggestInput
              v-model.trim="form.model"
              :class="`${fieldClass} font-mono text-sm`"
              required
              label="服务商提供的模型"
              :options="(result?.models ?? []).map((id) => ({ value: id, label: id }))"
              placeholder="gpt-4o-mini"
            />
          </GroupRow>
        </SettingsGroup>
      </fieldset>
      <div class="flex flex-wrap justify-end gap-2">
        <RouterLink :class="[buttonVariants({ variant: 'outline' }), 'rounded-full']" to="/settings/models">高级设置</RouterLink>
        <Button variant="default" class="rounded-full" :disabled="state.saving || !state.draft?.writable || !form.apiKey || !form.model">
          {{ state.saving ? "正在保存…" : "保存" }}
        </Button>
      </div>
    </form>
    <div v-else class="grid gap-3" aria-busy="true"><Skeleton v-for="n in 3" :key="n" class="rounded-[14px]" style="height: 52px"></Skeleton></div>
  </div>
</template>
<script setup lang="ts">
import { Pulse as Activity, Ghost as Bot, Check, Globe, Key as KeyRound, Plug, Tuning as SlidersHorizontal } from "reicon-vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import type { ModelProbeResult } from "../../../src/model-settings-types";
import { toastErrors } from "../lib/toast";
import {
  connectionName,
  createModelSettingsState,
  endpointType,
  newConnection,
  probeMessages,
  protocolOptions,
  requestModelProbe,
  setConnectionEndpoint,
  type ConnectionEndpoint,
} from "../state/model-settings-state";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import PickerMenu from "./PickerMenu.vue";
import SuggestInput from "./SuggestInput.vue";
import { Alert } from "./ui/alert";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";

/** First-run model setup: one new connection with one chat model, set as the default reply model. */
const view = createModelSettingsState();
const { state } = view;
toastErrors(
  () => state.error,
  () => (state.error = ""),
  () => false,
  () => state.loading || state.saving,
);
const fieldClass = "w-56 max-w-full rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile";
const form = reactive({ endpoint: "openai-chat" as ConnectionEndpoint, baseURL: "", apiKey: "", model: "" });
const result = ref<ModelProbeResult>();
const probing = ref(false);
let probeRevision = 0;

const configured = computed(() => {
  const value = state.draft?.roles.chatModel;
  const connection = value && state.draft?.connections.find((item) => value.startsWith(`${item.id}:`));
  if (!value || !connection || !view.modelChoices().some((choice) => choice.value === value)) return "";
  return `${value.slice(connection.id.length + 1)} · ${connectionName(connection)}`;
});
// A changed address or key makes the previous listing meaningless.
watch(
  () => [form.endpoint, form.baseURL, form.apiKey],
  () => {
    probeRevision++;
    result.value = undefined;
  },
);

async function probe() {
  const revision = ++probeRevision;
  probing.value = true;
  try {
    const outcome = await requestModelProbe({ key: "new:quick", type: endpointType(form.endpoint), baseURL: form.baseURL, apiKey: form.apiKey });
    if (revision !== probeRevision) return;
    result.value = outcome;
    if (outcome.ok && !form.model && outcome.models.length) form.model = outcome.models[0];
  } finally {
    if (revision === probeRevision) probing.value = false;
  }
}

/** Adds the service with its model and makes it the reply model, in one save; a refused one leaves the form as it is. */
function submit() {
  if (!state.draft?.writable || state.saving) return;
  const connection = newConnection();
  setConnectionEndpoint(connection, form.endpoint);
  Object.assign(connection, { baseURL: form.baseURL, apiKey: form.apiKey });
  connection.chatModels.push({ id: form.model, toolCall: true, reasoning: false });
  const chatModel = `${connection.id}:${form.model}`;
  void view.commit("回复模型", (draft) => {
    draft.connections.push(JSON.parse(JSON.stringify(connection)));
    draft.roles.chatModel = chatModel;
  });
}

onMounted(() => void view.setVisible(true));
onBeforeUnmount(() => view.dispose());
</script>

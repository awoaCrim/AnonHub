<template>
  <section class="editor" :aria-busy="state.loading">
    <div v-if="!state.draft" class="empty-state">
      <template v-if="state.loading"><Skeleton v-for="n in 3" :key="n" class="skeleton" style="height: 38px; width: 100%"></Skeleton></template>
      <template v-else>
        <h3>尚未读取配置</h3>
        <Button variant="outline" @click="view.reload(true)">重试读取</Button>
      </template>
    </div>
    <template v-else-if="connection">
      <Segmented v-if="!creating" v-model="tab" :options="tabOptions" label="连接设置分类" class="tabs" />
      <fieldset :disabled="!editable" class="panel">
        <template v-if="creating || tab === 'connection'">
          <SettingsGroup label="连接">
            <GroupRow title="API 协议" :icon="Plug">
              <div class="control">
                <PickerMenu
                  :model-value="connectionEndpoint(connection)"
                  field
                  label="API 协议"
                  :options="protocolOptions"
                  @update:model-value="pickEndpoint"
                />
              </div>
            </GroupRow>
            <GroupRow title="服务地址" :icon="Link2">
              <Input
                :value="connection.baseURL"
                :data-connection="connection.key"
                class="control field-input mono-input"
                type="url"
                aria-label="服务地址"
                placeholder="默认地址"
                @input="typed('baseURL', $event)"
                @change="changed('baseURL', '服务地址', $event)"
              />
            </GroupRow>
            <GroupRow title="API 密钥" :icon="KeyRound">
              <Input
                :value="connection.apiKey ?? ''"
                :data-connection="connection.key"
                class="control field-input"
                type="password"
                autocomplete="new-password"
                aria-label="API 密钥"
                :placeholder="connection.hasApiKey ? '已设置' : '未设置'"
                @input="typed('apiKey', $event)"
                @change="changed('apiKey', 'API 密钥', $event)"
              />
            </GroupRow>
            <GroupRow title="连接检测" :icon="Activity">
              <template v-if="probe.result?.ok || probe.result?.error" #detail>
                <span v-if="probe.result?.ok" class="ok-text" role="status">找到 {{ probe.result.models.length }} 个模型</span>
                <span v-else-if="probe.result?.error" class="danger-text" role="alert">{{ probeMessages[probe.result.error] }}</span>
              </template>
              <Button type="button" variant="outline" size="sm" class="action" :disabled="probe.busy || !canProbe" @click="runProbe">
                {{ probe.busy ? "正在检测…" : creating ? "检测连接" : "检测连接并获取模型" }}
              </Button>
            </GroupRow>
          </SettingsGroup>
          <SettingsGroup v-if="!creating && probe.result?.models.length" title="检测到的模型">
            <template #actions>
              <Button type="button" variant="ghost" size="sm" @click="probeChecked = probeChecked.length === unusedProbed.length ? [] : [...unusedProbed]">
                {{ probeChecked.length === unusedProbed.length ? "全不选" : "全选" }}
              </Button>
            </template>
            <GroupRow title="添加到" :icon="ListPlus">
              <div class="control"><PickerMenu v-model="probeKind" label="添加模型类型" field :options="probeKinds" /></div>
            </GroupRow>
            <div v-if="unusedProbed.length" class="probe-options">
              <GroupRow v-for="id in unusedProbed" :key="id" :title="id" clickable :chevron="false" @open="toggleProbed(id, !probeChecked.includes(id))">
                <Checkbox :model-value="probeChecked.includes(id)" :aria-label="id" @update:model-value="toggleProbed(id, $event === true)" />
              </GroupRow>
            </div>
            <div v-else class="state-line">此类模型已全部添加</div>
            <GroupRow title="添加选中的模型" :value="probeChecked.length ? `${probeChecked.length} 个` : undefined">
              <Button type="button" size="sm" class="action" :disabled="!probeChecked.length" @click="addProbed">添加</Button>
            </GroupRow>
          </SettingsGroup>
        </template>
        <ModelList v-else-if="['chat', 'embedding', 'image'].includes(tab)" :connection="connection" :probed-models="probe.result?.models ?? []" />
        <template v-else>
          <SettingsGroup label="高级">
            <GroupRow title="内部连接标识" :icon="Fingerprint">
              <Input :value="connection.id" class="control field-input mono-input" aria-label="内部连接标识" readonly />
            </GroupRow>
            <GroupRow v-if="['openai-responses', 'anthropic'].includes(connectionEndpoint(connection))" title="启用原生网页搜索" :icon="Globe">
              <Switch
                :model-value="!!connection.options.webSearch"
                aria-label="启用原生网页搜索"
                @update:model-value="setOption(connection, '原生网页搜索', 'webSearch', $event || undefined)"
              />
            </GroupRow>
            <GroupRow v-if="connection.type === 'deepseek'" title="默认思考等级" :icon="Brain">
              <div class="control">
                <PickerMenu
                  :model-value="connection.options.thinking"
                  field
                  label="默认思考等级"
                  :options="THINKING_OPTIONS"
                  @update:model-value="setOption(connection, '默认思考等级', 'thinking', $event)"
                />
              </div>
            </GroupRow>
            <GroupRow v-if="connection.type === 'openai'" title="图片工具结果能力" :icon="ImageIcon">
              <div class="control">
                <PickerMenu
                  :model-value="connection.options.imageToolResultSupport"
                  field
                  label="图片工具结果能力"
                  :options="IMAGE_SUPPORT_OPTIONS"
                  @update:model-value="setOption(connection, '图片工具结果能力', 'imageToolResultSupport', $event)"
                />
              </div>
            </GroupRow>
            <GroupRow v-if="connectionEndpoint(connection) === 'openai-responses'" title="图片结果位置" :icon="Layers">
              <div class="control">
                <PickerMenu
                  :model-value="connection.options.imageToolResultPlacement"
                  field
                  label="图片结果位置"
                  :options="IMAGE_PLACEMENT_OPTIONS"
                  @update:model-value="setOption(connection, '图片结果位置', 'imageToolResultPlacement', $event)"
                />
              </div>
            </GroupRow>
            <GroupRow v-if="connection.type === 'google'" title="图片结果格式" :icon="FileImage">
              <Input
                :value="connection.options.imageToolResultMediaTypes?.join(', ') ?? ''"
                :data-connection="connection.key"
                class="control field-input mono-input"
                aria-label="图片结果格式"
                placeholder="image/png, image/jpeg"
                @change="setMediaTypes"
              />
            </GroupRow>
          </SettingsGroup>
          <SettingsGroup label="移除" tone="danger">
            <GroupRow title="移除此连接" :icon="Trash2" icon-tone="danger">
              <Button variant="danger" size="sm" @click="remove">删除连接</Button>
            </GroupRow>
          </SettingsGroup>
        </template>
      </fieldset>
    </template>
  </section>
</template>

<script setup lang="ts">
import {
  Pulse as Activity,
  Bulb as Brain,
  Gallery as FileImage,
  Fingerprint,
  Globe,
  Gallery as ImageIcon,
  Key as KeyRound,
  Layers,
  Link as Link2,
  AddSquare as ListPlus,
  Plug,
  Trash2,
} from "reicon-vue";
import { computed, inject, reactive, ref, watch } from "vue";

import type { ModelProbeResult, ModelSettingsOptions } from "../../../../src/model-settings-types";
import { confirmDialog } from "../../lib/dialog";
import type { PickerOption } from "../../lib/picker";
import {
  connectionEndpoint,
  connectionName,
  probeMessages,
  protocolOptions,
  requestModelProbe,
  type ConnectionEndpoint,
  servesImages,
} from "../../state/model-settings-state";
import { CONNECTION_TABS, MODELS_PAGE, type ModelKind } from "../../state/models-page";
import GroupRow from "../group/GroupRow.vue";
import Segmented from "../group/Segmented.vue";
import SettingsGroup from "../group/SettingsGroup.vue";
import PickerMenu from "../PickerMenu.vue";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import ModelList from "./ModelList.vue";

/**
 * One service: its connection, models and advanced options. A saved service saves each change at once (text when it
 * is left or Enter is pressed); the one being added only fills its form until 添加.
 */
const { view, state, selected, creating, editable, tab, removeConnection, setConnection, setOption, setEndpoint, addModels } = inject(MODELS_PAGE)!;
const THINKING_OPTIONS: PickerOption<ModelSettingsOptions["thinking"]>[] = [
  { value: undefined, label: "使用默认值" },
  ...(["auto", "none", "low", "medium", "high", "xhigh", "max"] as const).map((level) => ({ value: level, label: level })),
];
const IMAGE_SUPPORT_OPTIONS: PickerOption<ModelSettingsOptions["imageToolResultSupport"]>[] = [
  { value: undefined, label: "按接口协议判断" },
  { value: "native", label: "原生支持" },
  { value: "unsupported", label: "不支持" },
  { value: "unknown", label: "未知" },
];
const IMAGE_PLACEMENT_OPTIONS: PickerOption<ModelSettingsOptions["imageToolResultPlacement"]>[] = [
  { value: undefined, label: "使用默认值" },
  { value: "tool-output", label: "工具结果" },
  { value: "user-message", label: "临时用户消息" },
];
const connection = computed(() => creating.value ?? selected.value);
const connectionTabs = computed(() =>
  CONNECTION_TABS.filter((item) => item.key !== "image" || servesImages(connection.value?.type) || connection.value?.imageModels?.length),
);
const tabOptions = computed(() =>
  connectionTabs.value.map((item) => ({
    value: item.key,
    label: ["chat", "embedding", "image"].includes(item.key) ? `${item.label} ${modelCount(item.key)}` : item.label,
  })),
);
/** Probe results belong to one connection address and key; any edit makes them stale. */
const probe = reactive({ busy: false, identity: "", result: undefined as ModelProbeResult | undefined });
const probeChecked = ref<string[]>([]);
const probeKind = ref<ModelKind>("chat");
const probeKinds = computed(() => [
  { value: "chat" as const, label: "聊天模型" },
  ...(["openai", "google"].includes(connection.value?.type ?? "") ? [{ value: "embedding" as const, label: "向量模型" }] : []),
  ...(servesImages(connection.value?.type) ? [{ value: "image" as const, label: "生图模型" }] : []),
]);
const probeTarget = computed(() =>
  probeKind.value === "image"
    ? connection.value?.imageModels
    : probeKind.value === "embedding"
      ? connection.value?.embeddingModels
      : connection.value?.chatModels,
);
const canProbe = computed(() => !!connection.value && (!!connection.value.apiKey || (connection.value.hasApiKey && !creating.value)));
const unusedProbed = computed(() => (probe.result?.models ?? []).filter((id) => !probeTarget.value?.some((model) => model.id === id)));

watch(probeIdentity, (identity) => {
  if (identity === probe.identity) return;
  probe.result = undefined;
  probe.identity = "";
  probeChecked.value = [];
  probeKind.value = "chat";
});
watch(probeKind, () => {
  probeChecked.value = [];
});
watch(unusedProbed, (ids) => {
  probeChecked.value = probeChecked.value.filter((id) => ids.includes(id));
});

function toggleProbed(id: string, checked: boolean) {
  probeChecked.value = checked ? [...new Set([...probeChecked.value, id])] : probeChecked.value.filter((x) => x !== id);
}

function modelCount(kind: string) {
  const value = connection.value;
  return (kind === "image" ? value?.imageModels : kind === "embedding" ? value?.embeddingModels : value?.chatModels)?.length ?? 0;
}

/** The protocol picker chooses an endpoint; OpenAI's two endpoints share `type: "openai"` and differ in `options.format`. */
function pickEndpoint(value: string) {
  if (connection.value && value !== connectionEndpoint(connection.value)) void setEndpoint(connection.value, value as ConnectionEndpoint);
}

/** The service being added follows each keystroke, so 添加 knows what is filled in. */
function typed(field: "baseURL" | "apiKey", event: Event) {
  if (creating.value) creating.value[field] = (event.target as HTMLInputElement).value;
}

/**
 * A saved service saves a text field once it is left (or Enter is pressed). An empty key keeps the saved one. The
 * field names the service it was shown for: leaving a page fires its last `change` after the page has moved on (to the
 * overview, or from 添加服务 to whatever service is selected), and that text must not land on another service.
 */
function changed(field: "baseURL" | "apiKey", label: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = state.draft?.connections.find((item) => item.key === input.dataset.connection);
  const text = input.value.trim();
  if (!value || (field === "apiKey" && !text)) return;
  void setConnection(value, label, field, text);
}

/** Google's accepted image types for tool results, typed as a comma-separated list (saved like `changed`). */
function setMediaTypes(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = state.draft?.connections.find((item) => item.key === input.dataset.connection);
  if (!value) return;
  const list = input.value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  void setOption(value, "图片结果格式", "imageToolResultMediaTypes", list.length ? list : undefined);
}

async function remove() {
  if (
    selected.value &&
    (await confirmDialog({ title: `删除连接“${connectionName(selected.value)}”？`, message: "删除后立即生效。", confirmLabel: "删除", danger: true }))
  )
    void removeConnection();
}

function probeIdentity() {
  return connection.value ? JSON.stringify([connection.value.key, connection.value.type, connection.value.baseURL, connection.value.apiKey ?? ""]) : "";
}

async function runProbe() {
  if (!connection.value) return;
  const identity = probeIdentity();
  probe.busy = true;
  try {
    const result = await requestModelProbe(connection.value);
    if (identity !== probeIdentity()) return;
    probe.identity = identity;
    probe.result = result;
  } finally {
    probe.busy = false;
  }
}

function addProbed() {
  if (!probeChecked.value.length || !probeKinds.value.some((item) => item.value === probeKind.value)) return;
  void addModels(probeChecked.value, probeKind.value);
  probeChecked.value = [];
}
</script>

<style scoped>
@reference "../../styles/app.css";

.editor {
  container-type: inline-size;
  min-width: 0;
  display: grid;
  gap: 24px;
}
.editor .empty-state {
  justify-items: stretch;
}
.tabs {
  justify-self: start;
}
.panel {
  display: grid;
  gap: 28px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.control {
  width: 260px;
  max-width: 100%;
}
.control :deep([data-slot="select-trigger"]),
.field-input {
  @apply rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile;
}
.ok-text {
  @apply text-ok;
}
.danger-text {
  @apply text-destructive;
}
.probe-options {
  max-height: 280px;
  overflow-y: auto;
}
.state-line {
  padding: 16px;
  color: var(--text-3);
  font-size: 14px;
}
</style>

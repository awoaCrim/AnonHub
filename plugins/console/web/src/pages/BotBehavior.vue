<template>
  <div class="behavior">
    <TopicFeedback :state="subscription.state" label="机器人配置" />
    <Alert v-if="subscription.state.data && !core" as="p">当前运行环境没有可编辑的机器人核心。</Alert>
    <Alert v-if="editor.state.error && !editor.state.config" variant="destructive" as="p" role="alert">
      {{ editor.state.error }} <Button variant="outline" size="sm" :disabled="busy" @click="load()">重试读取</Button>
    </Alert>
    <SettingsGroup v-if="core && !editor.state.config && editor.state.loading" :title="title ?? PART_TITLES[part]" aria-busy="true">
      <div class="grid gap-2 p-2"><Skeleton v-for="n in 3" :key="n" class="h-10" /></div>
    </SettingsGroup>
    <SettingsGroup v-else-if="editor.state.config && visibleSections.length" :title="title ?? PART_TITLES[part]">
      <fieldset :disabled="busy || !writable" class="contents">
        <template v-for="section in visibleSections" :key="section.title">
          <Alert v-if="section.requires === 'session' && sharedSessions && policy.state.error" variant="destructive" as="p" role="alert" class="m-2 w-auto">
            {{ policy.state.error }}
            <Button variant="outline" size="sm" type="button" :disabled="busy" @click="retryPolicy">{{
              policy.state.config ? "检查服务器状态" : "重试读取"
            }}</Button>
          </Alert>
          <div v-if="section.requires === 'session' && sharedSessions && policy.state.loading" class="grid gap-2 p-2" aria-busy="true">
            <Skeleton v-for="n in 2" :key="n" class="h-10" />
          </div>
          <template v-else-if="section.requires !== 'session' || !sharedSessions || policy.state.config">
            <template v-for="row in section.rows.filter(shownRow)" :key="row.path.join('.')">
              <GroupRow v-if="row.kind === 'follow'" :title="row.label" value="辅助模型" :to="{ name: 'settings-models' }" />
              <GroupRow v-else-if="row.unit === undefined" :title="row.label"
                ><Switch :aria-label="row.label" :model-value="flag(row.path)" @update:model-value="setFlag(row, $event)"
              /></GroupRow>
              <GroupRow v-else :title="row.label"
                ><span class="flex w-40 max-w-full items-center gap-2 sm:w-52"
                  ><Input
                    class="min-w-0 flex-1 rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile"
                    :aria-label="row.label"
                    type="number"
                    :min="row.min"
                    :max="row.max"
                    step="any"
                    :value="shown(row.path, row.scale)"
                    :placeholder="row.empty ?? placeholder(row.path, row.scale)"
                    @change="setNumber(row, $event)"
                  /><span class="w-12 shrink-0 whitespace-nowrap text-sm text-muted-foreground">{{ row.unit }}</span></span
                ></GroupRow
              >
            </template>
          </template>
        </template>
      </fieldset>
    </SettingsGroup>
  </div>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";

import type { PluginSchemaSnapshot, PluginsSnapshot } from "../../../src/shared/plugin-config";
import GroupRow from "../components/group/GroupRow.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { useLive, useSession } from "../context";
import { api } from "../lib/api";
import { flattenPlugins, pluginIdentity } from "../lib/plugin-config";
import { toast, toastErrors } from "../lib/toast";
import TopicFeedback from "../shell/TopicFeedback.vue";
import { createAutosave } from "../state/autosave";
import { createConfigFieldsEditor, readPath, schemaAt, schemaDefault } from "../state/config-fields";
import { createContextPolicyEditor } from "../state/context-policy";

/**
 * Core reply settings, one card per part where it belongs (user, 2026-11-21): `speaking` and `memory` on 对话,
 * `input` on 模型. Every change saves at once and offers 撤销; nothing waits for a save bar.
 */
type Part = "speaking" | "memory" | "input";
const props = defineProps<{ part: Part; title?: string }>();
/** Formal names (user, 2026-11-22, on 说话的样子 / 聊久了: 「太直白了」). */
const PART_TITLES: Record<Part, string> = { speaking: "发送节奏", memory: "上下文管理", input: "输入和网络" };
/** Core fields each part owns; everything else in the core config is left exactly as read. */
const PART_FIELDS: Record<Part, readonly string[]> = {
  speaking: ["pacing", "customInnerThought"],
  memory: ["session"],
  input: ["imageInput", "videoInput", "modelRetries", "resourceReadTimeout"],
};
const FIELDS = PART_FIELDS[props.part];

/** A row without `unit` is a switch; numbers are shown in `unit` and stored divided by `scale`. `follow` only points elsewhere. */
interface Row {
  path: string[];
  label: string;
  kind?: "follow";
  unit?: string;
  scale?: number;
  min?: number;
  max?: number;
  /** Placeholder when the plugin has no default. */
  empty?: string;
}
interface Section {
  part: Part;
  title: string;
  /** Host-managed for members: hidden when the projected schema lacks it. */
  requires?: string;
  rows: Row[];
}
const sections: Section[] = [
  {
    part: "speaking",
    title: "节奏",
    rows: [
      { path: ["pacing", "charactersPerSecond"], label: "打字速度", unit: "字 / 秒", min: 1 },
      { path: ["pacing", "maxTotalDelayMs"], label: "最长发送延迟", unit: "秒", scale: 1000, min: 0.001 },
      { path: ["customInnerThought"], label: "记录内部判断" },
    ],
  },
  {
    part: "memory",
    title: "长对话",
    requires: "session",
    rows: [
      {
        path: ["session", "magicContext", "triggerTokens"],
        label: "压缩阈值",
        unit: "Token",
        min: 8000,
        empty: "100000",
      },
      { path: ["auxiliaryModel"], kind: "follow", label: "压缩模型" },
    ],
  },
  {
    part: "input",
    title: "看图和视频",
    rows: [
      { path: ["imageInput"], label: "直接看图片" },
      { path: ["videoInput"], label: "读取视频" },
    ],
  },
  {
    part: "input",
    title: "网络",
    rows: [
      { path: ["modelRetries"], label: "出错重试", unit: "次", min: 0, max: 5 },
      { path: ["resourceReadTimeout"], label: "下载超时", unit: "秒", min: 1 },
    ],
  },
];

const session = useSession();
const subscription = useLive().use<PluginsSnapshot>("plugins");
onUnmounted(subscription.release);
const core = computed(() => flattenPlugins(subscription.state.data?.tree ?? []).find((item) => item.name === "yesimbot" && !item.group));
const writable = computed(() => !!subscription.state.data?.writable && !!core.value && !core.value.locked);
const sharedSessions = computed(() => session.state.role === "owner" && session.state.features.accounts);
const usesPolicy = computed(() => sharedSessions.value && FIELDS.includes("session"));
const editor = createConfigFieldsEditor(usesPolicy.value ? [] : FIELDS, { savedNotice: "" });
onUnmounted(editor.dispose);
const policy = createContextPolicyEditor();
onUnmounted(policy.dispose);
toastErrors(
  () => policy.state.error,
  () => (policy.state.error = ""),
  () => !policy.state.config,
  () => policy.state.busy,
);
toastErrors(
  () => editor.state.error,
  () => (editor.state.error = ""),
  () => !editor.state.config,
  () => editor.state.busy,
);
const autosave = createAutosave({
  read: (path) => readPath(target(path).state.value, path),
  target: (path) => target(path),
  disposed: () => disposed,
  notify: (text, undo) => toast(text, "ok", undefined, undo && { label: "撤销", run: undo }),
});
/** Only loading blocks the card; a save in flight does not (later changes queue behind it). */
const busy = computed(() => editor.state.loading || policy.state.loading);
let disposed = false,
  generation = 0;
onUnmounted(() => {
  disposed = true;
  generation++;
});

// Members receive a schema without host-managed fields (session); only shown fields are editable.
const schema = ref<PluginSchemaSnapshot["schema"]>();
async function load() {
  const path = core.value?.path;
  if (!path || busy.value || autosave.saving.value) return;
  const token = ++generation;
  void api<PluginSchemaSnapshot>("/yesimbot/api/v1/plugins/schema?name=yesimbot")
    .then((result) => {
      if (!disposed && token === generation) schema.value = result.schema;
    })
    .catch(() => {});
  await Promise.all([editor.load(path), ...(usesPolicy.value ? [policy.load("shared")] : [])]);
}
// Enable/disable renames the key (`~yesimbot`); that is the same instance, so keep the editor.
watch(
  () => core.value?.path,
  (path, previous) => {
    if (!path) return;
    if (previous && pluginIdentity(path) === pluginIdentity(previous)) editor.state.path = path;
    else void load();
  },
  { immediate: true },
);
function retryPolicy() {
  if (!disposed && !busy.value && !autosave.saving.value) return policy.state.config ? policy.checkStatus() : policy.load("shared");
}

const shared = (path: readonly string[]) => sharedSessions.value && path[0] === "session";
const target = (path: readonly string[]) => (shared(path) ? policy : editor);
const value = autosave.value;
const has = (path: readonly string[]) =>
  shared(path) || (schema.value === undefined ? path[0] !== "session" || value(path) !== undefined : !!schemaAt(schema.value, path));
const visibleSections = computed(() => sections.filter((section) => section.part === props.part && (!section.requires || has([section.requires]))));

/** Saves at once; a change made while another is saving goes out right after it, with any others made meanwhile. */
function commit(label: string, changes: [readonly string[], unknown][]) {
  if (disposed || busy.value || !writable.value) return;
  void autosave.commit(label, changes);
}
const shownRow = (row: Row) => row.kind === "follow" || has(row.path);
/** Displayed numbers are converted from stored units (ms → s). */
const shown = (path: readonly string[], scale = 1) => {
  const current = value(path);
  return typeof current === "number" ? round(current / scale) : "";
};
const placeholder = (path: readonly string[], scale = 1) => {
  const fallback = schemaDefault(schema.value, path);
  return typeof fallback === "number" ? `默认 ${round(fallback / scale)}` : "默认";
};
const round = (number: number) => String(Math.round(number * 1000) / 1000);
function setNumber(row: Row, event: Event) {
  if (disposed || busy.value || !writable.value || !has(row.path)) return;
  const input = event.target as HTMLInputElement;
  if (input.value.trim() === "") return commit(row.label, [[row.path, undefined]]);
  const number = Number(input.value);
  if (!Number.isFinite(number) || !input.checkValidity()) return void (input.value = shown(row.path, row.scale));
  commit(row.label, [[row.path, Math.round(number * (row.scale ?? 1))]]);
}
const flag = (path: readonly string[]) => {
  const current = value(path);
  return typeof current === "boolean" ? current : schemaDefault(schema.value, path) === true;
};
function setFlag(row: Row, enabled: boolean) {
  if (disposed || busy.value || !writable.value || !has(row.path)) return;
  commit(row.label, [[row.path, enabled]]);
}
</script>
<style scoped>
@reference "../styles/app.css";

.behavior {
  display: grid;
  gap: 12px;
  min-width: 0;
}
</style>

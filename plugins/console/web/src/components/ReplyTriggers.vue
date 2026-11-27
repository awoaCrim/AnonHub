<template>
  <SettingsGroup id="reply-triggers" class="scroll-mt-6" title="回复触发">
    <Alert v-if="editor.state.error && !editor.state.config" variant="destructive" class="m-2 w-auto">
      {{ editor.state.error }} <Button variant="outline" size="sm" :disabled="busy" @click="load">重试</Button>
    </Alert>
    <fieldset v-if="editor.state.config" class="contents" :disabled="busy || !editable">
      <GroupRow title="触发条件">
        <template #below>
          <div class="chips" role="group" aria-label="一定回复的消息">
            <button v-for="key in keys" :key="key" type="button" class="chip" :aria-pressed="on(key)" @click="rule(key, !on(key))">
              {{ REPLY_TRIGGER_LABELS[key] }}
            </button>
          </div>
        </template>
      </GroupRow>
      <GroupRow title="适用平台">
        <span class="chips" role="group" aria-label="规则用于的平台">
          <button v-for="p in platforms" :key="p.id" type="button" class="chip" :aria-pressed="config.platforms.includes(p.id)" @click="select(p)">
            {{ p.label }}
          </button>
        </span>
      </GroupRow>
      <GroupRow v-if="debounce.entry" :title="DEBOUNCE_LABEL">
        <span v-if="debounce.entry.enabled" class="flex w-32 items-center gap-2"
          ><Input
            class="min-w-0 flex-1 rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile"
            type="number"
            min="1"
            step="any"
            aria-label="等待秒数"
            :value="quietSeconds"
            :placeholder="quietDefault"
            :disabled="busy || !debounceEditable"
            @change="setQuiet($event)"
          /><span class="text-sm text-muted-foreground">秒</span></span
        >
        <Switch
          :aria-label="DEBOUNCE_LABEL"
          :model-value="debounce.entry.enabled"
          :disabled="busy || !debounceEditable"
          @update:model-value="setDebounce($event)"
        />
      </GroupRow>
    </fieldset>
    <div v-else-if="!editor.state.error" class="grid gap-2 p-2" aria-busy="true"><Skeleton v-for="n in 3" :key="n" class="h-10" /></div>
  </SettingsGroup>
</template>
<script setup lang="ts">
import {
  REPLY_TRIGGER_DEFAULTS,
  REPLY_TRIGGER_LABELS,
  REPLY_TRIGGER_PLATFORMS,
  type ReplyTriggerConfig,
  type ReplyTriggerKey,
} from "@yesimbot/contracts/reply-triggers";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";

import type { PluginConfigEntry, PluginSchemaSnapshot, PluginsSnapshot } from "../../../src/shared/plugin-config";
import { api } from "../lib/api";
import { setFeatureEnabled } from "../lib/features";
import { flattenPlugins, pluginError, pluginIdentity } from "../lib/plugin-config";
import { toast, toastErrors } from "../lib/toast";
import { useTopic } from "../lib/use-topic";
import { createAutosave } from "../state/autosave";
import { createConfigFieldsEditor, schemaDefault } from "../state/config-fields";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";

/**
 * 回复触发 (user, 2026-11-21; renamed from 什么时候回 on 2026-11-22: 「太直白了」): the reply triggers and the group
 * debounce, changed in place. Each click saves at once and offers 撤销.
 */
const props = defineProps<{ entry?: PluginConfigEntry; writable: boolean }>();
const DEBOUNCE_LABEL = "群聊合并等待";
const editor = createConfigFieldsEditor(["replyTriggers"]);
const quiet = createConfigFieldsEditor(["quietSeconds"]);
const plugins = useTopic<PluginsSnapshot>("plugins");
let disposed = false;
const saving = ref(false);
const autosave = createAutosave({
  read: (path) => editor.state.value[path[0]!],
  target: () => editor,
  disposed: () => disposed,
  notify: (text, undo) => toast(text, "ok", undefined, undo && { label: "撤销", run: undo }),
});
/** Only loading blocks the card; a click made while saving queues behind it (user, 2026-11-21: 要丝滑). */
const busy = computed(() => saving.value || editor.state.loading || quiet.state.busy);
const editable = computed(() => props.writable && !!props.entry && !props.entry.locked);
const debounce = reactive({
  entry: computed(() => flattenPlugins(plugins.data?.tree ?? []).find((entry) => !entry.group && entry.name === "yesimbot-message-debounce")),
});
const debounceEditable = computed(() => !!plugins.data?.writable && !!debounce.entry && !debounce.entry.locked);
toastErrors(
  () => editor.state.error,
  () => (editor.state.error = ""),
  () => !editor.state.config,
  () => editor.state.busy,
);
toastErrors(
  () => quiet.state.error,
  () => (quiet.state.error = ""),
  () => false,
  () => quiet.state.busy,
);

const platforms = REPLY_TRIGGER_PLATFORMS;
const config = computed(() => (autosave.value(["replyTriggers"]) ?? { platforms: [] }) as ReplyTriggerConfig);
const keys = Object.keys(REPLY_TRIGGER_DEFAULTS) as ReplyTriggerKey[];
const on = (key: ReplyTriggerKey) => config.value.rules?.[key] ?? REPLY_TRIGGER_DEFAULTS[key];

/** Saves the whole trigger setting; 撤销 restores the one it replaced. */
function commit(label: string, next: ReplyTriggerConfig) {
  if (disposed || busy.value || !editable.value) return;
  // A reactive proxy cannot be structured-cloned.
  void autosave.commit(label, [[["replyTriggers"], JSON.parse(JSON.stringify(next))]]);
}
function rule(key: ReplyTriggerKey, enabled: boolean) {
  commit(REPLY_TRIGGER_LABELS[key], { ...config.value, rules: { ...config.value.rules, [key]: enabled } });
}
function select(platform: { id: string; label: string }) {
  const chosen = config.value.platforms.includes(platform.id);
  commit(platform.label, {
    ...config.value,
    platforms: chosen ? config.value.platforms.filter((id) => id !== platform.id) : [...config.value.platforms, platform.id],
  });
}

const quietSeconds = computed(() => {
  const value = quiet.state.value.quietSeconds;
  return typeof value === "number" ? String(value) : "";
});
/** An unset wait uses the plugin's default, shown in the box as 默认 N like the other numbers on this page. */
const quietSchema = ref<PluginSchemaSnapshot["schema"]>();
const quietDefault = computed(() => {
  const fallback = schemaDefault(quietSchema.value, ["quietSeconds"]);
  return typeof fallback === "number" ? `默认 ${fallback}` : "默认";
});
void api<PluginSchemaSnapshot>("/yesimbot/api/v1/plugins/schema?name=yesimbot-message-debounce")
  .then((result) => {
    if (!disposed) quietSchema.value = result.schema;
  })
  .catch(() => {});
async function setDebounce(enabled: boolean, undo = false) {
  const entry = debounce.entry;
  if (disposed || busy.value || !entry || !debounceEditable.value || entry.enabled === enabled) return;
  saving.value = true;
  try {
    await setFeatureEnabled(plugins.data?.revision, entry, enabled);
    if (!disposed)
      toast(
        `${DEBOUNCE_LABEL}：已${enabled ? "开启" : "关闭"}`,
        "ok",
        undefined,
        undo ? undefined : { label: "撤销", run: () => void setDebounce(!enabled, true) },
      );
  } catch (error) {
    if (!disposed) toast(pluginError(error), "danger");
  } finally {
    if (!disposed) saving.value = false;
  }
}
async function setQuiet(event: Event, undoValue?: number) {
  const input = event.target as HTMLInputElement | null;
  const next = undoValue ?? Number(input?.value);
  if (disposed || busy.value || !debounceEditable.value || !Number.isFinite(next) || next <= 0) {
    if (input) input.value = quietSeconds.value;
    return;
  }
  const before = quiet.state.value.quietSeconds;
  quiet.set(["quietSeconds"], next);
  if (!quiet.dirty.value) return;
  saving.value = true;
  try {
    if (!(await quiet.save())) {
      if (!disposed) await quiet.discard();
      return;
    }
    if (!disposed && typeof before === "number")
      toast(
        `已保存：等待 ${next} 秒`,
        "ok",
        undefined,
        undoValue === undefined ? { label: "撤销", run: () => void setQuiet(new Event("change"), before) } : undefined,
      );
  } finally {
    if (!disposed) saving.value = false;
  }
}

function load() {
  if (!disposed && props.entry && !busy.value && !autosave.saving.value) return editor.load(props.entry.path);
}
watch(
  () => props.entry?.path,
  (path, previous) => {
    if (!path) return;
    if (previous && pluginIdentity(path) === pluginIdentity(previous)) editor.state.path = path;
    else void load();
  },
  { immediate: true },
);
watch(
  () => debounce.entry?.path,
  (path, previous) => {
    if (!path) return;
    if (previous && pluginIdentity(path) === pluginIdentity(previous)) quiet.state.path = path;
    else void quiet.load(path);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  disposed = true;
  editor.dispose();
  quiet.dispose();
});
</script>
<style scoped>
@reference "../styles/app.css";

fieldset {
  @apply border-0;
  min-width: 0;
  margin: 0;
  padding: 0;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  height: 32px;
  padding: 0 12px;
  border-radius: 16px;
  background: var(--group-tile);
  color: var(--text-2);
  font-size: 14px;
  cursor: pointer;
  transition:
    background-color var(--t-fast) ease,
    color var(--t-fast) ease,
    box-shadow var(--t-fast) ease;
}
.chip:hover {
  @apply text-foreground;
}
.chip[aria-pressed="true"] {
  background: var(--accent-solid);
  color: var(--on-accent);
}
.chip:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.chip:disabled {
  cursor: default;
  opacity: 0.6;
}
</style>

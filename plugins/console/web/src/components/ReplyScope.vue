<template>
  <div v-if="core" class="grid min-w-0 gap-7">
    <TopicFeedback :state="subscription.state" label="回复范围" />
    <SettingsGroup title="回复范围">
      <template v-if="config" #actions>
        <Button variant="outline" size="sm" type="button" :disabled="busy || !writable" @click="openAdd">添加规则</Button>
      </template>
      <div v-if="!config" class="p-2">
        <Alert v-if="error" variant="destructive" as="p" role="alert"
          >{{ error }} <Button variant="outline" size="sm" :disabled="busy" @click="load()">重试读取</Button></Alert
        >
        <Skeleton v-else class="h-10" aria-busy="true" />
      </div>
      <template v-else>
        <GroupRow
          v-for="rule in rules"
          :key="ruleKey(rule)"
          :title="nameOf(rule) || readableRule(rule)"
          :detail="[nameOf(rule) ? readableRule(rule) : '', rule.platform === '*' ? '全部平台' : ''].filter(Boolean).join(' · ') || undefined"
          :value="typeLabel(rule)"
          :icon="ruleIcon(rule)"
        >
          <Button
            variant="ghost"
            size="icon-sm"
            class="remove"
            type="button"
            :aria-label="`移除规则 ${readableRule(rule)}`"
            :disabled="busy || !writable"
            @click="remove(rule)"
            ><X
          /></Button>
        </GroupRow>
        <GroupRow v-if="!rules.length" title="规则" value="尚未添加" tone="warn" :icon="ListChecks" />
      </template>
    </SettingsGroup>
    <SettingsSubpage :open="adding" title="添加规则" dialog-class="sm:max-w-md" @update:open="setAdding">
      <form :id="formId" class="grid gap-4" @submit.prevent="add">
        <SettingsGroup>
          <GroupRow title="类型" :icon="ListChecks">
            <PickerMenu v-model="draftType" field :options="TYPE_OPTIONS" />
          </GroupRow>
          <GroupRow title="群或联系人" :icon="Users">
            <SuggestInput v-model="draft" class="control mono-input target" label="机器人所在的群和好友" :options="contactOptions" :placeholder="placeholder" />
          </GroupRow>
        </SettingsGroup>
        <p v-if="problem" class="problem" role="alert">{{ problem }}</p>
      </form>
      <template #footer>
        <Button variant="outline" type="button" :disabled="busy" @click="setAdding(false)">取消</Button>
        <Button type="submit" :form="formId" :disabled="busy || !writable || !draft.trim()">添加</Button>
      </template>
    </SettingsSubpage>
  </div>
</template>
<script setup lang="ts">
import { platformDefinition } from "@yesimbot/contracts/platforms";
import { Globe, Checklist as ListChecks, User, Users, X } from "reicon-vue";
import { computed, onUnmounted, ref, toRaw, watch } from "vue";

import type { ContactEntry, ContactsResponse } from "../../../src/shared/contacts";
import type { PluginConfigSnapshot, PluginsSnapshot } from "../../../src/shared/plugin-config";
import { useLive } from "../context";
import { api, ApiError } from "../lib/api";
import { onCacheRefresh } from "../lib/cache";
import type { PickerOption } from "../lib/picker";
import { flattenPlugins, pluginError, pluginIdentity } from "../lib/plugin-config";
import { checkRule, platformRules, readableRule, readRules, ruleType, withoutRule, withRule, type ReplyRule, type RuleType } from "../lib/reply-rules";
import { toast, toastErrors } from "../lib/toast";
import TopicFeedback from "../shell/TopicFeedback.vue";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import PickerMenu from "./PickerMenu.vue";
import SettingsSubpage from "./SettingsSubpage.vue";
import SuggestInput from "./SuggestInput.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

const TYPE_OPTIONS: PickerOption[] = [
  { value: "", label: "群聊和私聊" },
  { value: "group", label: "仅群聊" },
  { value: "direct", label: "仅私聊" },
];

/**
 * The core plugin's 回复范围 (`allowedChannels`) for one platform: its own rules and those for every platform.
 * Each add or remove is applied to the latest saved list and saved at once with 撤销 (user, 2026-11-26: 设置页面全部
 * 改成即改即存), so a stale page never overwrites someone else's change and other platforms' rules stay as they are.
 */
const props = defineProps<{ platform: string }>();
const subscription = useLive().use<PluginsSnapshot>("plugins");
const formId = `scope-add-${props.platform}`;
let disposed = false,
  generation = 0;
const core = computed(() => flattenPlugins(subscription.state.data?.tree ?? []).find((v) => v.name === "yesimbot" && !v.group));
const writable = computed(() => !!subscription.state.data?.writable && !core.value?.locked);
const config = ref<PluginConfigSnapshot>(),
  saved = ref<unknown[]>([]),
  draft = ref(""),
  draftType = ref<RuleType>(""),
  problem = ref(""),
  error = ref(""),
  busy = ref(false),
  adding = ref(false);
toastErrors(
  error,
  () => (error.value = ""),
  () => !config.value,
  () => busy.value,
);
const rules = computed(() => platformRules(saved.value, props.platform));
const ruleKey = (rule: ReplyRule) => JSON.stringify([rule.platform, rule.channelId, ruleType(rule)]);
const typeLabel = (rule: ReplyRule) => TYPE_OPTIONS.find((option) => option.value === ruleType(rule))?.label ?? "";
function ruleIcon(rule: ReplyRule) {
  if (rule.channelId === "*") return Globe;
  const prefix = platformDefinition(rule.platform)?.directChannelPrefix;
  return rule.isDirect || (prefix && rule.channelId.startsWith(prefix)) ? User : Users;
}
const placeholder = computed(() => {
  const ids = platformDefinition(props.platform)?.ids;
  return ids ? `${ids.group}、${ids.direct}或 *` : "*";
});

// Group and friend names only help typing; rules are saved exactly as entered.
const contacts = ref<(ContactEntry & { platform: string })[]>([]);
void api<ContactsResponse>("/yesimbot/api/v1/bot/contacts")
  .then((result) => (contacts.value = result.bots.flatMap((bot) => bot.contacts.map((contact) => ({ ...contact, platform: bot.platform })))))
  .catch(() => {});
const nameOf = (rule: ReplyRule) =>
  rule.channelId === "*"
    ? undefined
    : contacts.value.find((entry) => (rule.platform === "*" || entry.platform === rule.platform) && entry.channelId === rule.channelId)?.name;
const contactOptions = computed<PickerOption[]>(() =>
  contacts.value
    .filter((entry) => entry.platform === props.platform)
    .map((entry) => ({ value: entry.channelId, label: `${entry.name}${entry.direct ? "（私聊）" : ""}`, note: entry.channelId })),
);

onUnmounted(() => {
  disposed = true;
  generation++;
  subscription.release();
});
// Declared before the immediate watch below, which loads at once.
const current = (path: string, token: number) => !disposed && token === generation && core.value?.path === path;
const readConfig = (path: string) => api<PluginConfigSnapshot>(`/yesimbot/api/v1/plugins/config?path=${encodeURIComponent(path)}`, undefined, { fresh: true });
onUnmounted(
  onCacheRefresh((path) => {
    if (core.value && !busy.value && path.endsWith(`config?path=${encodeURIComponent(core.value.path)}`)) void load();
  }),
);
watch(
  () => core.value?.path,
  (path, previous) => {
    generation++;
    busy.value = false;
    // Enable/disable only renames the key (`~name`): the same instance, so the list stays and is re-read quietly.
    if (path && previous && config.value && pluginIdentity(path) === pluginIdentity(previous)) {
      void load();
      return;
    }
    config.value = undefined;
    saved.value = [];
    error.value = problem.value = "";
    adding.value = false;
    void load();
  },
  { immediate: true, flush: "sync" },
);

async function load() {
  if (disposed || busy.value) return;
  const path = core.value?.path,
    token = ++generation;
  if (!path) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await readConfig(path);
    if (!current(path, token)) return;
    config.value = result;
    saved.value = readRules(result.config.allowedChannels);
  } catch (e) {
    if (current(path, token)) error.value = pluginError(e);
  } finally {
    if (current(path, token)) busy.value = false;
  }
}

/** Applies `change` to the newest saved list; a changed revision is re-read and retried. */
async function commit(change: (list: unknown[]) => unknown[], done: string, undo?: (list: unknown[]) => unknown[]) {
  if (disposed || busy.value || !core.value || !writable.value) return false;
  const path = core.value.path,
    token = ++generation;
  busy.value = true;
  error.value = "";
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await readConfig(path);
      if (!current(path, token)) return false;
      const next = change(readRules(latest.config.allowedChannels));
      const merged = { ...latest.config, allowedChannels: next };
      try {
        const result = await api<{ revision: string }>("/yesimbot/api/v1/plugins/update", { revision: latest.revision, path, config: merged });
        if (!current(path, token)) return false;
        config.value = { revision: result.revision, config: merged };
        saved.value = next;
        toast(done, "ok", undefined, undo && { label: "撤销", run: () => void commit(undo, done.replace(/^已保存/, "已撤销")) });
        return true;
      } catch (e) {
        if (!current(path, token)) return false;
        if (e instanceof ApiError && e.code === "config_changed" && attempt < 2) continue;
        throw e;
      }
    }
  } catch (e) {
    if (current(path, token)) error.value = pluginError(e);
  } finally {
    if (current(path, token)) busy.value = false;
  }
  return false;
}

async function add() {
  const checked = checkRule(props.platform, draft.value, draftType.value, rules.value);
  if ("error" in checked) {
    problem.value = checked.error;
    return;
  }
  problem.value = "";
  const { rule } = checked;
  if (
    await commit(
      (list) => withRule(list, rule),
      `已保存：添加 ${readableRule(rule)}`,
      (list) => withoutRule(list, rule),
    )
  ) {
    draft.value = "";
    adding.value = false;
  }
}
function openAdd() {
  draft.value = problem.value = "";
  draftType.value = "";
  adding.value = true;
}
function setAdding(open: boolean) {
  if (!open && busy.value) return;
  adding.value = open;
}
function remove(shown: ReplyRule) {
  const index = saved.value.indexOf(shown);
  const rule = { ...toRaw(shown) };
  void commit(
    (list) => withoutRule(list, rule),
    `已保存：移除 ${readableRule(rule)}`,
    (list) => withRule(list, rule, index),
  );
}
</script>
<style scoped>
@reference "../styles/app.css";

.remove {
  @apply text-muted-foreground;
}
.remove:hover:not(:disabled) {
  @apply text-destructive;
}
.target {
  width: min(16rem, 48vw);
}
.problem {
  @apply text-sm text-destructive;
  margin: 0;
}
</style>

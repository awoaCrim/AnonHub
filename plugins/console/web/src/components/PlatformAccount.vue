<template>
  <div class="grid min-w-0 gap-7">
    <Alert v-if="loadError && !editor.state.config" variant="destructive" as="p" role="alert"
      >{{ loadError }} <Button variant="outline" size="sm" :disabled="editor.state.loading" @click="load">重试</Button></Alert
    >
    <SettingsGroup title="账号">
      <GroupRow v-if="entries.length > 1" title="切换账号" :icon="UsersRound">
        <PickerMenu
          v-model="selected"
          field
          :options="entries.map((item) => ({ value: item.path, label: item.label || item.key }))"
          :disabled="autosave.saving.value || toggling"
        />
      </GroupRow>
      <GroupRow
        :title="accountId || (editor.state.loading ? '正在读取账号…' : `${platform.label}账号`)"
        :value="adapter ? ADAPTER_STATE[adapter.state] : entry?.enabled ? '未连接' : '未接入'"
        :tone="rowTone"
      >
        <template #icon
          ><span class="avatar" aria-hidden="true">{{ platform.label.slice(0, 1) }}</span></template
        >
      </GroupRow>
      <GroupRow v-if="adapter?.error" title="连接错误" :detail="adapter.error" :icon="TriangleAlert" icon-tone="danger" />
      <GroupRow v-if="!entry" :title="`接入${platform.label}`" :detail="canConnect ? undefined : '未配置接入服务'" :icon="Plug">
        <Button v-if="canConnect" variant="default" size="sm" :disabled="connecting || !writable" @click="emit('connect')">
          {{ connecting ? "正在准备…" : "开始接入" }}
        </Button>
      </GroupRow>
      <WechatLogin v-if="wechat && entry" :writable="writable" @account="wechatAccount = $event" />
      <GroupRow v-if="entry && editor.state.config" title="连接" :icon="Power">
        <Switch aria-label="启用连接" :model-value="!!entry.enabled" :disabled="toggling || !writable || entry.locked" @update:model-value="toggle" />
      </GroupRow>
    </SettingsGroup>
    <template v-if="wechat && editor.state.config">
      <SettingsGroup v-for="list in LISTS" :key="list.field" :title="list.title">
        <GroupRow title="自动回复" :icon="MessageSquareReply">
          <Switch
            :aria-label="`${list.title}自动回复`"
            :model-value="value(['autoReply', list.reply]) === true"
            :disabled="!editable"
            @update:model-value="commit(`${list.title}自动回复`, [[['autoReply', list.reply], $event]])"
          />
        </GroupRow>
        <GroupRow v-for="id in ids(list.field)" :key="id" :title="id" :icon="list.icon">
          <Button variant="ghost" size="icon-sm" type="button" :aria-label="`移除 ${id}`" :disabled="!editable" @click="remove(list, id)"><X /></Button>
        </GroupRow>
        <GroupRow :title="`添加${list.title}`" :icon="Plus">
          <form class="add" @submit.prevent="add(list)">
            <Input
              v-model="drafts[list.field]"
              class="add-input rounded-[10px] border-transparent bg-group-tile font-mono shadow-none dark:bg-group-tile"
              :aria-label="`${list.title} ID`"
              :placeholder="list.placeholder"
              :aria-invalid="!!problems[list.field]"
              :disabled="!editable"
              autocomplete="off"
              spellcheck="false"
              @input="problems[list.field] = ''"
            />
            <Button type="submit" variant="outline" size="sm" :disabled="!editable || !drafts[list.field].trim()">添加</Button>
          </form>
          <template v-if="problems[list.field]" #below
            ><p class="problem" role="alert">{{ problems[list.field] }}</p></template
          >
        </GroupRow>
      </SettingsGroup>
    </template>
  </div>
</template>
<script setup lang="ts">
import type { PlatformDefinition } from "@yesimbot/contracts/platforms";
import { Inbox, Reply as MessageSquareReply, Plug, Add as Plus, Power, Danger as TriangleAlert, User as UserRound, Users as UsersRound, X } from "reicon-vue";
import { computed, onBeforeUnmount, reactive, ref, watch, type Component } from "vue";

import type { PanelAdapter } from "../../../src/shared/panel";
import type { PluginConfigEntry } from "../../../src/shared/plugin-config";
import { useSession } from "../context";
import { api } from "../lib/api";
import { confirmDialog } from "../lib/dialog";
import { pluginError, pluginIdentity } from "../lib/plugin-config";
import { toast, toastErrors } from "../lib/toast";
import { ADAPTER_STATE, platformTone } from "../pages/platforms-model";
import { createAutosave, type Change } from "../state/autosave";
import { createConfigFieldsEditor, readPath } from "../state/config-fields";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import PickerMenu from "./PickerMenu.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import WechatLogin from "./WechatLogin.vue";

type ListField = "allowedRooms" | "allowedPeers";
type ListDefinition = {
  field: ListField;
  title: string;
  reply: "group" | "direct";
  icon: Component;
  placeholder: string;
  /** Why an entered ID does not belong in this list. */
  check(id: string): string;
};

/** A WeChat group's ID ends like this; any other ID is a person (`isGroupThread` in wechat-bridge). */
const ROOM = "@chatroom";
/**
 * The chats the WeChat bridge receives, each with its own 自动回复. They are edited in place and saved at once
 * (user, 2026-11-26: 设置页面全部改成即改即存), replacing a form of two textareas behind a save bar.
 */
const LISTS: ListDefinition[] = [
  {
    field: "allowedRooms",
    title: "群聊",
    reply: "group",
    icon: Inbox,
    placeholder: `123456789${ROOM}`,
    check: (id) => (id.endsWith(ROOM) ? "" : `群聊 ID 以 ${ROOM} 结尾。`),
  },
  {
    field: "allowedPeers",
    title: "私聊",
    reply: "direct",
    icon: UserRound,
    placeholder: "wxid_",
    check: (id) => (id.endsWith(ROOM) ? "这是群聊 ID，请添加到群聊。" : ""),
  },
];

const props = defineProps<{
  platform: PlatformDefinition;
  entries: PluginConfigEntry[];
  adapters: PanelAdapter[];
  writable: boolean;
  /** This account may set the platform up from here (its connection does not exist yet). */
  canConnect?: boolean;
  connecting?: boolean;
}>();
const emit = defineEmits<{ connect: [] }>();
const selected = ref("");
const entry = computed(() => props.entries.find((item) => item.path === selected.value) ?? props.entries[0]);
const adapter = computed(() => props.adapters.find((item) => item.configPath === entry.value?.path) ?? props.adapters[0]);
const session = useSession();
/** WeChat logs in through the daemon in this container: the wxid comes from the login, not from settings. */
const wechat = computed(() => props.platform.login === "wechat" && session.state.features.wechat);
// Other platforms have nothing to edit here; their editor only reads the account and the config revision.
const editor = createConfigFieldsEditor(props.platform.login === "wechat" ? ["allowedRooms", "allowedPeers", "autoReply"] : [], { savedNotice: "" });
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
  editor.dispose();
});
const autosave = createAutosave({
  read: (path) => readPath(editor.state.value, path),
  target: () => editor,
  disposed: () => disposed,
  notify: (text, undo) => toast(text, "ok", undefined, undo && { label: "撤销", run: undo }),
});
const value = autosave.value;
const loadError = ref("");
toastErrors(
  () => editor.state.error,
  () => (editor.state.error = ""),
  () => !editor.state.config,
  () => editor.state.busy,
);
watch(
  () => [editor.state.error, editor.state.config] as const,
  ([error, config]) => {
    if (!config) loadError.value = error;
  },
);
const toggling = ref(false);
const editable = computed(() => props.writable && !!entry.value && !entry.value.locked && !editor.state.loading && !toggling.value);

const wechatAccount = ref<string>();
const accountId = computed(() => {
  if (props.platform.login === "wechat") return wechatAccount.value;
  const selfId = editor.state.config?.selfId;
  return typeof selfId === "string" ? selfId : undefined;
});
const rowTone = computed(() => {
  const tone = platformTone(adapter.value?.state);
  return tone === "ok" || tone === "warn" || tone === "danger" ? tone : "idle";
});

const ids = (field: ListField): string[] => {
  const list = value([field]);
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
};
const drafts = reactive<Record<ListField, string>>({ allowedRooms: "", allowedPeers: "" });
const problems = reactive<Record<ListField, string>>({ allowedRooms: "", allowedPeers: "" });

/** Saves at once; a change made while another is saving goes out right after it. */
function commit(label: string, changes: Change[]) {
  if (disposed || !editable.value) return;
  void autosave.commit(label, changes);
}
function add(list: ListDefinition) {
  const id = drafts[list.field].trim();
  if (!id) return;
  const problem = /\s/.test(id) ? "ID 不能含空格。" : ids(list.field).includes(id) ? "已在列表中。" : list.check(id);
  if (problem) {
    problems[list.field] = problem;
    return;
  }
  drafts[list.field] = "";
  commit(`添加 ${id}`, [[[list.field], [...ids(list.field), id]]]);
}
function remove(list: ListDefinition, id: string) {
  commit(`移除 ${id}`, [[[list.field], ids(list.field).filter((item) => item !== id)]]);
}

function load() {
  loadError.value = "";
  return editor.load(entry.value?.path ?? "");
}
watch(
  () => entry.value?.path,
  (path, previous) => {
    if (!path) return;
    // Enable/disable only renames the key (`~name`): the same account, so the page stays as it is.
    if (previous && pluginIdentity(path) === pluginIdentity(previous)) {
      editor.state.path = path;
      if (!autosave.saving.value) void editor.load(path, true);
      return;
    }
    drafts.allowedRooms = drafts.allowedPeers = problems.allowedRooms = problems.allowedPeers = "";
    void editor.load(path, false);
  },
  { immediate: true },
);
async function toggle() {
  const current = entry.value;
  if (!current || !editor.state.config || toggling.value || autosave.saving.value) return;
  const enabled = !current.enabled;
  if (
    !enabled &&
    !(await confirmDialog({ title: `停用${props.platform.label}连接？`, message: "停用后将不再通过此账号收发消息。", confirmLabel: "停用", danger: true }))
  )
    return;
  toggling.value = true;
  try {
    const result = await api<{ path: string }>("/yesimbot/api/v1/plugins/enabled", { path: current.path, revision: editor.state.revision, enabled });
    if (disposed) return;
    selected.value = result.path;
    toast(enabled ? "连接已启用" : "连接已停用");
  } catch (error) {
    if (!disposed) toast(pluginError(error), "danger");
  } finally {
    if (!disposed) toggling.value = false;
  }
}
</script>
<style scoped>
@reference "../styles/app.css";

.avatar {
  @apply text-lg font-semibold;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
}
.add {
  display: flex;
  align-items: center;
  gap: 8px;
}
.add-input {
  width: min(15rem, 42vw);
}
.problem {
  @apply text-sm text-destructive;
  margin: 0;
}
</style>

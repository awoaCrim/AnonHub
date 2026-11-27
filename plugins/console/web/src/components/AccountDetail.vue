<template>
  <div class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7" :aria-label="`${account.username} 的 bot`">
    <SettingsGroup :label="`${account.username} 的 bot`">
      <GroupRow
        :title="account.username"
        :detail="`${account.runtime.qqAccount ? `QQ ${account.runtime.qqAccount}` : '未绑定 QQ'} · ${formatTime(account.createdAt, 'day')} 加入`"
        :value="status.label"
        :tone="status.tone || 'idle'"
      >
        <template #icon
          ><span class="initial" :class="{ 'opacity-50': !account.enabled }">{{ account.username.slice(0, 1).toUpperCase() }}</span></template
        >
      </GroupRow>
    </SettingsGroup>

    <SettingsGroup v-if="status.problems.length > 1" title="需要处理" tone="danger">
      <GroupRow
        v-for="problem in status.problems"
        :key="problem.label"
        :title="problem.label"
        :icon="TriangleAlert"
        :icon-tone="problem.tone === 'danger' ? 'danger' : 'warn'"
      />
    </SettingsGroup>

    <SettingsGroup v-if="stats.length" title="概况">
      <GroupRow v-for="stat in stats" :key="stat.label" :title="stat.label" :detail="stat.note" :value="stat.value" />
    </SettingsGroup>

    <InstanceOps v-if="account.enabled && account.runtime.state === 'running'" :ops="ops" :base="`admin/instances/${account.id}/napcat`" :restart="restart" />

    <SettingsGroup v-if="health" title="bot">
      <GroupRow v-for="line in lines" :key="line.label" :title="line.label" :value="line.value" />
    </SettingsGroup>

    <SettingsGroup v-if="health?.recent?.length" title="最近的对话">
      <GroupRow
        v-for="chat in health.recent"
        :key="chat.channelId"
        :title="chat.channelId.replace(/^private:/, '')"
        :detail="chatTypes[chat.type]"
        :value="relativeTime(chat.at)"
        :icon="chat.type === 'direct' ? User : Users"
      />
    </SettingsGroup>

    <SettingsGroup title="管理">
      <GroupRow title="功能授权" :detail="grantSummary" :icon="Puzzle" clickable @open="openPlugins()" />
      <GroupRow title="重置密码" :icon="KeyRound" clickable @open="openReset()" />
      <GroupRow
        title="账号管理"
        :value="account.enabled ? '已启用' : '已停用'"
        :tone="account.enabled ? undefined : 'idle'"
        :icon="Settings2"
        clickable
        @open="openManagement()"
      />
    </SettingsGroup>

    <Dialog :open="state.pluginsId === account.id" @update:open="!$event && (state.pluginsId = '')">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" @close-auto-focus="restoreDialogFocus">
        <DialogHeader class="pr-6">
          <DialogTitle>{{ account.username }} · 功能授权</DialogTitle>
          <DialogDescription class="sr-only">选择这位好友能使用的功能</DialogDescription>
        </DialogHeader>
        <PluginGrants :model-value="state.pluginsDraft" title="可用功能" @update:model-value="grant" />
      </DialogContent>
    </Dialog>
    <Dialog :open="state.resetId === account.id" @update:open="!$event && !state.busy && closeReset()">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-lg" @close-auto-focus="restoreDialogFocus">
        <DialogHeader class="pr-6">
          <DialogTitle>{{ account.username }} · 重置密码</DialogTitle>
          <DialogDescription class="sr-only">设置新的登录密码</DialogDescription>
        </DialogHeader>
        <form class="grid gap-5" @submit.prevent="reset">
          <SettingsGroup label="新密码">
            <GroupRow title="新密码" :icon="KeyRound">
              <Input
                id="reset-password"
                v-model="state.resetPassword"
                class="w-32 max-w-full rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile"
                aria-label="新密码"
                :type="generated ? 'text' : 'password'"
                autocomplete="new-password"
                required
                minlength="12"
                maxlength="4096"
                :disabled="state.busy"
                @input="generated = false"
              />
              <Button type="button" variant="outline" size="sm" class="rounded-full" :disabled="state.busy" @click="generate">随机生成</Button>
            </GroupRow>
          </SettingsGroup>
          <DialogFooter>
            <Button type="button" variant="outline" class="rounded-full" :disabled="state.busy" @click="closeReset">取消</Button>
            <Button class="rounded-full" :disabled="state.busy">确认重置</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog v-model:open="managementOpen">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-lg" @close-auto-focus="restoreDialogFocus">
        <DialogHeader class="pr-6">
          <DialogTitle>{{ account.username }} · 账号管理</DialogTitle>
          <DialogDescription class="sr-only">停用、重新启用或删除这个账号</DialogDescription>
        </DialogHeader>
        <SettingsGroup label="账号管理">
          <GroupRow title="状态" :value="account.enabled ? '已启用' : '已停用'" :tone="account.enabled ? 'ok' : 'idle'" :icon="Power">
            <Button :variant="account.enabled ? 'outline' : 'default'" size="sm" class="rounded-full" :disabled="state.busy" @click="toggle">{{
              account.enabled ? "停用" : "重新启用"
            }}</Button>
          </GroupRow>
          <GroupRow title="删除好友" :icon="Trash2" icon-tone="danger">
            <Button variant="danger" size="sm" class="rounded-full" :disabled="state.busy" @click="remove">删除…</Button>
          </GroupRow>
        </SettingsGroup>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { Key as KeyRound, Power, Puzzle, Setting2 as Settings2, Trash2, Danger as TriangleAlert, User, Users } from "reicon-vue";
import { computed, ref } from "vue";

import type { AccountHealth, AccountView, OpsInstance, OpsProgramName } from "../../../src/shared/accounts";
import { OPTIONAL_MEMBER_PLUGINS } from "../../../src/shared/plugin-catalog";
import { confirmDialog } from "../lib/dialog";
import { formatTime } from "../lib/format";
import { toast } from "../lib/toast";
import { formatUptime, modelIdentity } from "../pages/overview-model";
import { compact } from "../pages/usage-model";
import { friendStatus, relativeTime } from "../state/accounts-health";
import { generatePassword, type createAccountsState } from "../state/accounts-state";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import InstanceOps from "./InstanceOps.vue";
import PluginGrants from "./PluginGrants.vue";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

/** One friend's bot: how it is doing, what to do about problems, what it may use, and their login. */
const props = defineProps<{
  account: AccountView;
  row?: AccountHealth;
  view: ReturnType<typeof createAccountsState>;
  /** The host manager's view of this friend's container; absent while unreadable. */
  ops?: OpsInstance;
  restart: (program: OpsProgramName) => Promise<void>;
}>();
const state = props.view.state;
const health = computed(() => props.row?.health ?? undefined);
const status = computed(() => friendStatus(props.account, props.row, props.ops));
const chatTypes = { channel: "频道", guild: "群聊", direct: "私聊" } as const;
const model = computed(() => {
  const value = health.value;
  if (value?.chatModel) return modelIdentity(value.chatModel).modelId ?? value.chatModel;
  return value?.modelReady === true ? "已选择" : value?.modelReady === false ? "还没选" : "未知";
});
const role = computed(() => {
  const value = health.value;
  if (!value) return "未知";
  if (value.roleReady === null) return value.modelReady === null ? "未知" : "不用角色卡";
  return value.roleReady ? "已设置" : "还没设置";
});
/** Usually everything is granted, so the exceptions say more than the count. */
const grantSummary = computed(() => {
  const granted = new Set(props.account.plugins);
  const offered = OPTIONAL_MEMBER_PLUGINS;
  const missing = offered.filter((item) => !granted.has(item.name)).map((item) => item.label);
  if (!missing.length) return `全部 ${offered.length} 项都能用`;
  if (missing.length === offered.length) return "只能聊天，可选功能都没有给";
  return missing.length <= 3 ? `除了${missing.join("、")}，其他都能用` : `能用 ${offered.length - missing.length} / ${offered.length} 项`;
});

const stats = computed(() => {
  const value = health.value;
  if (!value) return [];
  return [
    {
      label: "今天回复",
      value: value.todayCalls == null ? "—" : `${value.todayCalls} 次`,
      note: value.todayTokens ? `${compact(value.todayTokens)} Token` : "",
    },
    { label: "最近聊天", value: relativeTime(value.lastActivityAt) },
    { label: "聊过的群和私聊", value: value.conversations == null ? "—" : `${value.conversations} 个` },
    { label: "已运行", value: value.uptimeSeconds == null ? "—" : formatUptime(value.uptimeSeconds) },
  ];
});
const lines = computed(() => {
  const value = health.value;
  if (!value) return [];
  return [
    { label: "回复模型", value: model.value, title: value.chatModel ?? undefined },
    { label: "角色", value: role.value },
    { label: "回复范围", value: value.allowedChannels == null ? "未知" : value.allowedChannels ? `${value.allowedChannels} 条规则` : "还没选" },
    { label: "发送失败", value: value.failures == null ? "未知" : value.failures ? `最近 ${value.failures} 条` : "没有" },
  ];
});
async function remove() {
  const account = props.account;
  const ok = await confirmDialog({
    title: `永久删除 ${account.username}？`,
    message: `${account.username} 将不能再登录；bot、聊天记录、记忆和设置都会删掉，不能恢复。`,
    confirmLabel: "永久删除",
    danger: true,
    typeToConfirm: account.username,
  });
  if (ok) await props.view.remove(account);
}
async function toggle() {
  const account = props.account;
  const ok = await confirmDialog({
    title: `${account.enabled ? "停用" : "重新启用"} ${account.username}？`,
    message: `原来的登录会失效，数据保留。${account.enabled ? "好友的 bot 也会停止。" : ""}`,
    confirmLabel: account.enabled ? "停用" : "启用",
    danger: account.enabled,
  });
  if (ok) void props.view.enabled(account);
}
let dialogTrigger: HTMLElement | undefined;
function rememberDialogTrigger(event?: MouseEvent) {
  // A row opens with no event: the row's own button holds the focus.
  const target = (event?.currentTarget ?? document.activeElement) as HTMLElement | null;
  if (target) dialogTrigger = target;
}
function restoreDialogFocus(event: Event) {
  event.preventDefault();
  if (
    state.pluginsId === props.account.id ||
    state.resetId === props.account.id ||
    managementOpen.value ||
    document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')
  )
    return;
  if (dialogTrigger?.isConnected && !dialogTrigger.matches(":disabled")) dialogTrigger.focus();
}
function openPlugins(event?: MouseEvent) {
  rememberDialogTrigger(event);
  state.resetId = "";
  state.pluginsId = props.account.id;
  state.pluginsDraft = [...props.account.plugins];
}
const sameGrant = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((name) => b.includes(name));
let granting = false;
/**
 * Each switch saves at once with 撤销 (user, 2026-11-26: 即改即存); switches flipped while a save runs go out right
 * after it, together. A failed save shows the grant the server kept.
 */
async function grant(next: string[], undo = false) {
  const id = props.account.id;
  state.pluginsDraft = next;
  if (granting) return;
  granting = true;
  try {
    while (state.pluginsId === id && !sameGrant(state.pluginsDraft, props.account.plugins)) {
      const before = [...props.account.plugins];
      if (!(await props.view.savePlugins(id, [...state.pluginsDraft]))) {
        state.pluginsDraft = [...props.account.plugins];
        break;
      }
      toast(undo ? "已撤销" : "已保存", "ok", undefined, undo ? undefined : { label: "撤销", run: () => void grant(before, true) });
      undo = false;
    }
  } finally {
    granting = false;
  }
}
/** A generated password stays readable so the owner can check it before sending. */
const generated = ref(false);
const managementOpen = ref(false);
function openManagement(event?: MouseEvent) {
  rememberDialogTrigger(event);
  managementOpen.value = true;
}
function generate() {
  state.resetPassword = generatePassword();
  generated.value = true;
}
function openReset(event?: MouseEvent) {
  rememberDialogTrigger(event);
  state.pluginsId = "";
  state.resetId = props.account.id;
  state.resetPassword = "";
  generated.value = false;
}
function closeReset() {
  state.resetId = "";
  state.resetPassword = "";
}
async function reset() {
  if (await confirmDialog({ title: "重置密码？", message: "好友原来的登录会失效。", confirmLabel: "重置密码", danger: true })) void props.view.reset();
}
</script>
<style scoped>
@reference "../styles/app.css";

.initial {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-size: 16px;
  font-weight: 600;
}
</style>

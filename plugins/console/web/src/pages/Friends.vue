<template>
  <div class="page grouped friends">
    <template v-if="adminSession.role === 'owner'">
      <Teleport defer to="#page-actions">
        <Button v-if="!current && selected !== 'owner'" variant="default" class="rounded-full" :disabled="state.busy" @click="openCreate">添加好友</Button>
      </Teleport>
      <Alert v-if="state.error" variant="destructive" as="p" role="alert">{{ state.error }}</Alert>

      <!-- One instance at a time, full width; the page title (实例 › name) leads back to all of them. -->
      <div v-if="selected === 'owner'" key="owner" class="view-enter">
        <OwnerDetail :health="health?.owner" :ops="ops?.owner" :restart="(program) => restart('owner', program)" :restarting="ownerRestarting" />
      </div>
      <div v-else-if="current" :key="current.id" class="view-enter">
        <AccountDetail
          :account="current"
          :row="rows[current.id]"
          :view="view"
          :ops="ops?.accounts[current.id]"
          :restart="(program) => restart(current!.id, program)"
        />
      </div>
      <div v-else key="list" class="view-enter grid gap-7">
        <div v-if="state.accounts.length > 8 || healthError" class="toolbar">
          <label v-if="state.accounts.length > 8" class="search"
            ><span class="sr-only">搜索好友</span
            ><Input v-model="q" type="search" placeholder="搜索用户名或 QQ 号" class="rounded-[10px] border-transparent bg-group shadow-none dark:bg-group"
          /></label>
          <small v-if="healthError" class="muted updated" role="status">{{ healthError }}</small>
        </div>
        <AccountList
          :accounts="visible"
          :total="state.accounts.length"
          :rows="rows"
          :ops="ops?.accounts"
          :owner="ownerTile"
          :busy="state.busy"
          @select="selected = $event"
          @clear="q = ''"
        />
      </div>
      <Dialog :open="creating" @update:open="!state.busy && (creating = $event)">
        <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" @close-auto-focus="restoreCreateFocus">
          <DialogHeader class="pr-6">
            <DialogTitle>添加好友</DialogTitle>
            <DialogDescription class="sr-only">新好友的账号与功能授权</DialogDescription>
          </DialogHeader>
          <Alert v-if="state.error" variant="destructive" role="alert">{{ state.error }}</Alert>
          <AccountCreateForm :view="view" @close="creating = false" />
        </DialogContent>
      </Dialog>
      <Dialog :open="!!state.share" @update:open="!$event && (state.share = null)">
        <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <FriendLoginShare v-if="state.share" :login="state.share" @close="state.share = null" />
        </DialogContent>
      </Dialog>
    </template>
    <Alert v-else as="p" role="alert">只有管理员能管理实例。</Alert>
  </div>
</template>
<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";

import type { AccountHealth, AccountsHealthResponse, OpsProgramName } from "../../../src/shared/accounts";
import AccountCreateForm from "../components/AccountCreateForm.vue";
import AccountDetail from "../components/AccountDetail.vue";
import AccountList from "../components/AccountList.vue";
import FriendLoginShare from "../components/FriendLoginShare.vue";
import OwnerDetail from "../components/OwnerDetail.vue";
import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { useSession } from "../context";
import { adminRequest } from "../lib/admin-request";
import { onCacheRefresh } from "../lib/cache";
import { useRouteState } from "../lib/route-state";
import { toast, toastErrors, toastNotices } from "../lib/toast";
import { usePageCrumb } from "../shell/page-crumb";
import { friendOrder, friendStatus, matchesFilter, ownerStatus, relativeTime } from "../state/accounts-health";
import { createAccountsState } from "../state/accounts-state";
import { mergeOps, restartInstance } from "../state/instance-ops";

/**
 * 实例: the owner's own bot first, then every friend's, the ones needing a look first; a tile opens that instance
 * with its QQ and restart controls. Adding a friend shows their login once, ready to send.
 */
const adminSession = useSession().state;
const view = createAccountsState();
const { state } = view;
toastNotices(
  () => state.notice,
  () => (state.notice = ""),
);
// Failed actions show as toasts; a page that could not be read keeps its error and retry in place.
toastErrors(
  () => state.error,
  () => (state.error = ""),
  () => !state.accounts.length,
  () => state.busy,
);
const creating = ref(false);
let createTrigger: HTMLElement | undefined;
function openCreate(event: MouseEvent) {
  createTrigger = event.currentTarget as HTMLElement;
  creating.value = true;
}
function restoreCreateFocus(event: Event) {
  event.preventDefault();
  if (creating.value || document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
  if (createTrigger?.isConnected && !createTrigger.matches(":disabled")) createTrigger.focus();
}
// A created friend's login replaces the form (the next step is sending it), and the friend opens.
watch(
  () => state.share,
  (share) => {
    if (share?.reason !== "created") return;
    creating.value = false;
    const id = state.accounts.find((account) => account.username === share.username)?.id;
    if (id) selected.value = id;
  },
);
function refresh() {
  if (adminSession.role === "owner") void view.refresh();
}
onMounted(refresh);
onActivated(refresh);
onBeforeUnmount(view.dispose);
onBeforeUnmount(onCacheRefresh((path) => path === "/yesimbot/admin/accounts" && refresh()));

const q = useRouteState("q", "");
const selected = useRouteState("account", "");
const health = ref<AccountsHealthResponse>();
const healthError = ref("");
const rows = computed<Record<string, AccountHealth>>(() => Object.fromEntries((health.value?.accounts ?? []).map((row) => [row.id, row])));
const ops = computed(() => health.value?.ops ?? undefined);
const statuses = computed(
  () => new Map(state.accounts.map((account) => [account.id, friendStatus(account, rows.value[account.id], ops.value?.accounts[account.id])])),
);
const ownerOps = computed(() => ownerStatus(health.value?.owner, ops.value?.owner));
const ownerTile = computed(() => ({
  status: ownerOps.value,
  note: health.value?.owner?.lastActivityAt != null ? `${relativeTime(health.value.owner.lastActivityAt)}聊过` : health.value ? "还没聊过" : "正在读取状态…",
}));
const visible = computed(() =>
  state.accounts
    .filter((account) => matchesFilter(account, rows.value[account.id], "all", q.value))
    .map((account, index) => ({ account, index, order: friendOrder(statuses.value.get(account.id)!) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((item) => item.account),
);
const current = computed(() => state.accounts.find((account) => account.id === selected.value));
usePageCrumb(() =>
  selected.value === "owner"
    ? { label: "你的 bot", back: () => (selected.value = "") }
    : current.value
      ? { label: current.value.username, back: () => (selected.value = "") }
      : undefined,
);

// Health is fetched on demand (not a topic) and polled only while this page is visible.
let healthRevision = 0,
  healthTimer: ReturnType<typeof setTimeout> | undefined,
  active = false;
/** While the owner's own bot restarts, nothing answers for a while: that is expected, so no error and a quick retry. */
const ownerRestarting = ref(false);
let ownerBackAfter = 0,
  ownerGiveUp = 0;
async function loadHealth(fresh = false) {
  if (healthTimer) clearTimeout(healthTimer);
  if (!active || adminSession.role !== "owner" || document.hidden) return;
  const revision = ++healthRevision;
  try {
    const result = await adminRequest<AccountsHealthResponse>(fresh ? "admin/accounts/health?refresh=1" : "admin/accounts/health");
    if (revision !== healthRevision) return;
    // An answer before the restart has had time to begin could still come from the old process.
    if (ownerRestarting.value && Date.now() < ownerBackAfter) return;
    health.value = result;
    healthError.value = "";
    ownerRestarting.value = false;
  } catch {
    if (revision === healthRevision && !ownerRestarting.value) healthError.value = "暂时读不到各实例的状态，稍后自动重试";
    if (ownerRestarting.value && Date.now() > ownerGiveUp) ownerRestarting.value = false;
  } finally {
    if (revision === healthRevision && active) healthTimer = setTimeout(() => void loadHealth(ownerRestarting.value), ownerRestarting.value ? 4_000 : 30_000);
  }
}
/** Restarts one instance's bot or QQ; the caller's button stays busy until this settles. */
async function restart(target: string, program: OpsProgramName) {
  try {
    const outcome = await restartInstance(target, program);
    if (outcome.kind === "accepted") {
      ownerRestarting.value = true;
      ownerBackAfter = Date.now() + 8_000;
      ownerGiveUp = Date.now() + 120_000;
      healthError.value = "";
      toast("bot 正在重启，约半分钟后恢复，页面会自动重新连接。");
      void loadHealth(true);
      return;
    }
    if (outcome.instance && health.value) health.value = { ...health.value, ops: mergeOps(health.value.ops, outcome.instance) };
    toast(program === "koishi" ? "bot 已重启。" : "QQ 已重启，稍等片刻会自动登回。");
    void loadHealth(true);
  } catch {
    toast("重启没有成功：实例可能正忙或没在运行，请稍后再试。", "danger");
  }
}
const visibility = () => void loadHealth(ownerRestarting.value);
onMounted(() => {
  active = true;
  document.addEventListener("visibilitychange", visibility);
  void loadHealth();
});
onActivated(() => {
  active = true;
  void loadHealth();
});
onDeactivated(() => {
  active = false;
  if (healthTimer) clearTimeout(healthTimer);
});
onBeforeUnmount(() => {
  active = false;
  healthRevision++;
  if (healthTimer) clearTimeout(healthTimer);
  document.removeEventListener("visibilitychange", visibility);
});
</script>
<style scoped>
@reference "../styles/app.css";

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.toolbar .search {
  flex: 0 1 320px;
}
.toolbar .updated {
  @apply text-xs;
  margin-left: auto;
}
@media (max-width: 640px) {
  .toolbar .search {
    flex: 1 1 100%;
  }
  .toolbar .updated {
    margin-left: 0;
  }
}
</style>

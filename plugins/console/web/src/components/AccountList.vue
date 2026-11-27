<template>
  <div class="grid min-w-0 gap-7">
    <SettingsGroup v-if="owner" title="我的机器人">
      <GroupRow
        title="我的 bot"
        :detail="owner.qq ? `QQ ${owner.qq} · ${owner.note}` : owner.note"
        :value="owner.status.label"
        :tone="toneOf(owner.status.tone)"
        clickable
        @open="emit('select', 'owner')"
      >
        <template #icon><Bot class="size-5" aria-hidden="true" /></template>
      </GroupRow>
    </SettingsGroup>

    <SettingsGroup title="好友">
      <GroupRow v-if="!total" :title="busy ? '正在读取…' : '暂无好友'" :icon="Users" />
      <GroupRow v-else-if="!accounts.length" title="没有符合条件的好友" :icon="Search">
        <Button variant="outline" size="sm" class="rounded-full" @click="emit('clear')">清除搜索</Button>
      </GroupRow>
      <GroupRow
        v-for="account in accounts"
        :key="account.id"
        :title="account.username"
        :detail="detailOf(account)"
        :value="statusOf(account).label"
        :tone="toneOf(statusOf(account).tone)"
        :class="{ off: !account.enabled }"
        clickable
        @open="emit('select', account.id)"
      >
        <template #icon>
          <span class="avatar" aria-hidden="true">
            <img
              v-if="avatarOf(account) && !broken[account.id]"
              :src="avatarOf(account)"
              alt=""
              referrerpolicy="no-referrer"
              loading="lazy"
              @error="broken[account.id] = true"
            />
            <span v-else>{{ account.username.slice(0, 1).toUpperCase() }}</span>
          </span>
        </template>
        <!-- A dropped QQ: the owner can scan it again from the friend's page; failing that, send them where. -->
        <template v-if="relogin(account)" #below>
          <Button type="button" variant="outline" size="sm" class="rounded-full" @click="copyRelogin(account)">
            {{ copied === account.id ? "已复制" : "复制重新登录链接" }}
          </Button>
        </template>
      </GroupRow>
    </SettingsGroup>
  </div>
</template>

<script setup lang="ts">
import { Ghost as Bot, Search, Users } from "reicon-vue";
import { onUnmounted, reactive, ref } from "vue";

import type { AccountHealth, AccountView, OpsInstance } from "../../../src/shared/accounts";
import { toast } from "../lib/toast";
import { friendStatus, relativeTime, type FriendStatus } from "../state/accounts-health";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import { Button } from "./ui/button";

/** The owner's bot, then every friend, as rows: who, their QQ and last chat, how their bot is doing, and the fix when there is one. */
const props = defineProps<{
  /** Friends matching the search, in display order. */
  accounts: AccountView[];
  /** All friends, to tell "none yet" from "none match". */
  total: number;
  rows: Record<string, AccountHealth>;
  /** What the host manager reports per friend. */
  ops?: Record<string, OpsInstance>;
  /** The owner's own row, shown first. */
  owner?: { status: FriendStatus; qq?: string; note: string };
  busy: boolean;
}>();
const emit = defineEmits<{ select: [id: string]; clear: [] }>();
const statusOf = (account: AccountView) => friendStatus(account, props.rows[account.id], props.ops?.[account.id]);
const toneOf = (tone: FriendStatus["tone"]) => tone || "idle";
/** The friend's QQ picture; names are often phone numbers, so an initial says nothing. */
const broken = reactive<Record<string, boolean>>({});
function avatarOf(account: AccountView) {
  const qq = account.runtime.qqAccount;
  return qq && /^[1-9]\d{4,11}$/.test(qq) ? `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100` : "";
}
/** 今天回复 only when there were replies today; otherwise just when it last talked. */
function activity(account: AccountView) {
  const health = props.rows[account.id]?.health;
  if (!account.enabled) return "";
  if (!health) return account.runtime.state === "running" ? "正在读取状态…" : "";
  const today = health.todayCalls ? `今天回复 ${health.todayCalls} 次` : "";
  const last = health.lastActivityAt ? `${relativeTime(health.lastActivityAt)}聊过` : "还没聊过";
  return [today, last].filter(Boolean).join(" · ");
}
const detailOf = (account: AccountView) =>
  [account.runtime.qqAccount ? `QQ ${account.runtime.qqAccount}` : "未绑定 QQ", activity(account)].filter(Boolean).join(" · ");
const relogin = (account: AccountView) => account.enabled && props.rows[account.id]?.health?.qqOnline === false;
const copied = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
async function copyRelogin(account: AccountView) {
  const url = `${globalThis.location?.origin ?? ""}/login?returnTo=${encodeURIComponent("/settings/platforms")}`;
  const text = ["你的 bot 的 QQ 掉线了，重新扫码登录一下就好：", `打开 ${url}`, `用你的账号（${account.username}）登录后，用手机 QQ 扫页面上的二维码。`].join(
    "\n",
  );
  try {
    await navigator.clipboard.writeText(text);
    copied.value = account.id;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => (copied.value = ""), 2500);
  } catch {
    toast("无法自动复制，请手动把登录地址发给好友。", "danger");
  }
}
onUnmounted(() => timer && clearTimeout(timer));
</script>

<style scoped>
@reference "../styles/app.css";

.avatar {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 12px;
  color: var(--text-2);
  font-size: 16px;
  font-weight: 600;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.off .avatar {
  opacity: 0.55;
}
</style>

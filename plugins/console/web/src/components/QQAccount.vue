<template>
  <div class="grid min-w-0 gap-7">
    <Alert v-if="state.error" variant="destructive" as="p" role="alert">{{ state.error }}</Alert>

    <template v-if="state.status?.loggedIn">
      <SettingsGroup title="账号">
        <GroupRow
          :title="state.status.nickname || 'QQ 账号'"
          :detail="state.status.accountId ? `QQ ${state.status.accountId}` : '账号信息暂未获取'"
          :value="state.status.connecting ? '正在连接' : onlineLabel(state.status.online ?? undefined)"
          :tone="state.status.connecting ? 'idle' : state.status.online === true ? 'ok' : state.status.online === false ? 'danger' : 'idle'"
        >
          <template #icon>
            <span class="avatar">
              <img
                v-if="state.status.avatarUrl && !avatarFailed"
                :src="state.status.avatarUrl"
                :alt="`${state.status.nickname || 'QQ'}的头像`"
                referrerpolicy="no-referrer"
                @error="avatarFailed = true"
              />
              <span v-else>{{ avatarLetter }}</span>
            </span>
          </template>
        </GroupRow>
        <GroupRow title="刷新状态" :detail="state.checkedAt ? `更新于 ${checkedTime}` : '正在更新'" :icon="RefreshCw">
          <Button variant="outline" size="sm" :disabled="state.busy || state.logoutRequested" @click="model.refresh()">
            {{ state.busy ? "刷新中…" : "刷新" }}
          </Button>
        </GroupRow>
        <GroupRow title="退出登录" :icon="LogOut" icon-tone="danger">
          <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" :disabled="state.busy || state.logoutRequested" @click="logout">
            {{ state.loggingOut ? "正在退出…" : state.logoutRequested ? "等待退出确认…" : "退出 QQ" }}
          </Button>
        </GroupRow>
      </SettingsGroup>
      <!-- State only (user, 2026-11-23): an offline account already says 离线 on its row. -->
      <Alert v-if="state.status.message && state.status.online !== false" variant="warn" as="p" role="status">
        {{ state.status.available ? "部分账号信息暂时无法读取" : "登录服务暂时无法读取" }}
      </Alert>
      <Alert v-if="state.logoutRequested" as="p" role="status">{{ state.notice }}</Alert>
    </template>

    <SettingsGroup v-else title="登录">
      <template #actions><Segmented v-model="method" :options="methods" label="登录方式" /></template>
      <div v-if="method === 'qr'" class="login">
        <div class="qr-frame" :class="{ dead: qrDead }">
          <img
            v-if="qrImage && state.status?.available"
            class="qr-image"
            :src="qrImage"
            :alt="qrDead ? 'QQ 登录二维码已失效' : 'QQ 登录二维码，请使用手机 QQ 扫码'"
            referrerpolicy="no-referrer"
          />
          <div v-else class="qr-placeholder">{{ restartingQq ? "QQ 正在重启…" : state.busy || !state.status ? "正在获取二维码…" : "二维码暂未就绪" }}</div>
          <div v-if="qrDead && qrImage && state.status?.available" class="qr-dead" role="status">二维码已失效</div>
        </div>
        <div class="login-side">
          <Alert v-if="state.status && !state.status.available" variant="warn" as="p" role="status">QQ 登录服务暂时不可用</Alert>
          <Alert v-if="state.status?.available && state.status.loginProblem" variant="warn" as="p" role="status">
            {{
              state.status.loginProblem === "kicked"
                ? "QQ 已被下线。请刷新二维码后重新扫码，或改用账号密码登录。"
                : "上次登录没有成功。请重新扫码，或改用账号密码登录。"
            }}
          </Alert>
          <Alert v-if="state.notice && state.status?.available" as="p" role="status">{{ state.notice }}</Alert>
          <div class="flex flex-wrap gap-2">
            <Button v-if="qrDead && canRestart" variant="default" :disabled="restartingQq || state.busy" @click="restartQq">
              {{ restartingQq ? "正在重启…" : "重启 QQ" }}
            </Button>
            <Button
              :variant="qrDead && canRestart ? 'outline' : 'default'"
              :disabled="state.busy || state.logoutRequested || restartingQq"
              @click="model.refresh(true)"
            >
              {{ state.busy ? "更新中…" : "刷新二维码" }}
            </Button>
            <Button variant="outline" :disabled="state.busy || state.logoutRequested" @click="model.refresh()">检查状态</Button>
          </div>
        </div>
      </div>
      <QQPasswordLogin v-else :model="passwordLogin" :available="state.status?.available !== false" />
    </SettingsGroup>
  </div>
</template>

<script lang="ts" setup>
import { Logout as LogOut, Refresh as RefreshCw } from "reicon-vue";
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";

import { useSession } from "../context";
import { confirmDialog } from "../lib/dialog";
import { formatTime, onlineLabel } from "../lib/format";
import { toast } from "../lib/toast";
import { restartInstance } from "../state/instance-ops";
import { createNapCatState } from "../state/napcat-state";
import { createQQPasswordLogin } from "../state/qq-password-login";
import GroupRow from "./group/GroupRow.vue";
import Segmented from "./group/Segmented.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import QQPasswordLogin from "./QQPasswordLogin.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

/** `base` picks whose QQ this is: the default is this bot's own, `admin/instances/<id>/napcat` is a friend's. */
const props = withDefaults(defineProps<{ base?: string }>(), { base: "napcat" });
const model = createNapCatState(undefined, props.base);
const state = model.state;
/** Lives here, not in the tab, so switching tabs keeps a verification in progress. */
const passwordLogin = createQQPasswordLogin(undefined, undefined, props.base);
const method = ref<"qr" | "password">("qr");
const methods = [
  { value: "qr", label: "扫码登录" },
  { value: "password", label: "账号密码登录" },
] as const;
const avatarFailed = ref(false);
const avatarLetter = computed(() => Array.from(state.status?.nickname || "Q")[0]);
const checkedTime = computed(() => formatTime(state.checkedAt, "clock"));
const qrImage = computed(() => (/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(state.qrCode) ? state.qrCode : ""));
/**
 * QQ's login codes last about two minutes and NapCat replaces an expired one by itself. A code still up after three,
 * or one a refresh could not replace, is dead: phone QQ answers "已过期" (user, 2026-11-26). Only restarting QQ helps.
 */
const QR_LIFETIME_SECONDS = 180;
const qrDead = computed(() => !!state.qrId && (state.qrId === state.deadQrId || (state.status?.qrAge ?? 0) > QR_LIFETIME_SECONDS));
const session = useSession();
/** The account manager restarts a QQ; the owner's own is `owner`, a friend's is named in `base`. */
const restartTarget = computed(() => (props.base === "napcat" ? "owner" : /^admin\/instances\/([^/]+)\/napcat$/.exec(props.base)?.[1]));
const canRestart = computed(() => !!session.state.features.accounts && !!restartTarget.value);
const restartingQq = ref(false);
// The restart is over once NapCat shows a code other than the dead one (or the account is back).
watch(
  () => [state.qrId, state.status?.loggedIn] as const,
  ([id, loggedIn]) => {
    if (restartingQq.value && (loggedIn || (id && !qrDead.value))) restartingQq.value = false;
  },
);
watch(
  () => state.status?.avatarUrl,
  () => {
    avatarFailed.value = false;
  },
);
watch(
  () => state.status?.loggedIn,
  (loggedIn) => {
    if (loggedIn) passwordLogin.reset();
  },
);
let active = true;
const updateVisibility = () => void model.setVisible(active && !document.hidden);
async function restartQq() {
  const target = restartTarget.value;
  if (!target || restartingQq.value) return;
  const ok = await confirmDialog({ title: "重启 QQ？", message: "只重启 QQ 服务，约半分钟后会出现新的二维码。", confirmLabel: "重启 QQ" });
  if (!ok) return;
  restartingQq.value = true;
  // Normally the new code ends this; a QQ that does not come back frees the buttons after two minutes.
  setTimeout(() => (restartingQq.value = false), 120_000);
  try {
    await restartInstance(target, "napcat");
    toast("QQ 正在重启");
  } catch {
    toast("没能重启 QQ，请稍后重试。", "danger");
    restartingQq.value = false;
  }
}

async function logout() {
  const ok = await confirmDialog({
    title: "退出当前 QQ 账号？",
    message: "QQ 服务会短暂重启，期间机器人无法收发 QQ 消息，之后需要重新扫码。聊天记录会保留。",
    confirmLabel: "退出 QQ",
    danger: true,
  });
  if (ok) await model.logout();
}
onMounted(() => {
  document.addEventListener("visibilitychange", updateVisibility);
  updateVisibility();
});
onActivated(() => {
  active = true;
  updateVisibility();
});
onDeactivated(() => {
  active = false;
  void model.setVisible(false);
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", updateVisibility);
  model.dispose();
  passwordLogin.dispose();
});
</script>
<style scoped>
/* UI-EXCEPTION qr-media: QR codes retain a white scan background independent of theme; surrounding controls use shadcn. */
@reference "../styles/app.css";

.avatar {
  @apply rounded-full bg-brand-soft text-brand-text font-sans text-lg font-semibold;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.login {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 24px;
  align-items: center;
}
.login-side {
  display: grid;
  gap: 12px;
  justify-items: start;
  min-width: 0;
}
.qr-frame {
  @apply rounded-xl;
  position: relative;
  width: 220px;
  height: 220px;
  padding: 12px;
  background: #fff;
  display: grid;
  place-items: center;
}
/* A dead code fades out under its label, so nobody scans it again. */
.qr-frame.dead .qr-image {
  opacity: 0.1;
  filter: blur(3px);
  transition:
    opacity var(--t-mid) var(--ease-out),
    filter var(--t-mid) var(--ease-out);
}
.qr-dead {
  @apply text-sm font-semibold;
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #374151;
}
.qr-image {
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}
.qr-placeholder {
  @apply text-sm;
  color: #6b7280;
}
@media (max-width: 640px) {
  .login {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
  }
  .login-side {
    justify-items: center;
    width: 100%;
  }
  .qr-frame {
    width: min(232px, 100%);
    height: auto;
    aspect-ratio: 1;
  }
}
</style>

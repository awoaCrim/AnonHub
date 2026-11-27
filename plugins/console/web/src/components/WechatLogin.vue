<template>
  <GroupRow v-if="status && !status.available" title="微信服务" value="暂不可用" tone="danger" :icon="TriangleAlert" />
  <GroupRow v-else-if="status?.loggedIn" title="退出登录" :icon="LogOut" icon-tone="danger">
    <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" :disabled="busy || !writable" @click="logout">
      {{ busy ? "正在退出…" : "退出微信" }}
    </Button>
  </GroupRow>
  <GroupRow v-else title="扫码登录" :detail="problem" :icon="QrCode">
    <Button variant="default" size="sm" :disabled="busy || !writable || !status" @click="start">
      {{ busy ? "正在准备…" : waiting ? "查看二维码" : "登录" }}
    </Button>
  </GroupRow>
  <SettingsSubpage :open="qrOpen" title="扫码登录" dialog-class="sm:max-w-md" @update:open="setQrOpen">
    <div class="login">
      <Alert v-if="error" variant="destructive" as="p" role="alert">{{ error }}</Alert>
      <div class="qr-frame">
        <img v-if="qrImage" class="qr-image" :src="qrImage" alt="微信登录二维码" />
        <div v-else class="qr-placeholder">{{ waiting ? "正在获取二维码…" : "二维码已失效" }}</div>
      </div>
      <p class="state" role="status">{{ stateLabel }}</p>
      <div class="flex flex-wrap justify-center gap-2">
        <Button v-if="!waiting" variant="default" size="sm" :disabled="busy || !writable" @click="start">重新获取</Button>
        <Button v-else variant="outline" size="sm" :disabled="busy || !writable" @click="cancel">取消登录</Button>
      </div>
    </div>
  </SettingsSubpage>
</template>
<script setup lang="ts">
import { Logout as LogOut, Qr as QrCode, Danger as TriangleAlert } from "reicon-vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { WechatLoginStatus, WechatQrCode } from "../../../src/shared/wechat";
import { adminRequest } from "../lib/admin-request";
import { confirmDialog } from "../lib/dialog";
import { toast } from "../lib/toast";
import GroupRow from "./group/GroupRow.vue";
import SettingsSubpage from "./SettingsSubpage.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

defineProps<{ writable: boolean }>();
const emit = defineEmits<{ account: [string | undefined] }>();
const status = ref<WechatLoginStatus>();
const qr = ref<WechatQrCode>();
const busy = ref(false);
const error = ref("");
const qrOpen = ref(false);
const waiting = computed(() => status.value?.login?.state === "awaiting_scan" || status.value?.login?.state === "awaiting_approval");
const qrImage = computed(() => (waiting.value && qr.value && /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(qr.value.image) ? qr.value.image : ""));
const PROBLEMS = { expired: "二维码已过期", rejected: "已在手机上拒绝登录", lan: "微信要求局域网验证，登录未完成", failed: "登录未成功" } as const;
const problem = computed(() => {
  const login = status.value?.login;
  return login?.problem ? PROBLEMS[login.problem] : undefined;
});
const stateLabel = computed(() => {
  const login = status.value?.login;
  if (status.value?.loggedIn) return "已登录";
  if (login?.lan) return "等待局域网验证";
  if (login?.state === "awaiting_approval") return "已扫码，等待手机确认";
  if (login?.state === "awaiting_scan") return "等待扫码";
  if (problem.value) return problem.value;
  return login ? "正在登录…" : "未登录";
});

let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let generation = 0;
function schedule() {
  clearTimeout(timer);
  if (disposed || document.hidden) return;
  const active = qrOpen.value || waiting.value || status.value?.login?.state === "authenticating";
  timer = setTimeout(() => void refresh(), active ? 1500 : 10_000);
}
/** Background reads stay silent: a failed poll keeps what is shown and tries again. */
async function refresh() {
  const token = ++generation;
  try {
    const next = await adminRequest<WechatLoginStatus>("wechat/status", undefined, { fresh: true });
    if (disposed || token !== generation) return;
    status.value = next;
    if (next.loggedIn && qrOpen.value) {
      qrOpen.value = false;
      toast("微信已登录");
    }
    const code = next.login?.qrGeneration;
    if (code !== undefined && code !== qr.value?.generation) {
      const fetched = await adminRequest<WechatQrCode>(`wechat/qrcode?generation=${code}`, undefined, { fresh: true }).catch(() => undefined);
      if (!disposed && token === generation && fetched) qr.value = fetched;
    }
  } catch {
    // Keep the last status on screen.
  } finally {
    if (token === generation) schedule();
  }
}
async function start() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    status.value = await adminRequest<WechatLoginStatus>("wechat/login", {});
    if (!status.value.loggedIn) qrOpen.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    qrOpen.value = true;
  } finally {
    busy.value = false;
  }
  void refresh();
}
async function cancel() {
  busy.value = true;
  try {
    status.value = await adminRequest<WechatLoginStatus>("wechat/login/cancel", {});
    qrOpen.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function logout() {
  const ok = await confirmDialog({
    title: "退出当前微信账号？",
    message: "退出后机器人无法收发微信消息，需要重新扫码登录。聊天记录会保留。",
    confirmLabel: "退出微信",
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  try {
    await adminRequest("wechat/logout", {});
    toast("已退出微信");
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
  void refresh();
}
function setQrOpen(open: boolean) {
  qrOpen.value = open;
  if (open) void refresh();
}
const onVisibility = () => (document.hidden ? clearTimeout(timer) : void refresh());
watch(
  () => status.value?.accountId,
  (account) => emit("account", account),
  { immediate: true },
);
onMounted(() => {
  document.addEventListener("visibilitychange", onVisibility);
  void refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});
</script>
<style scoped>
/* UI-EXCEPTION qr-media: QR codes retain a white scan background independent of theme; surrounding controls use shadcn. */
@reference "../styles/app.css";

.login {
  display: grid;
  gap: 16px;
  justify-items: center;
}
.qr-frame {
  @apply rounded-xl;
  width: min(232px, 100%);
  aspect-ratio: 1;
  padding: 12px;
  background: #fff;
  display: grid;
  place-items: center;
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
.state {
  @apply text-sm text-muted-foreground;
  margin: 0;
}
</style>

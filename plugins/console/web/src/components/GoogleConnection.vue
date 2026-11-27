<template>
  <div class="connections-page stack">
    <Alert v-if="state.error" variant="destructive" role="alert">
      {{ state.error }} <Button variant="outline" size="sm" :disabled="state.loading" @click="control.load">重试</Button>
    </Alert>

    <Card class="service gap-0 overflow-hidden p-0" as-child
      ><section aria-labelledby="google-title">
        <header class="service-head">
          <span class="service-logo" aria-hidden="true">G</span>
          <div class="service-name">
            <h2 id="google-title">Google</h2>
            <p>{{ headline }}</p>
          </div>
          <Badge v-if="status" :variant="status.tone">{{ status.label }}</Badge>
          <Button v-if="ready" class="rounded-full" :disabled="!!state.busy" @click="connect()"><Plus aria-hidden="true" />连接账号</Button>
          <Button v-else-if="owner && snapshot" class="rounded-full" :disabled="!!state.busy" @click="openSetup">设置 Google 应用</Button>
          <Badge v-else-if="snapshot" variant="secondary">暂不可用</Badge>
        </header>

        <LoadingRows v-if="state.loading && !snapshot" :count="1" label="正在读取连接" class="px-3 pb-3" />

        <div v-if="snapshot?.accounts.length" class="accounts arrive-list">
          <article v-for="account in snapshot.accounts" :key="account.id" class="account" :class="{ broken: account.needsReconnect }">
            <span class="avatar" aria-hidden="true">{{ initial(account) }}</span>
            <div class="min-w-0">
              <strong class="account-email">{{ account.email }}</strong>
              <p class="account-meta">
                <template v-if="account.name">{{ account.name }} · </template>{{ since(account.connectedAt) }}连接<template v-if="account.needsReconnect">
                  · <span class="expired">授权已失效</span></template
                >
              </p>
              <ul class="grants" :aria-label="`${account.email} 的权限`">
                <li v-for="service in services" :key="service.id" :class="grantClass(account.permissions[service.id])">
                  {{ service.short }}<span v-if="account.permissions[service.id]">{{ account.permissions[service.id] === "manage" ? "可管理" : "只读" }}</span>
                  <span v-else class="sr-only">未授权</span>
                </li>
              </ul>
            </div>
            <div class="account-actions">
              <Button v-if="account.needsReconnect" size="sm" class="rounded-full" :disabled="!!state.busy" @click="connect(account)">重新连接</Button>
              <Button size="sm" variant="ghost" class="rounded-full text-muted-foreground" :disabled="!!state.busy" @click="disconnect(account)">断开</Button>
            </div>
          </article>
        </div>

        <!-- A quiet line under the accounts, not a tinted band (user, 2026-11-20: 「太丑了」). -->
        <footer v-if="ready" class="service-note">
          <p>
            敏感操作，只有管理员能让 bot 使用。断开即撤销授权，也可以在
            <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Google 账号</a> 里撤销。
          </p>
          <!-- The owner's app lives with the accounts it serves; friends borrow it and never see this. -->
          <Button v-if="owner" size="sm" variant="ghost" class="rounded-full text-muted-foreground" :disabled="!!state.busy" @click="openSetup"
            >Google 应用设置</Button
          >
        </footer>
      </section></Card
    >

    <ResponsiveDialog
      v-if="owner"
      :open="setupOpen"
      title="设置 Google 应用"
      description="所有账号共用这一个应用，设置一次就行。"
      wide
      @update:open="setSetupOpen"
    >
      <ol class="setup-steps">
        <li>
          <strong>1. 准备 Google 应用</strong>
          <p>
            在 <a href="https://console.cloud.google.com/apis/dashboard" target="_blank" rel="noopener noreferrer">Google Cloud</a> 启用 Gmail、Calendar、Drive
            三个 API。在 Google Auth Platform 的「品牌 / Branding」中补全应用名称、用户支持邮箱、应用首页和隐私政策网址，并按 Google
            的要求完成网域验证。首页和隐私政策应使用你实际拥有、可以访问的页面。
          </p>
          <p>
            本实例可填写的公开页面：<a href="/about.html" target="_blank" rel="noopener noreferrer">应用首页</a> ·
            <a href="/privacy.html" target="_blank" rel="noopener noreferrer">隐私政策</a> ·
            <a href="/terms.html" target="_blank" rel="noopener noreferrer">服务条款</a>。打开后复制地址，填入 Google 的对应字段；不上传徽标也可以继续配置。
          </p>
        </li>
        <li>
          <strong>2. 设置授权回调</strong>
          <p>
            创建「Web 应用」类型的 OAuth 客户端，把下面的地址填进「已获授权的重定向 URI」。发布状态、测试用户和敏感权限验证需在 Google Cloud
            中分别处理，以控制台显示的要求为准。
          </p>
          <div class="copy-field">
            <code>{{ callback }}</code>
            <Button size="sm" variant="ghost" @click="copyCallback">{{ copied ? "已复制" : "复制" }}</Button>
          </div>
        </li>
        <li>
          <strong>3. 填入客户端信息</strong>
          <label class="field"
            ><span>Client ID</span><Input v-model.trim="app.clientId" autocomplete="off" spellcheck="false" placeholder="xxxxxxxx.apps.googleusercontent.com"
          /></label>
          <label class="field"
            ><span>Client Secret</span
            ><Input
              v-model.trim="app.clientSecret"
              type="password"
              autocomplete="new-password"
              :placeholder="snapshot?.configured ? '已保存，不改就留空' : 'GOCSPX-…'"
          /></label>
          <p class="muted">
            回调地址自动用上面这个，不用再填。改成别的应用后，已连接的账号需要重新连接。这里保存客户端配置，不会替你发布应用或完成 Google 验证。
          </p>
        </li>
      </ol>
      <template #footer>
        <Button variant="outline" :disabled="!!state.busy" @click="setSetupOpen(false)">取消</Button>
        <Button :disabled="!!state.busy || !app.clientId || (!snapshot?.configured && !app.clientSecret)" @click="saveApp">保存，所有账号可用</Button>
      </template>
    </ResponsiveDialog>
  </div>
</template>
<script setup lang="ts">
import { Add as Plus } from "reicon-vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { GOOGLE_CALLBACK_PATH, type GoogleAccountView, type GoogleSelection } from "../../../src/shared/google";
import { useSession } from "../context";
import { confirmDialog } from "../lib/dialog";
import { editorRegistry, trackEditor } from "../lib/editor-guard";
import { toast, toastErrors } from "../lib/toast";
import { createGoogleConnections } from "../state/google-connections";
import LoadingRows from "./LoadingRows.vue";
import ResponsiveDialog from "./ResponsiveDialog.vue";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";

const control = createGoogleConnections(),
  state = control.state;
const session = useSession().state;
const route = useRoute(),
  router = useRouter();
const snapshot = computed(() => state.snapshot);
/** Friends borrow the owner's app: setting it up is the owner's alone. */
const owner = computed(() => !session.features.tenant && !snapshot.value?.shared);
const ready = computed(() => !!snapshot.value?.available && !!snapshot.value.configured);
const headline = computed(() => {
  if (!snapshot.value || ready.value) return "Gmail · 日历 · 网盘";
  return owner.value ? "还没设置 · 所有账号共用一个应用，设置一次就行" : "主人还没设置好 Google，暂时不能连接。";
});
const status = computed(() => {
  const accounts = snapshot.value?.accounts ?? [];
  if (!ready.value || !accounts.length) return undefined;
  const broken = accounts.filter((account) => account.needsReconnect).length;
  return broken
    ? { tone: "warn" as const, label: `${accounts.length} 个账号 · ${broken} 个需要重新连接` }
    : { tone: "ok" as const, label: `已连接 ${accounts.length} 个账号` };
});

const services = [
  { id: "gmail" as const, short: "Gmail" },
  { id: "calendar" as const, short: "日历" },
  { id: "drive" as const, short: "网盘" },
];
const initial = (account: GoogleAccountView) => (account.name || account.email).trim().charAt(0).toUpperCase();
const grantClass = (mode?: "read" | "manage") => (mode === "manage" ? "manage" : mode ? "read" : "none");
function since(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days <= 0 ? "今天" : days === 1 ? "昨天" : days < 30 ? `${days} 天前` : new Date(at).toLocaleDateString("zh-CN");
}

/** Connecting or renewing an account asks Google for everything; what it may do in chats is not set here. */
const FULL: GoogleSelection = { gmail: "manage", calendar: "manage", drive: "manage" };
async function connect(account?: GoogleAccountView) {
  if ((await editorRegistry.leave()) && !disposed) await control.connect(FULL, account?.id);
}

// The owner's app.
const setupOpen = ref(false);
const app = reactive({ clientId: "", clientSecret: "" });
const setupDirty = computed(() => setupOpen.value && (app.clientId !== (snapshot.value?.clientId ?? "") || !!app.clientSecret));
trackEditor(
  () => setupDirty.value,
  () => setupOpen.value && !!state.busy,
);
const callback = computed(() => snapshot.value?.redirectUri ?? new URL(GOOGLE_CALLBACK_PATH, location.origin).href);
function openSetup() {
  app.clientId = snapshot.value?.clientId ?? "";
  app.clientSecret = "";
  setupOpen.value = true;
}
/** Closing the dialog (✕, Esc, 取消) never saves and never asks: what was typed is dropped (user, 2026-11-16). */
function setSetupOpen(open: boolean) {
  if (open) return openSetup();
  if (state.busy) return;
  setupOpen.value = false;
  app.clientId = snapshot.value?.clientId ?? "";
  app.clientSecret = "";
}
async function saveApp() {
  const saved = await control.saveApp({ clientId: app.clientId, ...(app.clientSecret ? { clientSecret: app.clientSecret } : {}), redirectUri: callback.value });
  if (!saved || disposed) return;
  setupOpen.value = false;
  toast("Google 应用已保存，所有账号都能连接了。", "ok");
}
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyCallback() {
  try {
    await navigator.clipboard.writeText(callback.value);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 2000);
  } catch {
    toast("复制失败，请手动选中地址复制。", "danger");
  }
}

async function disconnect(account: GoogleAccountView) {
  if (
    !(await confirmDialog({
      title: "断开 Google 连接？",
      message: `断开 ${account.email} 后，它将无法再访问这个账号。`,
      confirmLabel: "断开连接",
      danger: true,
    })) ||
    disposed
  )
    return;
  const result = await control.disconnect(account.id);
  if (result && !disposed)
    toast(
      result.revoked ? "已断开连接并撤销 Google 授权。" : "本地连接已移除；Google 暂时不可达，请到 Google 账号中撤销授权。",
      result.revoked ? "ok" : "danger",
    );
}

let disposed = false;
toastErrors(
  () => state.error,
  () => {
    state.error = "";
  },
  () => !state.snapshot,
  () => !!state.busy || state.loading,
);
// Coming back to the page (from Google, another tab) shows what changed meanwhile.
const refresh = () => {
  if (document.visibilityState === "visible" && !state.busy) void control.load();
};
onMounted(async () => {
  document.addEventListener("visibilitychange", refresh);
  await control.load();
  if (disposed) return;
  const outcome = route.query.google;
  if (typeof outcome === "string") {
    const messages: Record<string, string> = {
      connected: "Google 账号已连接。",
      denied: "你取消了 Google 授权，可以随时重新连接。",
      expired: "授权已过期，请重新连接。",
      failed: "Google 授权未完成，请查看连接状态后重试。",
      timeout: "Google 授权等待超时，请先查看连接状态；尚未连接时可重新授权。",
      unavailable: "服务器暂时无法连接 Google，请稍后重新授权。",
      app_invalid: "Google 应用凭据无效，请检查 Google 应用设置。",
      permission_denied: "Google 未授予所选服务权限，请重新授权并勾选所需权限。",
    };
    if (messages[outcome]) toast(messages[outcome], outcome === "connected" ? "ok" : "danger");
    const { google: _, ...query } = route.query;
    await router.replace({ query });
  }
});
onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener("visibilitychange", refresh);
  clearTimeout(copiedTimer);
  control.dispose();
});
</script>
<style scoped>
@reference "../styles/app.css";

.connections-page {
  min-width: 0;
  gap: 16px;
}
/* A service: a soft tile for its mark, its name, a status pill and round actions; its accounts are rows like the chat panel's. */
.service-head {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 20px 12px;
  flex-wrap: wrap;
}
.service-logo {
  @apply text-primary;
  width: 40px;
  height: 40px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 12px;
  font:
    700 19px/1 Arial,
    sans-serif;
}
.service-name {
  flex: 1 1 160px;
  min-width: 0;
}
.service-name h2 {
  font-size: 18px;
  font-weight: 600;
}
.service-name p {
  @apply text-sm text-muted-foreground;
}
.accounts {
  display: grid;
  gap: 4px;
  padding: 0 8px 4px;
}
.account {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px 12px;
  border-radius: 14px;
  transition: background-color var(--t-fast) ease;
}
.account:hover {
  background: color-mix(in srgb, var(--text) 3%, transparent);
}
.account.broken {
  @apply bg-warn-soft;
}
.avatar {
  @apply text-muted-foreground font-semibold;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 999px;
}
.account-email {
  display: block;
  font-size: 14px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.account-meta {
  @apply text-xs text-muted-foreground;
  margin-top: 4px;
}
.expired {
  @apply text-warn font-semibold;
}
.grants {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  list-style: none;
  padding: 0;
}
.grants li {
  @apply text-xs;
  display: inline-flex;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.grants li span {
  @apply text-muted-foreground;
}
.grants li.manage span {
  @apply text-brand-text font-medium;
}
.grants li.none {
  @apply text-muted-foreground;
  opacity: 0.6;
  text-decoration: line-through;
}
.account-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.service-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 8px 20px 20px;
}
.service-note p {
  @apply text-xs text-muted-foreground;
  flex: 1 1 auto;
  min-width: 0;
  line-height: 1.6;
}
.service-note a {
  @apply text-brand-text font-medium;
}
.service-note :deep(button) {
  flex: none;
}
.setup-steps {
  display: grid;
  gap: 20px;
  padding-left: 0;
}
.setup-steps li {
  display: grid;
  gap: 8px;
}
.setup-steps p {
  @apply text-sm text-subtle;
}
.setup-steps a {
  @apply text-brand-text;
}
.copy-field {
  @apply border border-border rounded-md bg-muted;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 4px 4px 12px;
  min-width: 0;
}
.copy-field code {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  font: 12px var(--mono);
}
.field {
  @apply text-sm;
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
}
@media (max-width: 640px) {
  .accounts {
    padding-inline: 4px;
  }
  .account {
    grid-template-columns: 40px minmax(0, 1fr);
  }
  .account-actions {
    grid-column: 2;
  }
  .service-head,
  .service-note {
    padding-inline: 16px;
  }
  .service-note {
    flex-direction: column;
    align-items: flex-start;
  }
  .field {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>

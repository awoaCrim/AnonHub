<template>
  <Card class="service gap-0 overflow-hidden p-0" as-child
    ><section aria-labelledby="xiaoheihe-title">
      <header class="service-head">
        <span class="service-logo" aria-hidden="true">黑</span>
        <div class="service-name">
          <h2 id="xiaoheihe-title">小黑盒</h2>
          <p>{{ headline }}</p>
        </div>
        <Badge v-if="status" :variant="status.tone">{{ status.label }}</Badge>
        <!-- Signing in again is a rare repair once connected, so it only stands out when a login is needed. -->
        <Button
          v-if="connection?.available"
          class="rounded-full"
          :variant="connection.state === 'connected' ? 'outline' : 'default'"
          :disabled="state.busy || pending"
          @click="control.login"
        >
          {{ pending ? "等待扫码确认" : connection.state === "connected" ? "重新登录" : "扫码登录" }}
        </Button>
      </header>

      <LoadingRows v-if="!connection && state.loading" :count="1" label="正在读取小黑盒状态" class="px-3 pb-3" />
      <Alert v-if="state.error" variant="destructive" as="p" role="alert" class="mx-5 mb-4 w-auto">{{ state.error }}</Alert>

      <div v-if="connection && !connection.available" class="body">
        <p class="muted">小黑盒扩展没有运行。到<RouterLink :to="extensionLink">能力</RouterLink>启用它，并在设置里填好小黑盒账号 ID。</p>
      </div>
      <div v-else-if="connection" class="body">
        <dl class="facts">
          <div>
            <dt>账号</dt>
            <dd class="font-mono">{{ connection.selfId }}</dd>
          </div>
          <div>
            <dt>今天还能发帖</dt>
            <dd>{{ connection.postsRemaining }} 篇</dd>
          </div>
          <div>
            <dt>今天还能评论和回复</dt>
            <dd>{{ connection.interactionsRemaining }} 条</dd>
          </div>
        </dl>
        <Alert v-if="connection.newPostQuarantined || connection.quarantinedPosts" variant="warn" as="p">
          <CircleAlert aria-hidden="true" />有发布结果不确定的帖子或评论，已隔离，不会自动重发；请到小黑盒里确认。
        </Alert>
        <figure v-if="connection.login.image" class="qr">
          <img :src="connection.login.image" alt="小黑盒登录二维码" width="240" height="240" />
          <figcaption>用小黑盒 App 扫码并确认，账号必须是 {{ connection.selfId }}。二维码 3 分钟内有效。</figcaption>
        </figure>
        <p v-if="connection.login.message" role="status" class="text-sm">{{ connection.login.message }}</p>
      </div>

      <p class="service-note">读帖、搜索和逛社区在所有会话里可用；发帖和评论属于敏感操作，只有管理员能让它做，且按明确要求进行。</p>
    </section></Card
  >
</template>
<script setup lang="ts">
import { InfoCircle as CircleAlert } from "reicon-vue";
import { computed, onBeforeUnmount, onMounted } from "vue";
import { RouterLink } from "vue-router";

import { settingsPages } from "../nav";
import { createXiaoheiheConnection } from "../state/xiaoheihe-connection";
import LoadingRows from "./LoadingRows.vue";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/** 能力 · 小黑盒: the configured account, whether it is logged in, and the QR login (owner only). */
const control = createXiaoheiheConnection(),
  state = control.state;
const connection = computed(() => state.connection);
const pending = computed(() => !!connection.value?.available && connection.value.login.state === "pending");
const extensionLink = { path: settingsPages.extensions.path, query: { section: "yesimbot-xiaoheihe" } };
const headline = computed(() => {
  const value = connection.value;
  if (!value?.available) return "帖子、评论与社区";
  return value.state === "login_required" ? "需要扫码登录，登录后才能读帖和发帖" : "帖子、评论与社区";
});
const status = computed(() => {
  const value = connection.value;
  if (!value) return undefined;
  if (!value.available) return { tone: "secondary" as const, label: "未启用" };
  if (value.state === "connected") return { tone: "ok" as const, label: "已登录" };
  if (value.state === "login_required") return { tone: "warn" as const, label: "需要登录" };
  if (value.state === "connecting") return { tone: "secondary" as const, label: "连接中" };
  return { tone: "danger" as const, label: "连接失败" };
});
const refresh = () => {
  if (document.visibilityState === "visible" && !state.busy) void control.load();
};
onMounted(() => {
  document.addEventListener("visibilitychange", refresh);
  void control.load();
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", refresh);
  control.dispose();
});
</script>
<style scoped>
@reference "../styles/app.css";

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
  font-weight: 700;
  font-size: 18px;
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
.body {
  display: grid;
  gap: 12px;
  padding: 0 20px 4px;
}
.body a {
  @apply text-brand-text font-semibold;
}
/* Today's budget as three soft tiles. */
.facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}
.facts div {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 12px 16px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
.facts dt {
  @apply text-xs text-muted-foreground;
}
.facts dd {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.qr {
  display: grid;
  gap: 8px;
  justify-items: start;
}
.qr img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 12px;
}
.qr figcaption {
  @apply text-sm text-muted-foreground;
}
.service-note {
  @apply text-xs text-muted-foreground;
  padding: 12px 20px 20px;
  line-height: 1.6;
}
@media (max-width: 640px) {
  .service-head,
  .body,
  .service-note {
    padding-inline: 16px;
  }
  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .facts div:first-child {
    grid-column: 1 / -1;
  }
}
</style>

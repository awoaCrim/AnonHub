<template>
  <!-- One column, labels over full-width fields, the links at the foot (user, 2026-11-27: 「登录页面有点丑，优化一下」). -->
  <main class="login">
    <form class="sheet" @submit.prevent="submit">
      <span class="mark" aria-hidden="true"><BrandMark class="block size-full" /></span>
      <h1>登录 AnonHub</h1>
      <label class="field">
        <span>用户名</span>
        <Input v-model.trim="username" :class="input" autocomplete="username" maxlength="32" :disabled="busy" />
      </label>
      <label class="field">
        <span>密码</span>
        <Input v-model="password" :class="input" type="password" autocomplete="current-password" required maxlength="4096" :disabled="busy" />
      </label>
      <Alert v-if="error" variant="destructive" as="p" role="alert">{{ error }}</Alert>
      <Button variant="default" size="lg" class="submit" :disabled="busy || !password">{{ busy ? "正在登录…" : "登录" }}</Button>
    </form>
    <nav class="legal" aria-label="应用与政策"><a href="/about.html">应用介绍</a><a href="/privacy.html">隐私政策</a><a href="/terms.html">服务条款</a></nav>
  </main>
</template>
<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { Alert } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useLive, useSession } from "../context";
import { ApiError } from "../lib/api";
import { safeReturnPath } from "../lib/session";
import BrandMark from "../shell/BrandMark.vue";

const session = useSession();
const live = useLive();
const route = useRoute();
const router = useRouter();
const input = "h-12 rounded-xl border-transparent bg-group-tile px-4 text-base shadow-none dark:bg-group-tile";
const username = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");

async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await session.login(username.value, password.value);
    live.reset();
    await router.replace(safeReturnPath(route.query.returnTo));
  } catch (cause) {
    error.value = loginError(cause);
  } finally {
    password.value = "";
    busy.value = false;
  }
}

function loginError(cause: unknown): string {
  if (!(cause instanceof ApiError)) return "无法连接服务器，请检查网络后重试。";
  if (cause.status === 401) return "用户名或密码错误。";
  if (cause.status === 403) return "当前访问地址未被允许，请使用配置的地址打开。";
  if (cause.status === 429) return `尝试次数过多，请 ${cause.retryAfter ?? 60} 秒后再试。`;
  return "登录暂时不可用，请稍后重试。";
}
</script>
<style scoped>
.login {
  display: grid;
  grid-template-rows: 1fr auto;
  min-height: 100dvh;
  padding: 24px 16px max(24px, env(safe-area-inset-bottom));
  background: var(--bg);
}
/* A little above the middle, where the eye lands first. */
.sheet {
  display: grid;
  gap: 20px;
  align-self: center;
  justify-self: center;
  width: min(100%, 360px);
  margin-bottom: 8vh;
}
.mark {
  justify-self: center;
  width: 64px;
  height: 64px;
  overflow: hidden;
  border-radius: 16px;
}
h1 {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  margin: 0 0 16px;
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
  line-height: 28px;
}
.field {
  display: grid;
  gap: 8px;
}
.field > span {
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}
.submit {
  height: 48px;
  margin-top: 8px;
  border-radius: 999px;
  font-size: 16px;
}
/* Until there is something to send it stays a quiet grey, not a dimmed black block. */
.submit:disabled {
  opacity: 1;
  background: var(--group-tile);
  color: var(--text-3);
}
.legal {
  display: flex;
  justify-content: center;
  gap: 24px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 16px;
}
.legal a {
  color: inherit;
}
.legal a:hover {
  color: var(--text);
}
</style>

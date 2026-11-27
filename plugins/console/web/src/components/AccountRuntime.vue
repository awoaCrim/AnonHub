<template>
  <div class="grid min-w-0 gap-7">
    <SettingsGroup label="账号">
      <GroupRow :title="adminSession.username || '新用户'" :icon="User">
        <Button variant="ghost" size="sm" class="rounded-full" :disabled="state.submitting || loggingOut" @click="signOut">{{
          loggingOut ? "正在退出…" : "退出登录"
        }}</Button>
      </GroupRow>
    </SettingsGroup>
    <Alert v-if="state.error || state.refreshError" role="alert" variant="destructive" as="p">{{ state.error || state.refreshError }}</Alert>
    <form class="grid min-w-0 gap-7" @submit.prevent="!loggingOut && view.start()">
      <SettingsGroup title="我的 bot">
        <GroupRow
          title="运行状态"
          :icon="Bot"
          :value="state.runtime ? runtimeLabels[state.runtime.state] : '正在读取'"
          :tone="state.runtime?.state === 'running' ? 'ok' : state.runtime?.state === 'error' ? 'danger' : 'warn'"
        />
        <template v-if="state.runtime && state.runtime.state !== 'running' && !['starting', 'stopping'].includes(state.runtime.state)">
          <GroupRow v-if="!state.runtime.qqAccount" title="QQ 号码" detail="选填" :icon="MessageCircle">
            <Input
              v-model="state.qqAccount"
              class="w-48 max-w-full rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile"
              aria-label="QQ 号码"
              inputmode="numeric"
              pattern="[1-9][0-9]{4,11}"
              :disabled="state.submitting || loggingOut"
            />
          </GroupRow>
          <GroupRow v-else title="QQ 号码" :value="state.runtime.qqAccount" :icon="MessageCircle" />
        </template>
      </SettingsGroup>
      <div class="flex flex-wrap justify-end gap-2">
        <Button
          v-if="!state.runtime || state.error || state.refreshError"
          type="button"
          variant="outline"
          class="rounded-full"
          :disabled="state.loading || state.submitting || loggingOut"
          @click="view.refresh"
        >
          刷新状态
        </Button>
        <Button v-if="state.runtime?.state === 'running'" type="button" variant="default" class="rounded-full" @click="enter">继续</Button>
        <Button
          v-else-if="state.runtime && !['starting', 'stopping'].includes(state.runtime.state)"
          variant="default"
          class="rounded-full"
          :disabled="state.submitting || loggingOut"
        >
          {{ state.submitting ? "正在提交…" : state.runtime.state === "setup-required" ? "开始设置" : "重新启动" }}
        </Button>
      </div>
    </form>
  </div>
</template>
<script setup lang="ts">
import { Ghost as Bot, ChatRound as MessageCircle, User } from "reicon-vue";
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import { useLive, useSession } from "../context";
import { createRuntimeState, runtimeLabels } from "../state/accounts-state";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const session = useSession();
const adminSession = session.state;
const live = useLive();
const router = useRouter();
const view = createRuntimeState();
const { state } = view;
const loggingOut = ref(false);
let active = false;
let pollRevision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function stop() {
  ++pollRevision;
  if (timer) clearTimeout(timer);
  timer = undefined;
}

async function poll() {
  stop();
  if (!active || document.hidden) return;
  const current = pollRevision;
  await view.refresh();
  if (current === pollRevision && active && !document.hidden) timer = setTimeout(poll, 3000);
}

function visibility() {
  stop();
  if (active && !document.hidden) void poll();
}

function activate() {
  if (active) return;
  active = true;
  void poll();
}
onMounted(() => {
  document.addEventListener("visibilitychange", visibility);
  activate();
});
onActivated(activate);
onDeactivated(() => {
  active = false;
  stop();
});
onBeforeUnmount(() => {
  active = false;
  stop();
  document.removeEventListener("visibilitychange", visibility);
  view.dispose();
});
function enter() {
  // The runtime is ready: relayed requests now reach the member's own bot. No reload needed.
  void session.refresh().then(() => {
    live.reset();
    // The wizard picks the next step from the now-running runtime.
    return router.replace({ name: "setup" });
  });
}

async function signOut() {
  if (state.submitting || loggingOut.value) return;
  loggingOut.value = true;
  try {
    await session.logout();
    live.reset();
    await router.replace({ name: "login" });
  } catch (cause) {
    state.error = cause instanceof Error ? cause.message : "退出失败，请重试。";
  } finally {
    loggingOut.value = false;
  }
}
</script>

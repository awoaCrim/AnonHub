<template>
  <main class="grid min-h-dvh justify-items-center bg-background px-4 py-10">
    <section class="grid w-full max-w-[640px] min-w-0 content-start gap-7">
      <header class="flex flex-wrap items-center gap-4 px-1">
        <span class="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl" aria-hidden="true"><BrandMark class="size-full" /></span>
        <h1 class="grow text-2xl font-semibold">设置机器人</h1>
        <RouterLink v-if="leavable" :class="[buttonVariants({ variant: 'ghost', size: 'sm' }), 'rounded-full']" to="/">稍后再说</RouterLink>
      </header>

      <SettingsGroup title="步骤">
        <GroupRow
          v-for="(step, index) in steps"
          :key="step.id"
          :title="step.title"
          :value="step.done ? '已完成' : step.id === current?.id ? '进行中' : !step.required ? '可稍后' : '待完成'"
          :tone="step.done ? 'ok' : undefined"
          :clickable="reachable(index) && step.id !== current?.id"
          :selected="step.id === current?.id"
          :aria-current="step.id === current?.id ? 'step' : undefined"
          @open="go(step.id)"
        >
          <template #icon
            ><span class="step-no">{{ step.done ? "✓" : index + 1 }}</span></template
          >
        </GroupRow>
      </SettingsGroup>

      <div v-if="finished" class="grid justify-items-center gap-4 py-8 text-center">
        <span class="text-3xl text-primary" aria-hidden="true">✓</span>
        <h2 class="text-xl font-semibold">设置完成</h2>
        <RouterLink :class="[buttonVariants({ variant: 'default' }), 'rounded-full']" to="/">开始对话</RouterLink>
      </div>
      <section v-else-if="current" class="grid min-w-0 gap-7" :aria-label="current.title">
        <!-- The start step brings its own status group. -->
        <div v-if="current.id !== 'runtime'" class="flex justify-end empty:hidden">
          <div id="page-actions" class="page-actions"></div>
        </div>
        <TopicFeedback v-if="current.id !== 'runtime' && runtimeReady" :state="panel" label="机器人状态" />
        <AccountRuntime v-if="current.id === 'runtime'" />
        <ModelQuickSetup v-else-if="current.id === 'model'" />
      </section>

      <SettingsGroup v-if="runtimeReady" title="其他设置">
        <GroupRow title="平台账号" :icon="Plug" to="/settings/platforms" />
        <GroupRow title="角色" :icon="Theater" to="/?panel=files&document=role" />
        <GroupRow title="对话" :icon="MessageSquare" to="/settings/reply" />
      </SettingsGroup>

      <footer v-if="current && !finished" class="flex flex-wrap items-center justify-between gap-3">
        <Button v-if="previous" type="button" variant="ghost" class="rounded-full" @click="go(previous.id)">上一步</Button>
        <span v-else></span>
        <Button
          type="button"
          class="rounded-full"
          :variant="current.done ? 'default' : 'outline'"
          :disabled="current.required && !current.done"
          @click="advance"
        >
          {{ next ? "下一步" : current.done ? "开始对话" : "稍后连接模型" }}
        </Button>
      </footer>
    </section>
  </main>
</template>
<script setup lang="ts">
import { Message as MessageSquare, Plug, Masks as Theater } from "reicon-vue";
import { computed, watch } from "vue";
import { useRouter } from "vue-router";

import type { PanelPayload } from "../../../src/shared/panel";
import AccountRuntime from "../components/AccountRuntime.vue";
import GroupRow from "../components/group/GroupRow.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import ModelQuickSetup from "../components/ModelQuickSetup.vue";
import { Button, buttonVariants } from "../components/ui/button";
import { useSession } from "../context";
import { useRouteState } from "../lib/route-state";
import { useTopic } from "../lib/use-topic";
import BrandMark from "../shell/BrandMark.vue";
import TopicFeedback from "../shell/TopicFeedback.vue";
import { optionalSetupLink, setupSteps } from "./setup-model";

const session = useSession();
const router = useRouter();
// Before a member's runtime runs, every data request would fail; only the start step is live.
const runtimeReady = computed(() => !(session.state.role === "member" && session.state.memberRuntime === "unavailable"));
const panel = useTopic<PanelPayload | null>("panel", () => runtimeReady.value);
const steps = computed(() => setupSteps(session.state, panel.data ?? undefined));
const requested = useRouteState("step", "");

// Old optional-step bookmarks still open their real editor once this runtime is available.
watch(
  [requested, runtimeReady],
  ([step, ready]) => {
    const target = ready ? optionalSetupLink(step) : undefined;
    if (target) void router.replace(target);
  },
  { immediate: true },
);

/** Steps after an unfinished required step stay locked. */
const firstBlocked = computed(() => {
  const index = steps.value.findIndex((step) => step.required && !step.done);
  return index < 0 ? steps.value.length : index;
});
const reachable = (index: number) => index <= firstBlocked.value;
const current = computed(() => {
  const index = steps.value.findIndex((step) => step.id === requested.value);
  if (index >= 0 && reachable(index)) return steps.value[index];
  return steps.value.find((step) => !step.done) ?? steps.value.at(-1);
});
const position = computed(() => steps.value.findIndex((step) => step.id === current.value?.id));
const previous = computed(() => (position.value > 0 ? steps.value[position.value - 1] : undefined));
const next = computed(() => steps.value[position.value + 1]);
const finished = computed(() => requested.value === "done" && steps.value.every((step) => step.done));
// The router already keeps members without a running bot here; everyone else may leave at any time.
const leavable = runtimeReady;

// Stay on a step once shown, so finishing it shows its result instead of jumping ahead.
watch(
  () => current.value?.id,
  (id) => {
    if (id && !requested.value) requested.value = id;
  },
  { immediate: true },
);
// Embedded pages keep their own query fields (plugin, connection, …); a new step starts clean.
function go(id: string) {
  void router.replace({ name: "setup", query: { step: id } });
}
function advance() {
  if (next.value) go(next.value.id);
  else if (steps.value.every((step) => step.done)) go("done");
  else void router.push("/");
}
</script>
<style scoped>
.step-no {
  font-size: 18px;
  font-weight: 600;
}
</style>

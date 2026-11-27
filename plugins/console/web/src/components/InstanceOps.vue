<template>
  <div class="grid min-w-0 gap-7">
    <SettingsGroup title="运行" label="运行">
      <template #actions>
        <Button variant="outline" size="sm" class="rounded-full" :disabled="!!pending || !ops || ops.container.running === false" @click="ask('koishi')">
          {{ pending === "koishi" ? "重启中…" : "重启 bot" }}
        </Button>
        <Button variant="outline" size="sm" class="rounded-full" :disabled="!!pending || !ops || ops.container.running === false" @click="ask('napcat')">
          {{ pending === "napcat" ? "重启中…" : "重启 QQ" }}
        </Button>
      </template>
      <GroupRow v-if="!ops" title="运行状态" detail="暂时读不到运行状态，稍后自动重试。" :icon="Activity" icon-tone="warn" />
      <GroupRow v-else-if="!ops.container.running" title="容器" value="容器没在运行" tone="danger" :icon="Server" icon-tone="danger" />
      <template v-else>
        <GroupRow
          title="bot"
          :detail="uptimeText(ops.programs.koishi)"
          :value="stateLabel(ops.programs.koishi)"
          :tone="toneOf(ops.programs.koishi)"
          :icon="Bot"
        />
        <GroupRow
          title="QQ 进程"
          :detail="uptimeText(ops.programs.napcat)"
          :value="stateLabel(ops.programs.napcat)"
          :tone="toneOf(ops.programs.napcat)"
          :icon="MessageCircle"
        />
        <GroupRow v-if="ops.memory" title="内存" :value="`${formatBytes(ops.memory.usedBytes)} / ${formatBytes(ops.memory.limitBytes)}`" :icon="MemoryStick">
          <template #below><Progress class="memory-bar" :model-value="memoryPercent" :aria-label="`内存已用 ${memoryPercent}%`" /></template>
        </GroupRow>
        <GroupRow v-if="version" title="版本" :icon="GitCommitHorizontal">
          <template #detail
            ><span class="font-mono" :title="ops.release?.deployedAt ? `上线于 ${formatTime(ops.release.deployedAt)}` : undefined">{{
              version
            }}</span></template
          >
        </GroupRow>
      </template>
    </SettingsGroup>

    <QQAccount v-if="!quietQq" :base="base" />
  </div>
</template>

<script setup lang="ts">
import { Pulse as Activity, Ghost as Bot, Nodes as GitCommitHorizontal, Ram as MemoryStick, ChatRound as MessageCircle, Server } from "reicon-vue";
import { computed, ref } from "vue";

import type { OpsInstance, OpsProgram, OpsProgramName } from "../../../src/shared/accounts";
import { confirmDialog } from "../lib/dialog";
import { formatBytes, formatTime } from "../lib/format";
import { formatUptime } from "../pages/overview-model";
import { programLabels, programTone, shortCommit } from "../state/instance-ops";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import QQAccount from "./QQAccount.vue";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";

/**
 * One instance's running state and the two things an owner does about it: restart the bot, restart QQ.
 * The QQ groups below are that instance's own login, scanned or re-scanned from here.
 */
const props = defineProps<{
  /** What the host manager reports; absent while it cannot be read. */
  ops?: OpsInstance;
  /** The NapCat API under `/yesimbot/` for this instance's QQ. */
  base: string;
  /** Does the restart and resolves when it is done; failures are shown by the caller. */
  restart: (program: OpsProgramName) => Promise<void>;
  /** Hides the QQ card, e.g. while this page's own bot is restarting and every call would fail. */
  quietQq?: boolean;
  /** The owner restarts their own bot, which also drops this page. */
  own?: boolean;
}>();
const pending = ref<OpsProgramName | "">("");
const stateLabel = (program?: OpsProgram) => (program ? programLabels[program.state] : "未知");
const uptimeText = (program?: OpsProgram) =>
  program?.state === "RUNNING" && program.uptimeSeconds !== undefined ? `已运行 ${formatUptime(program.uptimeSeconds)}` : "";
const toneOf = (program?: OpsProgram) => programTone(program) || "idle";
const memoryPercent = computed(() => {
  const memory = props.ops?.memory;
  return memory?.limitBytes ? Math.min(100, Math.round((memory.usedBytes / memory.limitBytes) * 100)) : 0;
});
const version = computed(() => shortCommit(props.ops));

async function ask(program: OpsProgramName) {
  if (pending.value) return;
  const ok = await confirmDialog(
    program === "koishi"
      ? {
          title: "重启 bot？",
          message: `正在进行的对话会中断，约半分钟恢复。${props.own ? "你正在用的这个控制台也会断开片刻，恢复后自动重连。" : ""}`,
          confirmLabel: "重启 bot",
          danger: true,
        }
      : { title: "重启 QQ？", message: "QQ 会掉线片刻，通常自动登回；登不回时需要重新扫码。", confirmLabel: "重启 QQ", danger: true },
  );
  if (!ok) return;
  pending.value = program;
  try {
    await props.restart(program);
  } finally {
    pending.value = "";
  }
}
</script>

<style scoped>
@reference "../styles/app.css";

.memory-bar {
  width: 100%;
}
</style>

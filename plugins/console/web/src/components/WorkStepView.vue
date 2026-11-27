<template>
  <article class="step" :class="step.status">
    <header class="step-head">
      <p class="step-kicker">
        <span class="step-icon" aria-hidden="true"
          ><LoaderCircle v-if="step.status === 'running'" class="size-4 animate-spin" /><component :is="stepIcon(step.tool)" v-else class="size-4"
        /></span>
        <span class="step-tool">{{ view.label }}</span>
        <span>第 {{ index + 1 }} 步</span>
        <span class="step-status">{{ STEP_STATUS[step.status] }}</span>
        <time v-if="step.at" class="step-time">{{ formatTime(step.at, "clock") }}</time>
      </p>
      <h3 class="step-summary" :class="{ mono: !!view.command }">{{ view.summary || view.label }}</h3>
      <p v-if="view.meta.length" class="step-facts">{{ view.meta.join(" · ") }}</p>
    </header>
    <section v-if="view.command && view.command.trim() !== view.summary" class="step-block">
      <h4>命令</h4>
      <pre class="step-code"><span class="select-none text-muted-foreground" aria-hidden="true">$ </span>{{ view.command }}</pre>
    </section>
    <section v-if="view.input" class="step-block">
      <h4>参数</h4>
      <pre class="step-code">{{ view.input }}</pre>
    </section>
    <section v-for="block in view.outputs" :key="block.label" class="step-block">
      <h4>{{ block.label }}</h4>
      <pre class="step-code" :class="{ error: block.error }">{{ block.text }}</pre>
    </section>
    <p v-if="step.status === 'running'" class="step-note">还在执行，结束后显示输出。</p>
  </article>
</template>
<script setup lang="ts">
import { Loader as LoaderCircle } from "reicon-vue";
import { computed } from "vue";

import type { WorkStep } from "../../../src/shared/work";
import { formatTime } from "../lib/format";
import { describeStep, STEP_STATUS, stepIcon } from "../lib/work-steps";

/**
 * One tool call of the bot's work, opened from its tab: what the call did on top, then its full command or input and
 * its output (user, 2026-11-26: 「做成左tab的形式，右边顶部需要标注本次工具的摘要」).
 */
const props = defineProps<{ step: WorkStep; index: number }>();
const view = computed(() => describeStep(props.step));
</script>
<style scoped>
@reference "../styles/app.css";

.step {
  display: grid;
  gap: 20px;
  min-width: 0;
}
.step-head {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.step-kicker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  color: var(--text-3);
  font-size: 14px;
}
.step-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 999px;
  background: var(--group);
  color: var(--text-2);
}
.running .step-icon {
  @apply text-primary;
}
.step-tool {
  color: var(--text);
  font-weight: 600;
}
.failed .step-status {
  color: var(--danger);
}
.step-time {
  font-variant-numeric: tabular-nums;
}
.step-summary {
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.step-summary.mono {
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 500;
}
.step-facts {
  color: var(--text-2);
  font-size: 14px;
  overflow-wrap: anywhere;
}
.step-block {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.step-block h4 {
  color: var(--text-3);
  font-size: 14px;
  font-weight: 500;
}
.step-code {
  margin: 0;
  padding: 12px 12px;
  border-radius: 12px;
  background: var(--group);
  color: var(--text);
  font-family: var(--mono);
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.step-code.error {
  color: var(--danger);
}
.step-note {
  color: var(--text-3);
  font-size: 14px;
}
</style>

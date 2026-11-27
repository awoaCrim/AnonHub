<template>
  <figure class="chart">
    <!-- The scale is read off labelled gridlines, not a sentence above the chart. -->
    <div class="plot">
      <span v-for="tick in ticks" :key="tick.value" class="tick" :style="{ top: `${(tick.y / height) * 100}%` }" aria-hidden="true">{{
        format(tick.value)
      }}</span>
      <svg :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="label" preserveAspectRatio="none">
        <line v-for="tick in ticks" :key="tick.value" class="grid" x1="0" :x2="width" :y1="tick.y" :y2="tick.y" />
        <g v-for="(bar, index) in bars" :key="index">
          <rect
            v-for="segment in bar.segments"
            :key="segment.series"
            :x="bar.x"
            :y="segment.y"
            :width="bar.width"
            :height="segment.height"
            :class="`s${segment.series}`"
            rx="2"
          >
            <title>{{ bar.title }}</title>
          </rect>
        </g>
      </svg>
    </div>
    <figcaption>
      <span class="axis">
        <span>{{ labels[0] }}</span>
        <span>{{ labels[labels.length - 1] }}</span>
      </span>
      <span class="legend">
        <span v-for="(name, index) in series" :key="name"><i :class="`s${index}`" />{{ name }}</span>
      </span>
    </figcaption>
    <div class="chart-data"><Button type="button" variant="ghost" size="sm" @click="dataOpen = true">查看图表数据</Button></div>
    <Dialog v-model:open="dataOpen">
      <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader class="pr-6"
          ><DialogTitle>图表数据</DialogTitle><DialogDescription>{{ label }}</DialogDescription></DialogHeader
        >
        <div class="chart-table-wrap">
          <Table>
            <TableCaption>
              {{ label }}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">时间</TableHead>
                <TableHead v-for="name in series" :key="name" scope="col">{{ name }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="(stack, index) in values" :key="index">
                <TableHead scope="row">{{ labels[index] }}</TableHead>
                <TableCell v-for="(value, part) in stack" :key="part">{{ value.toLocaleString("zh-CN") }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  </figure>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";

import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Table, TableCaption, TableHeader, TableRow, TableHead, TableBody, TableCell } from "../components/ui/table";

const props = defineProps<{ label: string; labels: string[]; series: string[]; values: number[][]; format: (value: number) => string }>();
const dataOpen = ref(false);
const width = 600;
const height = 180;
const peak = computed(() => Math.max(1, ...props.values.map((stack) => stack.reduce((sum, value) => sum + value, 0))));
/** The top of the scale: the peak rounded up to 1, 2, 2.5 or 5 × 10ⁿ, so the four gridlines read as round numbers. */
const max = computed(() => {
  const step = 10 ** Math.floor(Math.log10(peak.value));
  return ([1, 2, 2.5, 5, 10].find((factor) => factor * step >= peak.value) ?? 10) * step;
});
const ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({ value: ratio * max.value, y: height - ratio * height })));
const bars = computed(() => {
  const slot = width / Math.max(1, props.values.length);
  return props.values.map((stack, index) => {
    let top = height;
    const segments = stack.map((value, series) => {
      const segmentHeight = (value / max.value) * height;
      top -= segmentHeight;
      return { series, y: top, height: segmentHeight };
    });
    const total = stack.reduce((sum, value) => sum + value, 0);
    return {
      x: index * slot + slot * 0.15,
      width: slot * 0.7,
      segments,
      title: `${props.labels[index]}：${props.format(total)}${stack.length > 1 ? `（${stack.map((value, series) => `${props.series[series]} ${props.format(value)}`).join("，")}）` : ""}`,
    };
  });
});
</script>
<style scoped>
/* UI-EXCEPTION chart-geometry: bar heights, stacked series and labels represent data; shadcn has no replacement for this chart renderer. Colours use the shared theme. */
@reference "../styles/app.css";

.chart {
  margin: 0;
}
.plot {
  position: relative;
  padding-left: 52px;
}
.tick {
  @apply text-muted-foreground text-xs;
  position: absolute;
  left: 0;
  width: 44px;
  transform: translateY(-50%);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
svg {
  width: 100%;
  height: 220px;
  display: block;
  overflow: visible;
}
.grid {
  stroke: var(--line);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.s0 {
  @apply bg-primary;
  fill: var(--accent);
}
.s1 {
  fill: color-mix(in srgb, var(--accent) 35%, var(--surface));
  @apply bg-muted;
}
.s2 {
  fill: #f59e0b;
  @apply bg-warn;
}
figcaption {
  @apply text-xs text-muted-foreground;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  padding-left: 52px;
  flex-wrap: wrap;
}
.axis {
  display: flex;
  justify-content: space-between;
  flex: 1;
  min-width: 160px;
}
.legend {
  display: flex;
  gap: 12px;
}
.legend i {
  @apply rounded-md;
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  vertical-align: -1px;
}
.chart-data {
  @apply text-xs;
  margin-top: 12px;
}
[data-slot="collapsible-trigger"] {
  @apply text-brand-text;
  cursor: pointer;
  padding: 8px 0;
}
.chart-table-wrap {
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
caption {
  text-align: left;
  margin: 8px 0;
}
th,
td {
  @apply border-b border-border;
  text-align: left;
  padding: 8px;
}
.legend {
  flex-wrap: wrap;
}
</style>

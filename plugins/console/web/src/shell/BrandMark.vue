<template>
  <svg viewBox="210 210 605 605" aria-hidden="true">
    <defs>
      <clipPath :id="id('a')">
        <path :d="A" />
      </clipPath>
    </defs>
    <rect class="tile" x="210" y="210" width="605" height="605" />
    <path class="orbit" d="M568.7 415.5A160 45 -28 0 1 701.3 394.9" />
    <path class="glyph" :d="A" />
    <!-- Where the orbit crosses in front of the A, a band of the tile parts them. -->
    <g :clip-path="url('a')">
      <path class="orbit gap" :d="FRONT" />
      <circle class="tile" cx="412" cy="562" r="54" />
    </g>
    <path class="orbit" :d="FRONT" />
    <circle class="glyph" cx="412" cy="562" r="42" />
  </svg>
</template>
<script setup lang="ts">
import { useId } from "vue";

/**
 * The AnonHub icon (public/favicon.svg) as a square tile; the caller rounds and clips it. Black and white
 * (前端界面设计规范, user 2026-11-26: 「logo也改成黑白的」): the tile takes the accent and the mark the colour on
 * it, so the icon inverts with the theme. Same geometry as the favicon and the Android icon.
 */
const A = "M315 675L470 368C490 328 534 328 554 368L712 675H640L512 410L385 675Z";
const FRONT = "M701.3 394.9A160 45 -28 0 1 581.1 509.7A160 45 -28 0 1 420.5 547.7";
const base = useId();
const id = (name: string) => `${base}-${name}`;
const url = (name: string) => `url(#${id(name)})`;
</script>
<style scoped>
.tile {
  fill: var(--accent-solid);
}
.glyph {
  fill: var(--on-accent);
}
.orbit {
  fill: none;
  stroke: var(--on-accent);
  stroke-width: 13;
  stroke-linecap: round;
}
.orbit.gap {
  stroke: var(--accent-solid);
  stroke-width: 37;
}
</style>

<template>
  <div class="chat-markdown" @click="copyCode">
    <div v-html="html" />
    <span class="sr-only" role="status">{{ announcement }}</span>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";

import { renderMarkdown } from "../lib/markdown";
const props = defineProps<{ text: string }>();
const announcement = ref("");
const html = computed(() => renderMarkdown(props.text));
async function copyCode(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".copy-code");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.parentElement?.querySelector("code")?.textContent ?? "");
    announcement.value = "代码已复制";
    button.textContent = "已复制";
    setTimeout(() => {
      if (button.isConnected) button.textContent = "复制";
    }, 1500);
  } catch {
    announcement.value = "复制失败，请手动选择代码";
  }
}
</script>
<style scoped>
@reference "../styles/app.css";
/* Lines and fills are translucent so the same text reads on a filled bubble, a dialog or the page. */
.chat-markdown {
  --md-line: color-mix(in srgb, var(--text) 13%, transparent);
  --md-fill: color-mix(in srgb, var(--text) 6%, transparent);
  --md-bar: color-mix(in srgb, var(--text) 22%, transparent);
  --md-bar-hover: color-mix(in srgb, var(--text) 38%, transparent);
  min-width: 0;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: inherit;
}
.chat-markdown :deep(p) {
  margin: 8px 0;
  white-space: normal;
}
.chat-markdown :deep(div > :first-child) {
  margin-top: 0;
}
.chat-markdown :deep(div > :last-child) {
  margin-bottom: 0;
}
.chat-markdown :deep(h1),
.chat-markdown :deep(h2),
.chat-markdown :deep(h3),
.chat-markdown :deep(h4) {
  margin: 20px 0 8px;
  font-weight: 600;
  line-height: 1.4;
}
/* Headings are titles: 18px; a fourth level stays at the text's size, in bold. */
.chat-markdown :deep(h1),
.chat-markdown :deep(h2),
.chat-markdown :deep(h3) {
  font-size: 18px;
}
.chat-markdown :deep(ul) {
  list-style: disc;
  padding-left: 24px;
  margin: 8px 0;
}
.chat-markdown :deep(ol) {
  list-style: decimal;
  padding-left: 24px;
  margin: 8px 0;
}
.chat-markdown :deep(li + li) {
  margin-top: 4px;
}
.chat-markdown :deep(a) {
  @apply text-brand-text underline underline-offset-4;
  text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
}
.chat-markdown :deep(a:hover) {
  text-decoration-color: currentColor;
}
.chat-markdown :deep(blockquote) {
  @apply text-muted-foreground;
  border-left: 3px solid var(--md-line);
  margin: 12px 0;
  padding-left: 16px;
}
.chat-markdown :deep(code) {
  border-radius: 8px;
  background: var(--md-fill);
  padding: 0 4px;
  font-family: var(--mono);
  font-size: 14px;
}
.chat-markdown :deep(.code-block) {
  @apply relative my-3 overflow-hidden rounded-xl;
  background: var(--md-fill);
}
.chat-markdown :deep(pre) {
  overflow-x: auto;
  padding: 40px 16px 16px;
  margin: 0;
  white-space: pre;
  line-height: 1.6;
}
.chat-markdown :deep(pre code) {
  padding: 0;
  background: transparent;
}
.chat-markdown :deep(.copy-code) {
  @apply absolute right-2 top-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted;
  cursor: pointer;
}
.chat-markdown :deep(.table-scroll) {
  overflow-x: auto;
  margin: 16px 0;
}
/* A table or code block wider than the message scrolls sideways. Its thin bar is the only sign that more is hidden and
   the only handle a mouse has, so it stays visible where the chat hides other scrollbars (user, 2026-11-26:
   「表格太宽依旧被直接裁剪，也没办法去看超出去的地方」). Chromium draws the styled bar only while `scrollbar-width` and the
   inherited `scrollbar-color` are both auto.
   One selector per pseudo-element rule: the build merges a selector list into `:is()`, which cannot hold a
   pseudo-element, and the browser then drops the whole rule. */
.chat-markdown :deep(.table-scroll),
.chat-markdown :deep(pre) {
  scrollbar-width: auto;
  scrollbar-color: auto;
}
.chat-markdown :deep(.table-scroll::-webkit-scrollbar) {
  display: block;
  height: 6px;
}
.chat-markdown :deep(pre::-webkit-scrollbar) {
  display: block;
  height: 6px;
}
.chat-markdown :deep(.table-scroll::-webkit-scrollbar-thumb) {
  border-radius: 999px;
  background: var(--md-bar);
}
.chat-markdown :deep(pre::-webkit-scrollbar-thumb) {
  border-radius: 999px;
  background: var(--md-bar);
}
.chat-markdown :deep(.table-scroll::-webkit-scrollbar-thumb:hover) {
  background: var(--md-bar-hover);
}
.chat-markdown :deep(pre::-webkit-scrollbar-thumb:hover) {
  background: var(--md-bar-hover);
}
@supports not selector(::-webkit-scrollbar) {
  .chat-markdown :deep(.table-scroll),
  .chat-markdown :deep(pre) {
    scrollbar-width: thin;
    scrollbar-color: var(--md-bar) transparent;
  }
}
.chat-markdown :deep(table) {
  border-collapse: collapse;
  /* Columns take their content's width; a table wider than the bubble scrolls in .table-scroll. */
  width: max-content;
  min-width: 100%;
  font-size: 14px;
}
.chat-markdown :deep(th),
.chat-markdown :deep(td) {
  border: 1px solid var(--md-line);
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
}
.chat-markdown :deep(.table-cell) {
  /* Short values stay on one line; only long text wraps, between words, at this width (narrower on phones). */
  max-width: min(24em, 55vw);
  overflow-wrap: break-word;
  word-break: normal;
}
.chat-markdown :deep(th) {
  background: var(--md-fill);
  font-weight: 600;
}
.chat-markdown :deep(hr) {
  border: 0;
  border-top: 1px solid var(--md-line);
  margin: 16px 0;
}
</style>

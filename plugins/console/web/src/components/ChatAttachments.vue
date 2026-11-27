<template>
  <div class="chat-attachments">
    <div v-if="images.length" class="images" :class="{ single: images.length === 1 }">
      <button v-for="image in images" :key="image.url" type="button" class="thumb" :aria-label="`查看图片 ${image.name}`" @click="emit('open', image)">
        <img :src="image.url" :alt="image.name" loading="lazy" decoding="async" @load="emit('loaded')" @error="broken.add(image.url!)" />
      </button>
    </div>
    <ul v-if="files.length" class="files">
      <li v-for="(file, index) in files" :key="index">
        <component
          :is="file.url ? 'button' : 'span'"
          :type="file.url ? 'button' : undefined"
          class="file"
          :title="file.name"
          @click="file.url && emit('open', file)"
        >
          <span class="file-icon"><component :is="iconFor(file)" class="size-5" aria-hidden="true" /></span>
          <span class="file-name">{{ file.name }}</span>
        </component>
      </li>
    </ul>
  </div>
</template>
<script setup lang="ts">
import {
  File,
  FileZip as FileArchive,
  CodeFile as FileBraces,
  DocumentCode as FileCode,
  Gallery as FileImage,
  MusicNote as FileMusic,
  VideoFrame as FilePlay,
  ListSquare as FileSpreadsheet,
  DocumentText as FileText,
} from "reicon-vue";
import { computed, reactive } from "vue";

import type { ChatAttachment } from "../../../src/shared/chat";
import { fileFormat, type FileView } from "../lib/file-types";

/** A message's images as thumbnails and its files as cards; either opens the viewer. One that was not kept shows its name. */
const props = defineProps<{ attachments: readonly ChatAttachment[] }>();
const emit = defineEmits<{ open: [attachment: ChatAttachment]; loaded: [] }>();
/** An image that cannot be read (its computer is offline, say) falls back to a card. */
const broken = reactive(new Set<string>());
const images = computed(() => props.attachments.filter((item) => item.kind === "image" && item.url && !broken.has(item.url)));
const files = computed(() => props.attachments.filter((item) => !images.value.includes(item)));
const ICONS: Record<FileView, typeof File> = {
  markdown: FileText,
  text: FileText,
  json: FileBraces,
  table: FileSpreadsheet,
  code: FileCode,
  pdf: FileText,
  audio: FileMusic,
  video: FilePlay,
  archive: FileArchive,
  other: File,
};
const iconFor = (file: ChatAttachment) => (file.kind === "image" ? FileImage : ICONS[fileFormat(file.name).view]);
</script>
<style scoped>
@reference "../styles/app.css";

.chat-attachments {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.images {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 128px));
  gap: 8px;
}
.thumb {
  @apply rounded-xl bg-muted;
  display: block;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--line);
  aspect-ratio: 1;
  cursor: zoom-in;
}
.thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
/* One image keeps its own shape, up to a modest box; the frame fits the picture. */
.images.single {
  grid-template-columns: minmax(0, max-content);
}
.images.single .thumb {
  aspect-ratio: auto;
  width: fit-content;
  max-width: 320px;
  min-width: 64px;
  min-height: 64px;
}
.images.single .thumb img {
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
}
.thumb:focus-visible,
.file:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.files li {
  min-width: 0;
  max-width: 100%;
}
/* A file is one grey tile: its kind's icon and its name; the viewer has the rest. */
.file {
  @apply rounded-xl bg-muted text-left;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 280px;
  max-width: 100%;
  padding: 12px 16px;
  transition: background-color var(--t-fast, 0.15s) ease;
}
button.file {
  cursor: pointer;
}
button.file:hover {
  @apply bg-surface-3;
}
.file-icon {
  @apply text-muted-foreground;
  display: grid;
  flex: none;
  place-items: center;
}
.file-name {
  @apply text-sm font-medium text-foreground;
  min-width: 0;
  line-height: 20px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
span.file {
  opacity: 0.7;
}
</style>

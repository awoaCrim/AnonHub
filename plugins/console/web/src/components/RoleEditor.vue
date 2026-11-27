<template>
  <Dialog :open="open" @update:open="updateOpen">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" :aria-describedby="undefined" @close-auto-focus="closeAutoFocus">
      <DialogHeader class="pr-6">
        <DialogTitle class="truncate leading-normal">{{ creating ? "新建角色卡" : value.name || "未命名角色" }}</DialogTitle>
      </DialogHeader>
      <slot name="notice" />
      <fieldset class="role-fields" :disabled="disabled">
        <div class="pair">
          <label class="field">
            <span class="field-name">名字</span>
            <Input :value="value.name" :maxlength="ROLE_CARD_NAME_MAX" @input="set('name', text($event))" @change="save" />
          </label>
          <label class="field">
            <span class="field-name">自称</span>
            <Input :value="value.nickname" :maxlength="ROLE_CARD_NAME_MAX" :placeholder="value.name" @input="set('nickname', text($event))" @change="save" />
          </label>
        </div>
        <div v-if="!creating" class="pair">
          <div v-for="item in ROLE_CARD_PICTURES" :key="item.key" class="field">
            <span class="field-name">{{ item.label }}</span>
            <button type="button" class="picture" :aria-label="`${pictures?.[item.key] ? '更换' : '上传'}${item.label}`" @click="pick(item.key)">
              <img v-if="pictures?.[item.key]" :src="pictures[item.key]" :alt="item.label" />
              <span v-else class="inline-flex items-center gap-2 text-sm text-muted-foreground"><ImagePlus class="size-4" aria-hidden="true" />上传</span>
            </button>
            <Button v-if="pictures?.[item.key]" variant="ghost" size="sm" type="button" class="justify-self-start" @click="emit('picture', item.key, null)"
              >移除</Button
            >
          </div>
          <input
            ref="pictureInput"
            class="sr-only"
            tabindex="-1"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="选择图片"
            @change="pickPicture"
          />
        </div>
        <section class="editor-section" aria-label="角色设定">
          <h3>角色设定</h3>
          <label v-for="item in ROLE_SETTINGS" :key="item.key" class="field">
            <span class="field-name">{{ item.label }}</span>
            <Textarea v-autosize :value="value[item.key]" @input="set(item.key, text($event))" @change="save" />
          </label>
        </section>
        <section class="editor-section" aria-label="示例对话">
          <h3>示例对话</h3>
          <Textarea
            v-autosize
            class="min-h-32"
            aria-label="示例对话"
            :value="value.examples"
            :placeholder="`对方：今天排练吗？\n${value.nickname || value.name || '角色'}：当然！`"
            @input="set('examples', text($event))"
            @change="save"
          />
        </section>
        <section class="editor-section" aria-label="回复前提醒">
          <h3>回复前提醒</h3>
          <Textarea v-autosize aria-label="回复前提醒" :value="value.reminder" @input="set('reminder', text($event))" @change="save" />
        </section>
      </fieldset>
      <slot name="details" />
      <div v-if="creating" class="flex justify-end">
        <Button type="button" :disabled="disabled || busy || !value.name.trim()" @click="emit('create')">{{ busy ? "正在创建…" : "创建" }}</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
<script setup lang="ts">
import { ROLE_CARD_NAME_MAX, ROLE_CARD_PICTURES, ROLE_SETTINGS, type RoleCardPictureKey } from "@yesimbot/contracts/role-cards";
import { GalleryAdd as ImagePlus } from "reicon-vue";
import { ref, type Directive } from "vue";

import type { CardFields } from "../../../src/shared/character-cards";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const props = defineProps<{
  open: boolean;
  value: CardFields;
  busy: boolean;
  disabled: boolean;
  creating: boolean;
  /** The address of each picture the card has. */
  pictures?: Partial<Record<RoleCardPictureKey, string>>;
}>();
const emit = defineEmits<{
  edit: [value: CardFields];
  /** A field was changed for good (left or cleared): the owner saves it. */
  commit: [];
  create: [];
  picture: [key: RoleCardPictureKey, file: File | null];
  close: [];
  "close-auto-focus": [event: Event];
}>();
const pictureInput = ref<HTMLInputElement>();
let picking: RoleCardPictureKey = "reference";
function pick(key: RoleCardPictureKey) {
  picking = key;
  pictureInput.value?.click();
}

function pickPicture(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) emit("picture", picking, file);
}

/** ✕, Esc and the overlay close the editor; the owner saves what was typed (user, 2026-11-26: 即改即存). */
function updateOpen(open: boolean) {
  if (!open) emit("close");
}

/** A finished text edit; a new card is only written by 创建. */
function save() {
  if (!props.creating) emit("commit");
}

function closeAutoFocus(event: Event) {
  event.preventDefault();
  if (!props.open) emit("close-auto-focus", event);
}

const vAutosize: Directive<HTMLTextAreaElement> = { mounted: fit, updated: fit };
function fit(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight + 2}px`;
}

const text = (event: Event) => (event.target as HTMLInputElement | HTMLTextAreaElement).value;
function set<K extends keyof CardFields>(key: K, item: CardFields[K]) {
  emit("edit", { ...props.value, [key]: item });
  const target = document.activeElement;
  if (target instanceof HTMLTextAreaElement) fit(target);
}
</script>
<style scoped>
@reference "../styles/app.css";
.role-fields {
  display: grid;
  gap: 24px;
  min-width: 0;
  border: 0;
  margin: 0;
  padding: 0;
}
.editor-section {
  display: grid;
  gap: 16px;
}
.editor-section h3 {
  @apply border-b border-border text-sm font-semibold;
  padding-bottom: 8px;
}
.field {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.field-name {
  @apply text-sm font-medium;
}
.field textarea {
  min-height: 72px;
}
.pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.picture {
  @apply rounded-lg border border-dashed border-border bg-muted/50;
  display: grid;
  place-items: center;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  transition: border-color var(--t-fast) var(--ease-out);
}
.picture:has(img) {
  @apply border-solid;
}
.picture:hover:not(:disabled) {
  @apply border-ring;
}
.picture img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
@media (max-width: 640px) {
  .pair:first-child {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

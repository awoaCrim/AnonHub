<template>
  <section class="web-chat" :aria-label="`和${bot.name}对话`">
    <div ref="scroller" class="messages" role="log" aria-live="polite" aria-label="对话消息" @scroll="track">
      <slot name="top" />
      <div v-if="state.unavailable" class="empty-state">
        <h3>网页对话还没有开启</h3>
        <p>这台服务器的版本还不支持在网页上聊天。现在可以在 QQ 或微信里私聊它。</p>
      </div>
      <div v-else-if="!state.snapshot && !state.loadError" class="loading" aria-busy="true">
        <Skeleton v-for="n in 3" :key="n" class="skeleton" :style="{ width: `${[56, 38, 64][n - 1]}%` }"></Skeleton>
      </div>
      <Alert v-else-if="!state.snapshot" variant="warn" as="p">{{ state.loadError }}</Alert>
      <div v-else-if="!messages.length && !typing" class="empty-state">
        <h3>{{ open?.id ? "新的对话" : "和它打个招呼" }}</h3>
      </div>
      <ol v-else class="list">
        <template v-for="row in rows" :key="row.message.id">
          <li v-if="row.stamp" class="stamp">
            <time :datetime="new Date(row.message.at).toISOString()">{{ row.stamp }}</time>
          </li>
          <li class="message" :class="[row.message.role, row.message.status, { first: row.first, last: row.last, fresh: row.message.at > openedAt }]">
            <div v-if="row.message.text" class="bubble">
              <ChatMarkdown v-if="row.message.role === 'bot'" :text="row.message.text" />
              <p v-else class="text">{{ row.message.text }}</p>
            </div>
            <ChatAttachments
              v-if="row.message.attachments?.length"
              class="attachments"
              :attachments="row.message.attachments"
              @open="viewing = $event"
              @loaded="scrollToEnd()"
            />
            <span v-if="row.message.reaction" class="reaction" role="img" :aria-label="`${bot.name}回应了 ${row.message.reaction}`">{{
              row.message.reaction
            }}</span>
            <div v-if="row.message.choices?.length && row.message === messages.at(-1)" class="choices" role="group" aria-label="可以直接点选回复">
              <Button v-for="choice in row.message.choices" :key="choice" variant="outline" size="sm" class="rounded-full" @click="choose(choice)">{{
                choice
              }}</Button>
            </div>
            <small v-if="statusText(row.message)" class="meta"
              >{{ statusText(row.message)
              }}<button
                v-if="chat.failure(row.message.id) !== undefined"
                type="button"
                class="retry"
                :title="chat.failure(row.message.id)"
                @click="chat.retry(row.message.id)"
              >
                重试
              </button></small
            >
          </li>
        </template>
        <li v-if="typing" class="message bot typing first last">
          <div class="bubble">
            <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span
            ><span v-if="activity" class="ml-3 text-sm text-muted-foreground" role="status">{{ activity }}</span
            ><span v-else class="sr-only">正在输入</span>
          </div>
        </li>
      </ol>
    </div>

    <Button v-if="!atBottom && messages.length" variant="outline" size="sm" class="jump" type="button" @click="scrollToEnd(true)"><ArrowDown />回到最新</Button>

    <form
      class="composer"
      :class="{ dropping: dragging, refusing: dragging && !acceptsDrop() }"
      aria-label="给它发消息"
      @submit.prevent="submit"
      @dragenter="dragEnter"
      @dragover="dragOver"
      @dragleave="dragLeave"
      @drop="drop"
    >
      <div v-if="dragging" class="drop-hint" role="status">{{ acceptsDrop() ? "松开即可上传" : "现在不能上传" }}</div>
      <div v-if="files.length" class="pending-files">
        <template v-for="file in files" :key="file.id">
          <span v-if="previews.get(file.id)" class="pending-image">
            <button
              type="button"
              class="pending-thumb"
              :aria-label="'查看 ' + file.name"
              @click="viewing = { kind: 'image', name: file.name, url: previews.get(file.id) }"
            >
              <img :src="previews.get(file.id)" :alt="file.name" />
            </button>
            <Button variant="secondary" size="icon-sm" class="pending-remove" :aria-label="'移除 ' + file.name" @click="removeFile(file.id)">×</Button>
          </span>
          <span v-else class="inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-xs"
            ><Icon :name="file.kind === 'image' ? 'image' : 'file'" /><span class="truncate">{{ file.name }}</span
            ><Button variant="ghost" size="icon-sm" :aria-label="'移除 ' + file.name" @click="removeFile(file.id)">×</Button></span
          >
        </template>
      </div>
      <input ref="fileInput" type="file" multiple class="hidden" aria-label="选择附件" @change="selectFiles" />
      <div class="field" :class="{ disabled: state.unavailable }">
        <Button
          variant="ghost"
          size="icon"
          type="button"
          class="tool"
          :disabled="!uploadAvailable || uploading"
          :title="uploadTitle"
          :aria-label="uploading ? '正在上传' : '上传图片或文件'"
          @click="fileInput?.click()"
          ><LoaderCircle v-if="uploading" class="size-5 animate-spin" /><Plus v-else class="size-5"
        /></Button>
        <label class="sr-only" for="web-chat-input">消息</label>
        <Textarea
          id="web-chat-input"
          class="min-h-0 border-0 bg-transparent dark:bg-transparent shadow-none focus-visible:ring-0"
          v-model="draft"
          :rows="inputRows"
          wrap="off"
          maxlength="4000"
          :placeholder="state.unavailable ? '网页对话还没有开启' : `和${bot.name}说点什么…`"
          :disabled="state.unavailable"
          @keydown="keydown"
          @paste="paste"
        ></Textarea>
        <PickerMenu
          v-if="open && state.snapshot?.models?.length"
          v-model="modelValue"
          class="model"
          label="这个对话用的回复模型"
          placement="up"
          :options="modelOptions"
          :disabled="state.changing"
        >
          <Sparkles class="model-icon size-4" aria-hidden="true" /><span class="model-name truncate" :title="shortModel">{{ shortModel }}</span>
        </PickerMenu>
        <Button
          v-if="voice.supported"
          variant="ghost"
          size="icon"
          type="button"
          class="tool voice"
          :class="{ listening: voice.listening.value }"
          :disabled="state.unavailable"
          :aria-pressed="voice.listening.value"
          :aria-label="voice.listening.value ? '停止语音输入' : '语音输入'"
          :title="voice.listening.value ? '正在听，点一下结束' : '语音输入：说的话会变成文字放进输入框'"
          @click="voice.toggle()"
          ><Mic class="size-5"
        /></Button>
        <Button
          v-if="stoppable"
          variant="secondary"
          class="send"
          type="button"
          :disabled="state.stopping"
          aria-label="停止回复"
          title="停止这一轮回复（后台任务不受影响）"
          @click="stopReply"
        >
          <Square weight="Filled" />
        </Button>
        <Button
          v-else
          variant="default"
          class="send"
          type="submit"
          :disabled="(!draft.trim() && !files.length) || uploading || state.unavailable"
          aria-label="发送"
        >
          <Icon name="send" /><span class="sr-only">发送</span>
        </Button>
      </div>
      <p v-if="state.error" class="composer-error" role="alert">{{ state.error }}</p>
    </form>
    <AttachmentViewer :attachment="viewing" @close="viewing = undefined" />
  </section>
</template>
<script setup lang="ts">
import { ArrowDown, Loader as LoaderCircle, Microphone as Mic, Add as Plus, Stars as Sparkles, Stop as Square } from "reicon-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, provide, reactive, ref, watch } from "vue";

import type { ChatAttachment, ChatMessage, ChatSnapshot, ChatUploadStatus } from "../../../src/shared/chat";
import { api, ApiError } from "../lib/api";
import { formatBytes, formatTime } from "../lib/format";
import type { PickerOption } from "../lib/picker";
import { webTitle } from "../lib/talk";
import { dismissToast, toast } from "../lib/toast";
import { useTopic } from "../lib/use-topic";
import { useVoiceInput } from "../lib/voice-input";
import { useWebPersona, type WebPersona } from "../lib/web-persona";
import { botIdentityKey } from "../shell/bot-identity";
import Icon from "../shell/Icon.vue";
import { createWebChat } from "../state/web-chat";
import AttachmentViewer from "./AttachmentViewer.vue";
import ChatAttachments from "./ChatAttachments.vue";
import ChatMarkdown from "./ChatMarkdown.vue";
import PickerMenu from "./PickerMenu.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";

/**
 * The account holder's private chat with their own bot, on the web: the open conversation (the 对话 page's
 * list picks it). Each conversation counts as a private chat with its own history, and may pick its own role
 * card and reply model (only for itself; QQ and the rest keep 设置). The live `chat` topic keeps it current.
 */
/** The 对话 page shares its chat state (it lists and opens the conversations); on its own it keeps one. */
const props = defineProps<{ chat?: ReturnType<typeof createWebChat>; persona?: WebPersona }>();
const chat = props.chat ?? createWebChat();
const { state, messages, typing, activity } = chat;
const topic = useTopic<ChatSnapshot>("chat");
watch(() => topic.data, chat.accept, { immediate: true });

// ---------- Conversations ----------
const conversations = computed(() => state.snapshot?.conversations ?? []);
/** The open conversation; absent on servers with a single web chat. */
const open = computed(() => conversations.value.find((item) => item.id === state.snapshot?.conversation.id));
async function act(body: Parameters<typeof chat.change>[0], done?: string) {
  const error = await chat.change(body);
  if (error) toast(error, "danger");
  else if (done) toast(done);
  return !error;
}

// ---------- Who speaks in this conversation ----------
const persona = props.persona ?? useWebPersona(chat);
const bot = persona.bot;
provide(botIdentityKey, bot);

// ---------- Its reply model in this conversation ----------
const labelOf = (id?: string) => state.snapshot?.models?.find((model) => model.id === id)?.label ?? id ?? "";
const defaultModelLabel = computed(() => labelOf(state.snapshot?.defaultModel));
/** The picker shows only the model's name; the list shows name · service. */
const shortModel = computed(() => (open.value?.chatModel ? labelOf(open.value.chatModel) : defaultModelLabel.value || "设置里的模型").split(" · ")[0]);
const modelValue = computed({
  get: () => open.value?.chatModel ?? "@settings",
  set: (value: string) => {
    const conversation = open.value;
    if (!conversation) return;
    void act(
      { action: "update", id: conversation.id, chatModel: value === "@settings" ? null : value },
      `这个对话之后用 ${value === "@settings" ? defaultModelLabel.value || "设置里的模型" : labelOf(value)} 回复。`,
    );
  },
});
/** Model labels are "name · service": the name leads, the service is the quiet note. */
const modelOptions = computed<PickerOption[]>(() => [
  { value: "@settings", label: "跟随设置", note: defaultModelLabel.value.split(" · ")[0] },
  ...(state.snapshot?.models ?? []).map((model, index) => {
    const [name, ...service] = model.label.split(" · ");
    return { value: model.id, label: name ?? model.label, note: service.join(" · "), divider: index === 0 };
  }),
]);
watch(
  () => topic.unavailable,
  (unavailable) => {
    if (unavailable && !state.snapshot) state.unavailable = true;
  },
  { immediate: true },
);

const draft = ref("");
const fileInput = ref<HTMLInputElement>();
const files = ref<Array<{ id: string; name: string; kind: string }>>([]),
  /** Images can be sent; `fileUploads`: the conversation's computer also takes other files. */
  uploadAvailable = ref(false),
  fileUploads = ref(false),
  uploadMaxBytes = ref(180 * 1024),
  imageMaxBytes = ref(5 * 1024 * 1024),
  uploading = ref(false);
/** Local previews of images waiting to be sent, by upload ID; a sent message keeps showing its own until the page closes. */
const previews = reactive(new Map<string, string>());
const localUrls: string[] = [];
/** The attachment open in the viewer. */
const viewing = ref<ChatAttachment>();
const uploadTitle = computed(() =>
  !uploadAvailable.value
    ? "现在不能上传"
    : fileUploads.value
      ? `上传图片或文件（图片不超过 ${formatBytes(imageMaxBytes.value)}，文件不超过 ${formatBytes(uploadMaxBytes.value)}）`
      : `上传图片（不超过 ${formatBytes(imageMaxBytes.value)}）；发其他文件要先连接电脑`,
);
function removeFile(id: string) {
  files.value = files.value.filter((file) => file.id !== id);
  const url = previews.get(id);
  previews.delete(id);
  if (url) URL.revokeObjectURL(url);
}
const IMAGE_FILE = /^image\/(png|jpeg|gif|webp)$/i;
const isImageFile = (file: File) => IMAGE_FILE.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
let uploadPoll: ReturnType<typeof setTimeout> | undefined,
  uploadToast: number | undefined,
  disposed = false,
  uploadGeneration = 0;
const uploadSession = computed(() => {
  const conversation = state.snapshot?.conversation;
  return JSON.stringify([conversation?.channel, conversation?.id, conversation?.session]);
});
watch(uploadSession, () => uploadGeneration++, { flush: "sync" });
const canUpload = () => !disposed && !state.unavailable && !state.changing && uploadAvailable.value;
function clearUploadError() {
  if (uploadToast !== undefined) dismissToast(uploadToast);
  uploadToast = undefined;
}

function showUploadError(message: string) {
  clearUploadError();
  uploadToast = toast(message, "danger");
}

async function checkUploads() {
  if (disposed) return;
  try {
    const result = await api<ChatUploadStatus>("/yesimbot/api/v1/chat/uploads", undefined, { fresh: true });
    if (!disposed) {
      uploadAvailable.value = result.available;
      fileUploads.value = result.files ?? result.available;
      uploadMaxBytes.value = result.maxBytes;
      imageMaxBytes.value = result.imageMaxBytes ?? result.maxBytes;
    }
  } catch {
    if (!disposed) uploadAvailable.value = fileUploads.value = false;
  } finally {
    if (!disposed) uploadPoll = setTimeout(checkUploads, 15000);
  }
}

/** A native file picker hands over its selection; the input is cleared only after the whole batch has settled. */
async function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  if (uploading.value) return;
  try {
    await uploadFiles(Array.from(input.files ?? []));
  } finally {
    // Keep the native selection alive until the whole upload batch has settled.
    input.value = "";
  }
}

async function uploadFiles(selected: File[]) {
  if (uploading.value) return;
  if (!selected.length || !canUpload()) return;
  clearUploadError();
  if (selected.length + files.value.length > 8) {
    showUploadError("一次最多上传 8 个附件");
    return;
  }
  const token = uploadGeneration;
  const current = () => token === uploadGeneration && canUpload();
  // Keep an in-flight batch separate so a new conversation cannot inherit its late results.
  const uploadedFiles: typeof files.value = [];
  const uploadedPreviews = new Map<string, string>();
  let failureMessage = "上传未能确认，请检查电脑连接及文件大小后重试。";
  uploading.value = true;
  try {
    for (const file of selected) {
      if (!current()) return;
      // An image goes to the conversation itself; anything else (or a larger image) needs the computer.
      const limit = Math.max(isImageFile(file) ? imageMaxBytes.value : 0, fileUploads.value ? uploadMaxBytes.value : 0);
      failureMessage = limit ? `文件必须非空且不超过 ${formatBytes(limit)}` : COMPUTER_FOR_FILES;
      if (file.size > limit || !file.size) throw Error(failureMessage);
      failureMessage = "上传未能确认，请检查电脑连接及文件大小后重试。";
      const uploaded = await api<{ id: string; name: string; kind: string }>(`/yesimbot/api/v1/chat/uploads?name=${encodeURIComponent(file.name)}`, undefined, {
        rawBody: file,
      });
      if (!current()) return;
      uploadedFiles.push(uploaded);
      if (uploaded.kind === "image" && typeof URL.createObjectURL === "function") uploadedPreviews.set(uploaded.id, URL.createObjectURL(file));
    }
  } catch (error) {
    if (error instanceof ApiError && (error.code === "upload_computer_required" || error.code === "upload_computer_unavailable"))
      failureMessage = COMPUTER_FOR_FILES;
    if (current()) showUploadError(failureMessage);
  } finally {
    const keep = !disposed && current();
    if (keep) files.value.push(...uploadedFiles);
    for (const [id, url] of uploadedPreviews) {
      if (keep) {
        previews.set(id, url);
        localUrls.push(url);
      } else URL.revokeObjectURL(url);
    }
    if (!disposed) uploading.value = false;
  }
}

// ---------- Dropping and pasting files ----------
const dragging = ref(false);
let dragDepth = 0;
const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
const acceptsDrop = () => canUpload() && !uploading.value;
const UPLOAD_UNAVAILABLE = "现在不能上传：机器人还没准备好，请稍后再试。";
const COMPUTER_FOR_FILES = "没连电脑时只能发图片（PNG、JPG、GIF、WebP，不超过 5 MB）；其他文件要先连接网页对话绑定的电脑。";
/** Hand dropped or pasted files to the upload path; without a connected computer say why nothing happened. */
function receiveFiles(list: File[]) {
  if (!list.length) return;
  if (!uploadAvailable.value || state.unavailable) showUploadError(UPLOAD_UNAVAILABLE);
  else void uploadFiles(list);
}

function dragEnter(event: DragEvent) {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  dragging.value = true;
}

function dragOver(event: DragEvent) {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = acceptsDrop() ? "copy" : "none";
  dragging.value = true;
}

function dragLeave(event: DragEvent) {
  if (!carriesFiles(event)) return;
  // Entering a child fires leave on its parent first; only the last leave ends the drag.
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragging.value = false;
}

function drop(event: DragEvent) {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dragging.value = false;
  receiveFiles(Array.from(event.dataTransfer?.files ?? []));
}

function paste(event: ClipboardEvent) {
  const pasted = Array.from(event.clipboardData?.files ?? []);
  // Plain-text paste keeps the browser's own behaviour.
  if (!pasted.length) return;
  event.preventDefault();
  receiveFiles(pasted);
}
/**
 * Typed text stays on its line and scrolls sideways instead of wrapping (user, 2026-11-23: 「不能换行，保持在一行」);
 * only line breaks the user types add rows, up to six.
 */
const inputRows = computed(() => Math.min(6, Math.max(1, draft.value.split("\n").length)));
function submit() {
  const text = draft.value;
  if ((!text.trim() && !files.value.length) || uploading.value) return;
  stick = true;
  // The message shows and the input empties at once; a failure stays on the message with a retry.
  const sent = files.value;
  const attachments = sent.map((file) => ({
    kind: file.kind === "image" ? ("image" as const) : ("file" as const),
    name: file.name,
    ...(previews.has(file.id) ? { url: previews.get(file.id) } : {}),
  }));
  files.value = [];
  draft.value = "";
  // The sent bubble keeps showing the local previews until its saved copy arrives.
  for (const file of sent) previews.delete(file.id);
  return chat.send(
    text,
    sent.map((file) => file.id),
    attachments,
  );
}

// ---------- Stop, choices, voice ----------
/** While it replies and nothing is typed, the send button stops the reply instead. */
const stoppable = computed(() => typing.value && !draft.value.trim() && !files.value.length && !state.unavailable);
async function stopReply() {
  const error = await chat.stop();
  if (error) toast(error, "danger");
}

/** A clickable option is sent as the user's reply, as if typed. */
function choose(choice: string) {
  stick = true;
  void chat.send(choice);
}
const voice = useVoiceInput(draft, (message) => toast(message, "danger"));

function keydown(event: KeyboardEvent) {
  // Enter while an input method is composing picks a candidate, it does not send.
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  void submit();
}

const statusText = (message: ChatMessage) =>
  message.role !== "user" ? "" : message.status === "sending" ? "发送中…" : message.status === "failed" ? "没有发出去" : "";
/** Day separators carry the date, so each group shows only its clock time. */
function time(value: number) {
  const text = formatTime(value);
  return /^\d\d-\d\d \d\d:\d\d$/.test(text) ? text.slice(6) : text;
}

/** Consecutive messages from one side within five minutes form a group, set closer together. */
const GROUP_GAP = 5 * 60_000;
/** A centred time between messages: at the start of each day and after a quarter of an hour of quiet. */
const STAMP_GAP = 15 * 60_000;
const rows = computed(() => {
  const list = messages.value;
  return list.map((message, index) => {
    const previous = list[index - 1],
      next = list[index + 1];
    const joined = (a?: ChatMessage, b?: ChatMessage) => !!a && !!b && a.role === b.role && b.at - a.at < GROUP_GAP && dayKey(a.at) === dayKey(b.at);
    return {
      message,
      next,
      first: !joined(previous, message),
      last: !joined(message, next),
      stamp:
        !previous || dayKey(previous.at) !== dayKey(message.at)
          ? `${dayLabel(message.at)} ${time(message.at)}`.trim()
          : message.at - previous.at >= STAMP_GAP
            ? time(message.at)
            : "",
    };
  });
});
const dayKey = (value: number) => formatTime(value, "day");
function dayLabel(value: number) {
  const today = new Date(),
    date = new Date(value);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(value) === dayKey(today.getTime())) return "今天";
  if (dayKey(value) === dayKey(yesterday.getTime())) return "昨天";
  if (!Number.isFinite(date.getTime())) return "";
  const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()} 年 ${day}`;
}

// Follow new messages while the reader is at the bottom; scrolling up to read stops that.
const scroller = ref<HTMLElement>();
const atBottom = ref(true);
let stick = true;
function track() {
  const element = scroller.value;
  if (!element) return;
  atBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  stick = atBottom.value;
}

function scrollToEnd(force = false) {
  void nextTick(() => {
    const element = scroller.value;
    if (!element || !(force || stick)) return;
    element.scrollTop = element.scrollHeight;
    atBottom.value = stick = true;
  });
}
watch(
  () => [messages.value.length, messages.value.at(-1)?.id, typing.value] as const,
  () => scrollToEnd(),
);

onMounted(() => {
  void checkUploads();
  void chat.load();
  scrollToEnd(true);
});
onBeforeUnmount(() => {
  disposed = true;
  for (const url of localUrls.splice(0)) URL.revokeObjectURL(url);
  previews.clear();
  clearUploadError();
  clearTimeout(uploadPoll);
  if (!props.chat) chat.dispose();
});
// Opening another conversation starts at its newest message; only what arrives after that rises into place.
const openedAt = ref(Date.now());
watch(
  () => open.value?.id,
  () => {
    openedAt.value = Date.now();
    scrollToEnd(true);
  },
);
</script>
<style scoped>
@reference "../styles/app.css";

/* It fills the pane the 对话 page gives it: one centred column for messages and the composer. */
/* The column's side margins; on a computer wide enough to clear the side panel's toggle in the top corner. */
.web-chat {
  --gutter: max(24px, calc((100% - var(--column)) / 2));
}
@media (min-width: 901px) {
  .web-chat {
    --gutter: max(56px, calc((100% - var(--column)) / 2));
  }
}
.web-chat {
  --column: 760px;
  container: chat / inline-size;
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

/* Keep message, composer and Markdown overflow scrollable without visible tracks. Two rules, not one list: the
   built stylesheet kept only `.web-chat` of the list, so everything inside it fell back to the app's thin
   scrollbar, which Windows draws with arrows (user, 2026-11-23: 「这咋还有垂直的滚动条？」). */
.web-chat {
  scrollbar-width: none;
}
.web-chat :deep(*) {
  scrollbar-width: none;
}
.web-chat::-webkit-scrollbar,
.web-chat :deep(*::-webkit-scrollbar) {
  display: none;
}

/* A column, so the empty state fills what the caller's top slot leaves. */
.messages {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px var(--gutter) 20px;
  scroll-padding-block: 24px;
}
/* A quick load never flashes the placeholder: it fades in only after a quarter second. */
.loading {
  display: grid;
  gap: 16px;
  opacity: 0;
  animation: show-late 0.2s ease 0.25s forwards;
}
@keyframes show-late {
  to {
    opacity: 1;
  }
}
.message.fresh {
  animation: rise 0.2s cubic-bezier(0.2, 0, 0, 1);
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.loading .skeleton {
  border-radius: 20px;
  height: 42px;
}
.loading .skeleton:nth-child(2) {
  justify-self: end;
}
/* Nothing in the column gives way to the others: a heading in the top slot keeps its height above a long list. */
.messages > * {
  flex-shrink: 0;
}
.messages > .empty-state {
  display: grid;
  flex: 1;
  place-content: center;
  max-width: 420px;
  margin: 0 auto;
  text-align: center;
}

.list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* The time between messages: quiet, centred, nothing drawn around it. */
.stamp {
  @apply text-xs text-muted-foreground;
  justify-self: center;
  margin: 28px 0 12px;
  font-variant-numeric: tabular-nums;
}
.list > .stamp:first-child {
  margin-top: 4px;
}
/* One message per row; a group of one side's messages sits closer together. */
.message {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  row-gap: 4px;
  align-items: end;
  margin-top: 4px;
}
.message.first {
  margin-top: 16px;
}
.stamp + .message,
.list > .message:first-child {
  margin-top: 0;
}
.message.user {
  grid-template-columns: minmax(0, max-content);
  justify-content: end;
  justify-items: end;
}
/* Filled grey bubbles, no border or shadow: the side tells the two apart. */
.bubble {
  @apply text-foreground;
  min-width: 0;
  max-width: min(640px, 88%);
  padding: 12px 16px;
  border-radius: 20px;
  background: var(--bubble-bot);
  font-size: 16px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.message.bot .bubble {
  justify-self: start;
}
/* A table gets the whole column before it has to scroll. */
.message.bot .bubble:has(.table-scroll) {
  max-width: 100%;
}
.message.user .bubble {
  max-width: 100%;
  background: var(--bubble-user);
}
.message.user {
  max-width: min(640px, 88%);
  justify-self: end;
}
.message.user.sending .bubble {
  opacity: 0.6;
}
.message.user.failed .bubble {
  @apply bg-danger-soft text-destructive;
}
.text {
  margin: 0;
  white-space: pre-wrap;
}
/* Images and files stand on their own beside the words, never inside a bubble: above the user's words, below the bot's. */
.attachments {
  max-width: min(640px, 88%);
}
.message.user .attachments {
  order: -1;
  max-width: 100%;
}
.message.user .attachments :deep(.images),
.message.user .attachments :deep(.files) {
  justify-content: end;
}
.message.user.sending .attachments {
  opacity: 0.6;
}
.retry {
  margin-left: 0.5rem;
  text-decoration: underline;
  cursor: pointer;
}
.meta {
  @apply text-xs text-muted-foreground;
  grid-column: -2;
  padding: 0 8px;
}
.message.failed .meta {
  @apply text-destructive;
}
/* Its emoji on the user's message, tucked under the bubble's corner. */
.reaction {
  grid-column: -2;
  justify-self: end;
  margin-top: -16px;
  margin-right: 12px;
  padding: 0 8px;
  border: 2px solid var(--bg);
  border-radius: 999px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
  font-size: 14px;
  line-height: 1.6;
}
.choices {
  grid-column: -2;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.typing .bubble {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
}
.dots {
  display: inline-flex;
  gap: 4px;
  padding: 4px 4px;
}
.dots i {
  @apply rounded-full bg-muted-foreground;
  width: 6px;
  height: 6px;
  animation: blink 1.2s infinite ease-in-out;
}
.dots i:nth-child(2) {
  animation-delay: 0.2s;
}
.dots i:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes blink {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dots i {
    animation: none;
    opacity: 0.6;
  }
}
/* Floats over the messages like the composer: white with its line and shadow, so it reads over a grey bubble too. */
.jump {
  @apply bg-card hover:bg-muted;
  border: 1px solid var(--composer-border);
  border-radius: 16px;
  box-shadow: var(--composer-shadow);
  position: absolute;
  left: 50%;
  bottom: 92px;
  z-index: 1;
  transform: translateX(-50%);
}

/* The composer: one white pill floating over the page, every control on the text's row. */
.composer {
  position: relative;
  display: grid;
  gap: 0;
  margin: 0 var(--gutter) max(20px, env(safe-area-inset-bottom));
  padding: 4px;
  border: 1px solid var(--composer-border);
  border-radius: 26px;
  @apply bg-card;
  box-shadow: var(--composer-shadow);
  flex-shrink: 0;
  transition: border-color 0.15s;
}
.composer:focus-within {
  border-color: var(--line-strong);
}
/* A file is being dragged over: dashed accent border and a centred hint over the composer. */
.composer.dropping {
  border-style: dashed;
  border-color: var(--accent);
}
.composer.dropping.refusing {
  @apply border-destructive;
}
.drop-hint {
  @apply bg-card/95 text-sm font-medium text-foreground;
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-content: center;
  border-radius: inherit;
  pointer-events: none;
}
.composer.dropping:not(.refusing) .drop-hint {
  color: var(--accent);
}
/* Images and files waiting to be sent, above the text. */
.pending-files {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 4px;
}
.pending-image {
  position: relative;
  display: inline-block;
}
.pending-thumb {
  @apply rounded-xl bg-muted;
  display: block;
  width: 56px;
  height: 56px;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--line);
  cursor: zoom-in;
}
.pending-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pending-remove {
  @apply rounded-full shadow-sm;
  position: absolute;
  top: -8px;
  right: -8px;
  width: 20px;
  height: 20px;
  min-width: 0;
  font-size: 14px;
  line-height: 1;
}
/* The text grows upward to six lines; the buttons stay on its last line. */
.field {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  min-height: 44px;
}
.field.disabled {
  opacity: 0.6;
}
.tool {
  @apply rounded-full text-muted-foreground;
  flex: none;
  margin: 4px 0;
}
.tool:hover {
  @apply text-foreground;
}
.voice.listening {
  @apply text-destructive;
  animation: blink 1.2s infinite ease-in-out;
}
.field textarea {
  flex: 1;
  min-width: 0;
  align-self: center;
  padding: 12px 8px;
  font-size: 16px;
  line-height: 1.5;
  resize: none;
  /* One line per typed line: long text scrolls sideways, without a visible track. */
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
  scrollbar-width: none;
}
.field textarea::-webkit-scrollbar {
  display: none;
}
.field textarea::placeholder {
  @apply text-muted-foreground;
}
/* The reply model: a quiet name beside the text, opened upward. */
.model {
  flex: none;
  margin: 8px 0;
}
.model :deep([data-slot="select-trigger"]) {
  @apply rounded-full bg-transparent text-xs text-muted-foreground;
  height: 32px;
  gap: 4px;
  padding: 0 12px;
}
.model :deep([data-slot="select-trigger"]:hover) {
  @apply bg-muted text-foreground;
}
.model-name {
  display: block;
  max-width: 180px;
}
.model-icon {
  display: none;
}
.send {
  @apply rounded-full;
  flex: none;
  width: 36px;
  height: 36px;
  margin: 4px;
  padding: 0;
}
/* Nothing to send yet: a grey circle rather than a faded accent one. */
.send:disabled {
  @apply bg-muted text-muted-foreground;
  opacity: 1;
}
.send .icon {
  width: 16px;
  height: 16px;
}
.composer-error {
  @apply text-xs text-destructive;
  margin: 0;
  padding: 4px 12px 8px;
}
/* A narrow column keeps the text room: the model shows as an icon, its name is in the menu. The text takes the whole
   first line and the buttons sit on a row under it, upload on the left and the rest on the right, as phone chat apps
   do; on one line the buttons left the text a third of a phone's width. */
@container chat (max-width: 520px) {
  .model-icon {
    display: block;
  }
  .model-name {
    display: none;
  }
  .field {
    flex-wrap: wrap;
  }
  .field textarea {
    order: -1;
    flex: 1 0 100%;
    padding: 12px 12px 4px;
  }
  .field > :first-child {
    margin-right: auto;
  }
}
@media (max-width: 640px) {
  .composer {
    margin: 0 12px max(12px, env(safe-area-inset-bottom));
  }
  .messages {
    padding: 12px 16px 16px;
  }
  .bubble,
  .message.user {
    max-width: 92%;
  }
}
</style>

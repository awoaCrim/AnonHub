<template>
  <section ref="fileList" class="space-y-2" aria-label="角色卡" @click.capture="rememberFocus">
    <Alert v-if="state.error && !opened" variant="destructive"
      >{{ state.error }}<Button variant="outline" size="sm" :disabled="state.loading" @click="view.load()">重新读取</Button></Alert
    >
    <header class="flex items-center gap-1">
      <h3 class="mr-auto text-lg font-semibold">
        角色卡 <span v-if="state.snapshot" class="ml-1 font-normal text-muted-foreground">{{ cards.length }}</span>
      </h3>
      <!-- Built-in cards are added from here as copies (user, 2026-11-27: 「将当前的anon角色卡作为系统内置的可选角色卡之一」). -->
      <DropdownMenu v-if="entry && presets.length">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" class="rounded-full text-muted-foreground" aria-label="新建角色卡" :disabled="unavailable"
            ><Plus class="size-4"
          /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-48">
          <DropdownMenuItem @select="create()">空白角色卡</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem v-for="preset in presets" :key="preset.id" @select="addPreset(preset.id)">{{ preset.name }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        v-else-if="entry"
        variant="ghost"
        size="icon-sm"
        class="rounded-full text-muted-foreground"
        aria-label="新建角色卡"
        :disabled="unavailable"
        @click="create()"
        ><Plus class="size-4"
      /></Button>
    </header>
    <LoadingRows v-if="!plugins.data && !plugins.failed" :count="1" label="正在读取角色库" />
    <p v-else-if="plugins.failed && !entry" class="text-sm text-destructive" role="alert">暂时无法读取角色库，请稍后重试。</p>
    <div v-else-if="!entry" class="arrive">
      <Button variant="outline" size="sm" :disabled="starting || !plugins.data?.writable" @click="startRoleplay">{{
        starting ? "准备中…" : "创建角色库"
      }}</Button>
    </div>
    <template v-else>
      <LoadingRows v-if="state.loading && !state.snapshot" :count="1" label="正在读取角色卡" />
      <p v-else-if="state.snapshot && !cards.length" class="arrive px-2 text-sm text-muted-foreground">暂无角色卡</p>
      <div v-if="cards.length" class="arrive-list grid gap-1">
        <button v-for="card in cards" :key="card.id" type="button" class="side-row role-file" :disabled="unavailable || card.error" @click="open(card.id)">
          <span class="side-row-icon overflow-hidden"
            ><img v-if="cardPictureUrl(state.path, card)" :src="cardPictureUrl(state.path, card)" alt="" class="size-full object-cover" /><UserRound
              v-else
              class="size-4"
          /></span>
          <strong class="side-row-title min-w-0 flex-1">{{ card.name || "未命名角色" }}</strong>
          <span v-if="card.error" class="shrink-0 text-xs text-destructive">读取失败</span>
          <span v-else-if="entry.enabled && card.id === state.snapshot?.active" class="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground"
            >默认</span
          >
        </button>
      </div>
    </template>
    <RoleEditor
      :open="opened"
      :value="state.value"
      :busy="state.busy"
      :disabled="locked"
      :creating="state.creating"
      :pictures="pictures"
      @edit="view.edit($event as unknown as Record<string, unknown>)"
      @commit="commit()"
      @create="createCard"
      @picture="setPicture"
      @close="close"
      @close-auto-focus="restoreFocus"
    >
      <template #notice>
        <Alert v-if="state.error" variant="destructive"
          >{{ state.error
          }}<Button variant="outline" size="sm" :disabled="state.loading || state.busy" @click="view.load(state.path, state.id)">重新读取</Button></Alert
        >
      </template>
      <template #details>
        <!-- One row, no box (user, 2026-11-27: 「这个留着有啥用」): the list already marks 默认; 取消默认 is the way
             back to the built-in persona, and the default card cannot be deleted, so it offers no 删除. -->
        <div v-if="!state.creating" class="flex items-center gap-2">
          <Button v-if="!isDefault" variant="ghost" size="sm" class="text-destructive" :disabled="unavailable" @click="remove">删除</Button>
          <Button
            variant="outline"
            size="sm"
            class="ml-auto"
            :disabled="unavailable || !!entry?.locked"
            @click="setDefault(isDefault ? '@builtin' : state.id)"
            >{{ isDefault ? "取消默认" : "设为默认" }}</Button
          >
        </div>
      </template>
    </RoleEditor>
  </section>
</template>
<script setup lang="ts">
import { ROLE_CARD_PICTURE_MAX_BYTES, type RoleCardPictureKey } from "@yesimbot/contracts/role-cards";
import { Add as Plus, User as UserRound } from "reicon-vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";

import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import { confirmDialog } from "../lib/dialog";
import { addPluginInstance } from "../lib/plugin-actions";
import { flattenPlugins, pluginError, pluginIdentity } from "../lib/plugin-config";
import { toast } from "../lib/toast";
import { useTopic } from "../lib/use-topic";
import type { WebPersona } from "../lib/web-persona";
import { cardPictureUrl, createRoleEditor } from "../state/role-editor";
import LoadingRows from "./LoadingRows.vue";
import RoleEditor from "./RoleEditor.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

defineProps<{ persona: WebPersona; opened: boolean }>();
const emit = defineEmits<{ dirty: [value: boolean]; open: []; close: [] }>();
const route = useRoute();
const plugins = useTopic<PluginsSnapshot>("plugins");
const entry = computed(() => flattenPlugins(plugins.data?.tree ?? []).find((item) => !item.group && item.name === "yesimbot-roleplay"));
const view = createRoleEditor(),
  state = view.state;
const fileList = ref<HTMLElement>(),
  starting = ref(false);
const unavailable = computed(() => state.busy || state.loading || !plugins.data?.writable);
/** Fields stay editable while a save runs (later edits queue behind it); only reads lock them. */
const locked = computed(() => state.loading || !plugins.data?.writable);
const cards = computed(() => state.snapshot?.cards ?? []);
const presets = computed(() => state.snapshot?.presets ?? []);
const pictures = computed(() => {
  const card = state.creating ? undefined : cards.value.find((item) => item.id === state.id);
  return card ? { reference: cardPictureUrl(state.path, card, "reference"), turnaround: cardPictureUrl(state.path, card, "turnaround") } : {};
});
/** The open card is the one every platform uses. */
const isDefault = computed(() => !!entry.value?.enabled && state.snapshot?.active === state.id);
let disposed = false,
  queued = false,
  lastTrigger: HTMLElement | undefined,
  pendingPath: string | undefined;
watch(view.dirty, (value) => emit("dirty", value), { immediate: true });
function selectPath(path: string) {
  if (path === state.path) return;
  if (state.path && pluginIdentity(path) === pluginIdentity(state.path)) {
    view.relocate(path);
    if (view.dirty.value) return;
  }
  void view.load(path);
}
watch(
  () => entry.value?.path,
  (path) => {
    if (state.busy) pendingPath = path ?? "";
    else selectPath(path ?? "");
  },
  { immediate: true },
);
watch(
  () => state.busy,
  (busy) => {
    if (!busy && pendingPath !== undefined) {
      const path = pendingPath;
      pendingPath = undefined;
      selectPath(path);
    }
  },
);
let openedFromLink = "";
watch([() => state.snapshot, () => route.query.edit, () => state.loading, () => route.query.document], ([snapshot, edit]) => {
  if (!edit) {
    openedFromLink = "";
    return;
  }
  if (!snapshot || state.loading || route.query.document === "memory" || typeof edit !== "string" || openedFromLink === edit) return;
  openedFromLink = edit;
  if (edit === "@new") void create();
  else void open(edit);
});
async function startRoleplay() {
  if (starting.value || !plugins.data?.revision) return;
  starting.value = true;
  try {
    const result = await addPluginInstance(plugins.data.revision, "yesimbot-roleplay");
    if (result.path) await view.load(result.path);
  } catch (error) {
    toast(pluginError(error), "danger");
  } finally {
    starting.value = false;
  }
}

async function setPicture(key: RoleCardPictureKey, picture: File | null) {
  if (picture && picture.size > ROLE_CARD_PICTURE_MAX_BYTES) {
    state.error = "图片要 PNG、JPEG 或 WebP，5 MB 以内。";
    return;
  }
  if (!picture && !(await confirmDialog({ title: `移除${key === "reference" ? "参考图" : "三视图"}？`, confirmLabel: "移除", danger: true }))) return;
  if (await view.setPicture(key, picture)) toast(picture ? "已保存" : "已移除");
}

function rememberFocus(event: MouseEvent) {
  lastTrigger = (event.target as Element).closest<HTMLElement>("button") ?? lastTrigger;
}

function restoreFocus(event: Event) {
  event.preventDefault();
  const target = lastTrigger?.isConnected ? lastTrigger : fileList.value?.querySelector<HTMLElement>("button:not(:disabled)");
  target?.focus();
}

/** Saves an open card's pending edits before something else takes the editor; an unwritten new card is dropped. */
function settle(): Promise<void> | undefined {
  if (!state.creating && view.dirty.value) return commit();
}

async function open(id: string) {
  if (unavailable.value) return;
  const saving = settle();
  if (saving) await saving;
  if (view.select(id) || (await view.load(state.path, id))) emit("open");
}

async function create() {
  if (unavailable.value) return;
  const saving = settle();
  if (saving) await saving;
  view.create();
  emit("open");
}

async function addPreset(id: string) {
  if (unavailable.value) return;
  const saving = settle();
  if (saving) await saving;
  if (!(await view.addPreset(id))) return;
  toast("已添加");
  emit("open");
}

/** Closing saves what was typed into a card (user, 2026-11-26: 即改即存) and never asks; a new card never created is dropped. */
function close() {
  const dropped = state.creating;
  if (dropped) view.revert();
  else void settle();
  emit("close");
  if (dropped) void view.load();
}

/**
 * Saves the open card's edits with 撤销; a save asked for while one runs follows it. `undo` puts back the values a
 * save replaced, for the same card only.
 */
async function commit(undo?: { id: string; value: typeof state.saved }) {
  if (disposed || state.creating) return;
  if (undo) {
    if (state.id !== undo.id || state.creating) return;
    view.edit(undo.value as unknown as Record<string, unknown>);
  }
  if (!view.dirty.value) return;
  if (state.busy) {
    queued = true;
    return;
  }
  const before = { id: state.id, value: JSON.parse(JSON.stringify(state.saved)) as typeof state.saved };
  const saved = await view.save();
  if (disposed) return;
  if (saved) toast(undo ? "已撤销" : "已保存", "ok", undefined, undo ? undefined : { label: "撤销", run: () => void commit(before) });
  if (queued) {
    queued = false;
    await commit();
  }
}

async function createCard() {
  if (state.creating && (await view.save())) toast("角色卡已创建。");
}

async function setDefault(value: string) {
  if (unavailable.value || entry.value?.locked) return;
  if (value === "@builtin") {
    if (await view.setEnabled(false)) toast("已取消默认");
    return;
  }
  if (!(await view.switchCard(value))) return;
  if (!entry.value?.enabled && !(await view.setEnabled(true))) return;
  toast("已设为默认");
}

async function remove() {
  if (unavailable.value) return;
  if (!(await confirmDialog({ title: `删除「${state.value.name || "未命名角色"}」？`, confirmLabel: "删除", danger: true }))) return;
  if (await view.remove(state.id)) {
    toast("角色卡已删除。");
    emit("close");
  }
}
onBeforeUnmount(() => {
  disposed = true;
  view.dispose();
});
</script>

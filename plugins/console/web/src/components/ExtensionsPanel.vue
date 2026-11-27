<template>
  <div class="grid min-w-0 gap-3">
    <SettingsSubpage :open="!!selected" :title="selected?.name ?? '扩展'" @update:open="(open) => !open && (selectedName = '')">
      <div v-if="selected" class="extension-page">
        <PluginSettings v-if="selected.module" :path="selected.module" head />
        <div class="flex justify-end">
          <Button variant="ghost" size="sm" class="text-destructive" :disabled="busy" @click="remove(selected)">移除扩展</Button>
        </div>
      </div>
    </SettingsSubpage>
    <SettingsGroup title="我的扩展">
      <template #actions
        ><Button variant="outline" size="sm" class="rounded-full" :disabled="busy" data-extension-install @click="setInstallOpen(true)"
          >安装扩展</Button
        ></template
      >
      <GroupRow v-if="!items.length" title="尚未安装扩展" class="text-muted-foreground" />
      <GroupRow
        v-for="item in items"
        :key="item.name"
        :title="item.name"
        :detail="detailOf(item)"
        :icon="Package"
        :clickable="!!item.module"
        :data-extension="item.name"
        @open="selectedName = item.name"
      >
        <template v-if="item.status === 'failed' && !item.module" #below
          ><p class="text-sm break-words text-destructive">{{ extensionError(item.error) }}</p></template
        >
        <Button v-if="item.status === 'failed' && !item.module" variant="ghost" size="sm" :disabled="busy" @click="remove(item)">移除</Button>
      </GroupRow>
    </SettingsGroup>
    <SettingsSubpage :open="installOpen" title="安装扩展" @update:open="setInstallOpen">
      <form id="extension-install" class="install-form" @submit.prevent="install">
        <label class="text-sm" for="extension-name">npm 包名</label>
        <Input id="extension-name" v-model="spec" autocomplete="off" spellcheck="false" autocapitalize="off" required :disabled="busy" />
        <Alert v-if="error" variant="destructive">{{ error }}</Alert>
      </form>
      <template #footer>
        <Button variant="outline" type="button" :disabled="busy" @click="setInstallOpen(false)">取消</Button>
        <Button form="extension-install" :disabled="busy || installing || !spec.trim()" type="submit">{{ installing ? "安装中…" : "安装" }}</Button>
      </template>
    </SettingsSubpage>
  </div>
</template>
<script setup lang="ts">
import { Package } from "reicon-vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import { api } from "../lib/api";
import { confirmDialog } from "../lib/dialog";
import { trackEditor } from "../lib/editor-guard";
import { EXTENSIONS_ENDPOINT as endpoint, extensionError, packageSpec, type ExtensionItem } from "../lib/extensions";
import { toast } from "../lib/toast";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import PluginSettings from "./PluginSettings.vue";
import SettingsSubpage from "./SettingsSubpage.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * 我的扩展 (user, 2026-11-26: 「允许用户自己给自己的实例安装拓展，目前莫名其妙的绑定了koishi的拓展市场」): packages from npm,
 * installed into this instance by its owner or the bot. One field takes `name` or `name@1.2.3`; the install runs on the
 * host and the list follows it. An extension's page is its module's settings, with its switch, and 移除.
 */
const STATUS: Record<ExtensionItem["status"], string> = { installing: "安装中", running: "", disabled: "已停用", waiting: "等待启动", failed: "启动失败" };

const items = ref<ExtensionItem[]>([]);
const selectedName = ref("");
const selected = computed(() => items.value.find((item) => item.name === selectedName.value));
const spec = ref("");
const busy = ref(false);
const error = ref("");
const installOpen = ref(false);
const installing = computed(() => items.value.some((item) => item.status === "installing"));
/** Installs started here: one that went through is said once; one that failed says why on its row. */
const watching = new Set<string>();
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
trackEditor(
  () => installOpen.value && !!spec.value,
  () => busy.value,
);

function detailOf(item: ExtensionItem): string | undefined {
  if (item.status === "installing") return STATUS.installing;
  if (!item.module) return undefined;
  return [item.version, STATUS[item.status]].filter(Boolean).join(" · ");
}

function setInstallOpen(open: boolean) {
  if (busy.value) return;
  installOpen.value = open;
  error.value = "";
  if (!open) spec.value = "";
}

async function refresh() {
  const result = await api<{ items: ExtensionItem[] }>(endpoint, undefined, { fresh: true });
  if (disposed) return;
  for (const item of result.items) {
    if (!watching.has(item.name) || item.status === "installing") continue;
    watching.delete(item.name);
    if (item.module) toast(`已安装「${item.name}」`);
  }
  items.value = result.items;
}

async function poll() {
  try {
    if (document.visibilityState === "visible") await refresh();
  } catch {
    // The next round tries again; the list keeps what it last read.
  } finally {
    if (!disposed) timer = setTimeout(poll, installing.value ? 1000 : 4000);
  }
}

async function install() {
  const { name, version } = packageSpec(spec.value);
  if (disposed || busy.value || installing.value || !name) return;
  busy.value = true;
  error.value = "";
  try {
    await api(endpoint, { action: "install", name, version });
    if (disposed) return;
    watching.add(name);
    installOpen.value = false;
    spec.value = "";
    await refresh();
    await nextTick();
    document.querySelector(`[data-extension="${CSS.escape(name)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    clearTimeout(timer);
    timer = setTimeout(poll, 1000);
  } catch (cause) {
    if (!disposed) error.value = extensionError(cause);
  } finally {
    if (!disposed) busy.value = false;
  }
}

async function remove(item: ExtensionItem) {
  if (disposed || busy.value) return;
  if (item.module && !(await confirmDialog({ title: `移除「${item.name}」？`, message: "它会停用，设置和安装文件一并删除。", confirmLabel: "移除" }))) return;
  if (disposed || busy.value) return;
  busy.value = true;
  try {
    await api(endpoint, { action: "remove", name: item.name });
    if (disposed) return;
    if (selectedName.value === item.name) selectedName.value = "";
    if (item.module) toast(`已移除「${item.name}」`);
    await refresh();
  } catch (cause) {
    if (!disposed) toast(extensionError(cause), "danger");
  } finally {
    if (!disposed) busy.value = false;
  }
}

onMounted(() => void poll());
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>
<style scoped>
.extension-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 28px;
  min-width: 0;
}

.install-form {
  display: grid;
  gap: 8px;
}
</style>

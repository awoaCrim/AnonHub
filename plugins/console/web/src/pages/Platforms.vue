<template>
  <div v-motion="current?.id" class="page grouped platforms">
    <Segmented v-if="tabs.length > 1" :model-value="current?.id ?? ''" :options="tabOptions" label="聊天平台" @update:model-value="selectTab" />
    <TopicFeedback :state="panel" label="平台状态" />

    <template v-if="current">
      <template v-if="known">
        <QQAccount v-if="known.login === 'napcat' && session.state.features.napcat" />
        <PlatformAccount
          v-else
          :key="known.id"
          :platform="known"
          :entries="entries"
          :adapters="adapters"
          :writable="writable"
          :connecting="busy"
          :can-connect="installable.some((item) => item.name === known!.adapter)"
          @connect="connect(known.adapter)"
        />
      </template>
      <template v-else-if="custom">
        <PluginSettings :key="custom.id" :path="custom.entry.path" head />
        <SettingsGroup label="接入">
          <GroupRow :title="`移除${custom.label}`" :icon="Trash2" icon-tone="danger">
            <Button variant="danger" size="sm" type="button" :disabled="busy || !writable || custom.entry.locked" @click="remove(custom)">移除</Button>
          </GroupRow>
        </SettingsGroup>
      </template>

      <section v-if="scopePlatform" id="scope" ref="scopeSection" class="scope" aria-label="回复范围">
        <ReplyScope :key="scopePlatform" :platform="scopePlatform" />
      </section>

      <PlatformAdmins v-if="adminPlatform" :key="adminPlatform" :platform="adminPlatform" />

      <!-- What the bot said here is read on the 对话 page, which lists every conversation. -->
      <SettingsGroup title="外部通知">
        <GroupRow title="通知链接" :icon="Webhook" clickable @open="setNotificationsOpen(true)" />
      </SettingsGroup>
      <SettingsSubpage :open="section === 'notifications'" title="通知" dialog-class="sm:max-w-2xl" @update:open="setNotificationsOpen">
        <BotHooks v-if="section === 'notifications'" :key="historyPlatform" :platform="historyPlatform" @busy="notificationBusy = $event" />
      </SettingsSubpage>
    </template>
    <SettingsGroup v-else-if="panel.data && plugins.data" label="平台">
      <GroupRow title="聊天平台" value="暂无可用" tone="idle" :icon="Plug" />
    </SettingsGroup>
  </div>
</template>
<script setup lang="ts">
import { Plug, Trash2, Link as Webhook } from "reicon-vue";
import { computed, nextTick, ref, watch } from "vue";

import type { PanelPayload } from "../../../src/shared/panel";
import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import BotHooks from "../components/BotHooks.vue";
import GroupRow from "../components/group/GroupRow.vue";
import Segmented from "../components/group/Segmented.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import PlatformAccount from "../components/PlatformAccount.vue";
import PlatformAdmins from "../components/PlatformAdmins.vue";
import PluginSettings from "../components/PluginSettings.vue";
import QQAccount from "../components/QQAccount.vue";
import ReplyScope from "../components/ReplyScope.vue";
import SettingsSubpage from "../components/SettingsSubpage.vue";
import { Button } from "../components/ui/button";
import { useSession } from "../context";
import { ApiError } from "../lib/api";
import { confirmDialog } from "../lib/dialog";
import { vMotion } from "../lib/motion";
import { addPluginInstance, removePluginInstance } from "../lib/plugin-actions";
import { flattenPlugins, pluginError } from "../lib/plugin-config";
import { useRouteState } from "../lib/route-state";
import { toast } from "../lib/toast";
import { useTopic } from "../lib/use-topic";
import { isWebPlatform, platformOfPackage } from "../lib/web-platform";
import TopicFeedback from "../shell/TopicFeedback.vue";
import { customPlatformTabs, customTabId, presentPlatforms, type CustomPlatformTab } from "./platforms-model";

const session = useSession();
const panel = useTopic<PanelPayload | null>("panel");
const plugins = useTopic<PluginsSnapshot>("plugins");
const writable = computed(() => plugins.data?.writable ?? false);
const instances = computed(() => flattenPlugins(plugins.data?.tree ?? []).filter((item) => !item.group));
/** Packages this account may still set up; a platform whose adapter is among them is listed before it is connected. */
const installable = computed(() => plugins.data?.available ?? []);
const knownTabs = computed(() => presentPlatforms(panel.data ?? undefined, instances.value, session.state.features, installable.value));
const customTabs = computed(() => customPlatformTabs(instances.value, panel.data?.adapters ?? []));
const tabs = computed(() => [...knownTabs.value, ...customTabs.value]);

const selected = useRouteState("platform", "");
const tabOptions = computed(() => tabs.value.map((item) => ({ value: item.id, label: item.label })));
const selectTab = (id: string) => (selected.value = id);
// `section=scope` scrolls to 回复范围; `section=notifications` opens 外部通知.
const section = useRouteState("section", "connection");
const notificationBusy = ref(false);
/** A custom tab may be linked with the instance's current path; `~` (disabled) still names the same tab. */
const wanted = computed(() => (selected.value.startsWith("plugin:") ? customTabId(selected.value.slice("plugin:".length)) : selected.value));
const current = computed(() => tabs.value.find((item) => item.id === wanted.value) ?? tabs.value[0]);
const known = computed(() => knownTabs.value.find((item) => item.id === current.value?.id));
const custom = computed(() => customTabs.value.find((item) => item.id === current.value?.id));
const entries = computed(() => instances.value.filter((item) => item.name === known.value?.adapter));
const adapters = computed(() => panel.data?.adapters.filter((item) => item.platform === known.value?.id) ?? []);
const scopePlatform = computed(() => known.value?.id ?? custom.value?.platform ?? "");
/** 管理员 is kept per chat platform; the web chat's owner is always an admin and has no list. */
const adminPlatform = computed(() => (scopePlatform.value && !isWebPlatform(scopePlatform.value) ? scopePlatform.value : ""));
/** Platform ID for 外部通知: the registry ID, or the one a custom adapter reports. */
const historyPlatform = computed(() => known.value?.id ?? custom.value?.platform ?? "");

const scopeSection = ref<HTMLElement>();
watch(
  [section, () => current.value?.id],
  async ([value]) => {
    if (value !== "scope") return;
    await nextTick();
    scopeSection.value?.scrollIntoView({ block: "start" });
  },
  { immediate: true },
);
function setNotificationsOpen(open: boolean) {
  if (!open && notificationBusy.value) return;
  if (open !== (section.value === "notifications")) section.value = open ? "notifications" : "connection";
}

const busy = ref(false);
/** First setup of a listed platform: its connection is created switched off, ready to fill in. */
async function connect(name: string) {
  const revision = plugins.data?.revision;
  if (busy.value || !revision) return;
  busy.value = true;
  try {
    await addPluginInstance(revision, name);
    toast(`已开始接入${platformOfPackage(name)?.label ?? ""}。填好设置后启用连接即可使用。`);
  } catch (error) {
    toast(addRemoveError(error), "danger");
  } finally {
    busy.value = false;
  }
}

async function remove(tab: CustomPlatformTab) {
  const revision = plugins.data?.revision;
  if (busy.value || !revision || tab.entry.locked) return;
  const ok = await confirmDialog({
    title: `移除${tab.label}？`,
    message: "会删除这个平台接入和它的设置，机器人不再从这里收发消息。已有的聊天记录会保留。",
    confirmLabel: "移除",
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  try {
    await removePluginInstance(revision, tab.entry.path);
    if (current.value?.id === tab.id) selected.value = "";
    toast(`已移除${tab.label}。`);
  } catch (error) {
    toast(addRemoveError(error), "danger");
  } finally {
    busy.value = false;
  }
}

/** The plugin list changed under us: the live catalog catches up within moments, so trying again works. */
const addRemoveError = (error: unknown) =>
  error instanceof ApiError && error.code === "config_changed" ? "设置刚刚有变化，请稍后再试一次。" : pluginError(error);
</script>
<style scoped>
.scope {
  scroll-margin-top: 24px;
}
</style>

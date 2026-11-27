<template>
  <div class="page computer">
    <Alert v-if="error" variant="destructive" as="p" role="alert">{{ error }} <Button variant="outline" size="sm" @click="refresh">重试</Button></Alert>
    <Card class="gap-0 p-5 max-sm:p-4" as-child v-if="available === false"
      ><section class="card empty-state">
        <h3>设备连接尚未配置</h3>
        <p>内置沙箱仍可使用。接入自己的电脑前，请让服务管理员配置设备网关。</p>
      </section></Card
    >
    <template v-else>
      <Card v-if="workspace && defaults.state.config" class="gap-4 p-5 max-sm:p-4">
        <label class="grid gap-2"
          ><span class="text-base font-semibold">默认工作电脑</span>
          <PickerMenu
            field
            :model-value="defaultId"
            :options="defaultOptions"
            :disabled="available !== true || defaults.state.busy || !plugins.data?.writable || workspace.locked"
            @update:model-value="chooseDefault"
          />
        </label>
        <p class="text-sm text-muted-foreground">
          未绑定电脑时使用内置沙箱。选定电脑后，文件与操作都在该电脑中进行；离线时等待恢复，不会自动换。需要时 bot
          可以自己换到另一台在线的电脑，这里会显示，你再选一次就以你的为准。
        </p>
        <div v-if="botSwitch && botSwitch.deviceId !== defaultId" class="flex flex-wrap items-center gap-3 text-sm">
          <span
            >bot 在 {{ formatTime(botSwitch.switchedAt) }} 自己换到了 <strong>{{ switchedName }}</strong
            >，现在所有对话都用这台。</span
          >
          <Button variant="outline" size="sm" :disabled="switchBusy || !plugins.data?.writable || workspace.locked" @click="clearSwitch(true)"
            >改回默认电脑</Button
          >
        </div>
        <Alert v-if="available === true && defaultId && !computers.some((device) => device.deviceId === defaultId)" variant="warn"
          >原选中的电脑当前不可用，请重新选择已接入的电脑。</Alert
        >
        <Alert v-else-if="available === true && defaultId && computers.find((device) => device.deviceId === defaultId)?.online === false" variant="warn"
          >默认电脑已离线，恢复连接前不能在这台电脑上执行任务。</Alert
        >
      </Card>
      <Card class="gap-0 overflow-hidden p-0" as-child
        ><section class="card flush inventory" aria-labelledby="my-computers">
          <CardHeader as="div" class="card-head m-0 flex flex-wrap items-center justify-between gap-3 px-5 py-4 max-sm:px-4">
            <div>
              <h2 id="my-computers">
                我的电脑 <span v-if="computers.length > 1" class="muted count">{{ computers.length }}</span>
              </h2>
              <p>在电脑上运行客户端并配对后，它就能在你允许的地方用这台电脑。</p>
            </div>
            <Button variant="default" size="sm" :disabled="available !== true" @click="openBinding">接入新电脑</Button>
          </CardHeader>
          <div v-if="available === undefined && !error" class="loading">
            <Skeleton v-for="n in 2" :key="n" class="skeleton" style="height: 44px"></Skeleton>
          </div>
          <p v-else-if="available === true && !computers.length" class="empty-state">
            还没有接入电脑。点击「接入新电脑」开始配对，支持 Windows、macOS 和 Linux。
          </p>
          <ul v-if="computers.length" class="devices" aria-label="已接入的电脑">
            <li v-for="device in computers" :key="device.deviceId" class="device">
              <span class="device-icon" aria-hidden="true"><Icon name="device" /></span>
              <div class="device-main">
                <div class="device-line">
                  <h3>{{ device.name }}</h3>
                  <span class="muted os"
                    >{{ devicePlatformName(device.platform)
                    }}<template v-if="device.version">
                      · 客户端 {{ device.version }}{{ device.features?.includes("auto-update") ? "，自动更新" : "" }}</template
                    ></span
                  >
                  <Badge :variant="badgeTone(device.online ? 'ok' : 'warn')" as="span">{{ onlineLabel(device.online) }}</Badge>
                  <Badge v-if="device.deviceId === defaultId && computers.length > 1" variant="secondary" as="span">默认</Badge>
                  <Badge v-if="device.deviceId === botSwitch?.deviceId && device.deviceId !== defaultId" variant="secondary" as="span">bot 正在用</Badge>
                </div>
                <div class="chips">
                  <span
                    v-for="capability in device.capabilities"
                    :key="capability"
                    class="chip"
                    :class="{ warn: device.online && device.health?.[capability] === false }"
                    >{{ CAPABILITY_NAMES[capability] }}{{ device.online && device.health?.[capability] === false ? " · 未就绪" : "" }}</span
                  >
                </div>
                <Alert v-if="updateNeeded(device)" variant="warn" class="update">
                  <p v-if="updateNeeded(device) === 'screen'">
                    <strong>客户端需要更新</strong>，更新后才能在「<RouterLink :to="{ path: pages.home.path, query: { panel: 'computer' } }">对话</RouterLink
                    >」旁边看到它的屏幕，以后也会自己更新。{{ installHint(device) }}
                  </p>
                  <p v-else><strong>再手动更新一次客户端</strong>，以后它就会自己更新。{{ installHint(device) }}</p>
                  <div v-if="downloads" class="downloads">
                    <a
                      v-for="release in releasesFor(device)"
                      :key="release.platform"
                      :class="buttonVariants({ variant: 'outline', size: 'sm' })"
                      :href="release.url"
                      download
                      >{{ releaseLabel(release) }} <small>{{ formatBytes(release.size) }}</small></a
                    >
                  </div>
                </Alert>
              </div>
              <div class="device-actions">
                <Button variant="ghost" size="sm" aria-haspopup="dialog" @click="openDetails(device.deviceId)"> 详情 </Button>
                <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" :disabled="busy" @click="confirmRevoke(device)"
                  >撤销授权</Button
                >
              </div>
            </li>
          </ul>
        </section></Card
      >
      <Card class="gap-0 p-5 max-sm:p-4" as-child v-if="plugins.data && !workspace?.enabled"
        ><section class="card enable">
          <div>
            <h3>让它用电脑和工作区</h3>
            <p class="muted">开启后，它就能用上面接入的电脑和自己的工作区。</p>
          </div>
          <Button variant="default" :disabled="enabling || !plugins.data.writable" @click="enableWorkspace">{{ enabling ? "开启中…" : "开启" }}</Button>
        </section></Card
      >

      <p v-if="workspace?.enabled" class="muted small">电脑能力由系统按平台适配，敏感工具只有管理员能让机器人调用。本机客户端的授权仍需单独确认。</p>
    </template>
    <SettingsSubpage v-model:open="bindingOpen" title="接入新电脑" dialog-class="sm:max-w-3xl">
      <ComputerBinding v-if="bindingOpen" />
    </SettingsSubpage>
    <SettingsSubpage
      :open="!!detailDevice"
      :title="detailDevice?.name ?? '设备详情'"
      :description="detailDevice ? devicePlatformName(detailDevice.platform) : undefined"
      dialog-class="sm:max-w-lg"
      @update:open="!$event && (shownDetails = '')"
    >
      <template v-if="detailDevice">
        <SettingsGroup label="设备详情">
          <GroupRow title="设备 ID" :detail="detailDevice.deviceId" class="break-all" />
        </SettingsGroup>
        <p class="text-sm text-muted-foreground">桌面操作和命令行拥有这台电脑当前登录用户的权限。</p>
      </template>
    </SettingsSubpage>
  </div>
</template>
<script setup lang="ts">
import type { DeviceView } from "@yesimbot/contracts";
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";

import type { PluginsSnapshot } from "../../../src/shared/plugin-config";
import ComputerBinding from "../components/ComputerBinding.vue";
import GroupRow from "../components/group/GroupRow.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import PickerMenu from "../components/PickerMenu.vue";
import SettingsSubpage from "../components/SettingsSubpage.vue";
import { Alert } from "../components/ui/alert";
import { Badge, badgeTone } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { CardHeader } from "../components/ui/card";
import { Card } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api";
import { loadClientDownloads, releaseLabel, type ClientDownloads } from "../lib/client-downloads";
import { hasDesktop } from "../lib/computer-screen";
import { CAPABILITY_NAMES, devicePlatformName, isWorkspaceDevice, loadDevices, type DeviceList } from "../lib/devices";
import { confirmDialog } from "../lib/dialog";
import { setFeatureEnabled } from "../lib/features";
import { formatBytes, formatTime, onlineLabel } from "../lib/format";
import { addPluginInstance } from "../lib/plugin-actions";
import { flattenPlugins, pluginError } from "../lib/plugin-config";
import { toast } from "../lib/toast";
import { useTopic } from "../lib/use-topic";
import { pages } from "../nav";
import Icon from "../shell/Icon.vue";
import { createConfigFieldsEditor } from "../state/config-fields";

/**
 * 设置 → 电脑: one list of the bound computers (the default one marked and chosen right there), how to bind
 * another. Workspace selection is automatic; declarations determine tool availability.
 */
const devices = ref<DeviceView[]>([]),
  /** The computer the bot switched to itself, until the owner chooses again. */
  botSwitch = ref<DeviceList["botSwitch"]>(),
  available = ref<boolean>(),
  error = ref(""),
  busy = ref(false),
  shownDetails = ref("");
/** Pairing and device details leave the inventory visible as an overview. */
const bindingOpen = ref(false);
function openBinding() {
  bindingOpen.value = true;
}
function openDetails(deviceId: string) {
  shownDetails.value = deviceId;
}
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
async function refresh(fresh = true) {
  try {
    const result = await loadDevices(fresh);
    if (!disposed) {
      available.value = result.available;
      devices.value = result.devices;
      botSwitch.value = result.botSwitch;
      error.value = "";
    }
  } catch {
    if (!disposed) error.value = "暂时无法读取电脑状态，请稍后重试。";
  }
}
async function revoke(deviceId: string) {
  busy.value = true;
  try {
    await api("/yesimbot/api/v1/devices/revoke", { deviceId });
    // The response carries no row: drop the revoked device locally. The poll reconciles the rest.
    if (!disposed) devices.value = devices.value.filter((device) => device.deviceId !== deviceId);
  } catch {
    toast("撤销失败，请重试。", "danger");
  } finally {
    busy.value = false;
  }
}
async function confirmRevoke(device: DeviceView) {
  if (await confirmDialog({ title: `撤销 ${device.name} 的授权？`, message: "撤销后立即断开，重新使用需要再次配对。", confirmLabel: "撤销授权", danger: true }))
    await revoke(device.deviceId);
}
const computers = computed(() => devices.value.filter((device) => !device.revokedAt && isWorkspaceDevice(device)));
const detailDevice = computed(() => computers.value.find((device) => device.deviceId === shownDetails.value));
/**
 * An online client that predates the screen view (with a desktop), or that cannot update itself yet: one
 * manual update, after which it keeps itself current. An older gateway sends no features at all.
 */
function updateNeeded(device: DeviceView): "screen" | "auto" | undefined {
  if (!device.online || !Array.isArray(device.features)) return;
  if (hasDesktop(device) && !device.features.includes("screen-view")) return "screen";
  if (!device.features.includes("auto-update")) return "auto";
}
const installHint = (device: DeviceView) =>
  `${device.platform === "win32" ? "下载新版后运行里面的 Install.cmd" : "下载新版解压，用原来的命令启动"}，不用重新配对。`;
const downloads = ref<ClientDownloads>();
/** The package for the computer's own system; every package when it is not one we build for. */
function releasesFor(device: DeviceView) {
  const all = downloads.value?.releases ?? [];
  const want = device.platform === "win32" ? "windows-x64" : device.platform === "darwin" || device.platform === "linux" ? "portable" : "";
  const match = all.filter((release) => release.platform === want);
  return match.length ? match : all;
}
let downloadsAsked = false;
watch(computers, (list) => {
  if (downloadsAsked || !list.some(updateNeeded)) return;
  downloadsAsked = true;
  loadClientDownloads()
    .then((result) => !disposed && (downloads.value = result))
    .catch(() => {});
});
const plugins = useTopic<PluginsSnapshot>("plugins");
const workspace = computed(() => flattenPlugins(plugins.data?.tree ?? []).find((item) => !item.group && item.name === "yesimbot-workspace"));
/** The default computer (the workspace's `computer.deviceId`), saved the moment one is chosen. */
const defaults = createConfigFieldsEditor(["computer"], { savedNotice: "" });
onBeforeUnmount(defaults.dispose);
watch(
  () => workspace.value?.path ?? "",
  (path) => void defaults.load(path),
  { immediate: true },
);
const defaultId = computed(() => ((defaults.state.saved.computer ?? {}) as { deviceId?: string }).deviceId ?? "");
const defaultOptions = computed(() => [
  { value: "", label: "使用内置沙箱" },
  ...(defaultId.value && !computers.value.some((device) => device.deviceId === defaultId.value)
    ? [{ value: defaultId.value, label: available.value === undefined ? "原选中的电脑（正在读取状态）" : "原选中的电脑（当前不可用）", disabled: true }]
    : []),
  ...computers.value.map((device) => ({ value: device.deviceId, label: `${device.name} · ${onlineLabel(device.online)}` })),
]);
const switchedName = computed(
  () =>
    computers.value.find((device) => device.deviceId === botSwitch.value?.deviceId)?.name ??
    (available.value === undefined ? "另一台电脑" : "一台当前不可用的电脑"),
);
const switchBusy = ref(false);
/** The owner's choice replaces the bot's own switch; only that line changes on success. */
async function clearSwitch(notify = false): Promise<void> {
  if (switchBusy.value || !botSwitch.value) return;
  switchBusy.value = true;
  try {
    await api("/yesimbot/api/v1/devices/switch/clear", {});
    if (disposed) return;
    botSwitch.value = undefined;
    if (notify) toast("已改回默认电脑。");
  } catch {
    if (!disposed) toast("没能改回默认电脑，请重试。", "danger");
  } finally {
    switchBusy.value = false;
  }
}
async function chooseDefault(deviceId: string) {
  if (
    (deviceId && !computers.value.some((device) => device.deviceId === deviceId)) ||
    defaults.state.busy ||
    !plugins.data?.writable ||
    workspace.value?.locked
  )
    return;
  defaults.set(["computer"], { ...((defaults.state.value.computer ?? {}) as Record<string, unknown>), deviceId });
  if (await defaults.save()) {
    // Choosing again, even the same computer, overrides a switch the bot made itself.
    await clearSwitch();
    toast("默认电脑已更新，新任务按此设置执行。");
  } else toast(defaults.state.error || "没能设为默认，请重试。", "danger");
}
const enabling = ref(false);
/** Turns the computer feature on; created first if this bot never had it. */
async function enableWorkspace() {
  const revision = plugins.data?.revision;
  if (enabling.value || !revision) return;
  enabling.value = true;
  try {
    let target: { path: string } | undefined = workspace.value;
    let current = revision;
    if (!target) {
      const added = await addPluginInstance(revision, "yesimbot-workspace");
      target = added.path ? { path: added.path } : undefined;
      current = added.revision;
    }
    if (target) await setFeatureEnabled(current, target, true);
    toast("已开启电脑和工作区。");
  } catch (error) {
    toast(pluginError(error), "danger");
  } finally {
    enabling.value = false;
  }
}
async function poll() {
  if (!document.hidden) await refresh();
  if (!disposed) timer = setTimeout(poll, 10000);
}
onMounted(async () => {
  await refresh(false);
  if (!disposed) timer = setTimeout(poll, 10000);
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>
<style scoped>
@reference "../styles/app.css";

.count {
  @apply font-normal;
  margin-left: 4px;
}
.loading {
  display: grid;
  gap: 12px;
  padding: 16px 20px;
}
.inventory > .empty-state {
  @apply border-t border-border;
}
.devices {
  margin: 0;
  padding: 0;
  list-style: none;
}
.device {
  @apply border-t border-border;
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 16px 20px;
}
.device-icon {
  @apply rounded-md bg-muted text-subtle;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: none;
}
.device-main {
  display: grid;
  flex: 1;
  gap: 8px;
  min-width: 0;
}
.device-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-height: 24px;
}
.device-line h3 {
  @apply text-base;
  overflow-wrap: anywhere;
}
.os {
  @apply text-sm;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  @apply rounded-full bg-muted text-subtle text-xs;
  padding: 4px 8px;
}
.chip.warn {
  @apply bg-warn-soft text-warn;
}
.device-actions {
  display: flex;
  flex: none;
  gap: 4px;
}
.details,
.confirm {
  @apply text-sm;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  margin: 0;
}
.details p {
  margin: 0;
}
.confirm .muted {
  flex: 1 1 220px;
}
.device-id {
  @apply font-mono text-xs;
  overflow-wrap: anywhere;
  user-select: all;
}
.update {
  @apply text-sm;
  display: grid;
  gap: 12px;
  margin: 0;
}
.update p {
  margin: 0;
}
.downloads {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.downloads small {
  @apply font-normal;
  opacity: 0.75;
}
.foot {
  @apply border-t border-border;
  margin: 0;
  padding: 12px 20px;
}
.enable {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px 20px;
  flex-wrap: wrap;
}
.enable > div {
  flex: 1 1 320px;
}
.enable h3 {
  @apply text-base;
}
.enable p {
  @apply text-sm;
  margin: 4px 0 0;
}
.small {
  @apply text-sm;
}
@media (max-width: 640px) {
  .device {
    flex-wrap: wrap;
    padding: 16px 16px;
  }
  .device-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .foot {
    padding: 12px 16px;
  }
}
</style>

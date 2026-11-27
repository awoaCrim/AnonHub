<template>
  <section class="bind" aria-label="接入新电脑步骤">
    <ol class="steps">
      <li>
        <span class="step-index">1</span>
        <div class="step-body">
          <strong>下载并安装客户端</strong>
          <div v-if="downloads" class="downloads">
            <a
              v-for="release in downloads.releases"
              :key="release.platform"
              :class="buttonVariants({ variant: release.platform === 'windows-x64' ? 'default' : 'outline' })"
              :href="release.url"
              download
              >{{ releaseLabel(release) }} <small>{{ formatBytes(release.size) }}</small></a
            >
          </div>
          <p v-else-if="downloadsLoading" class="muted">正在读取下载信息…</p>
          <p v-else class="muted">暂时无法读取客户端下载。<Button variant="outline" size="sm" @click="loadDownloads">重试</Button></p>
          <div v-if="downloads" class="stack details">
            <p>Windows：解压后双击 Install.cmd。macOS / Linux 需要 Node.js 22.16+，在解压目录打开终端运行：</p>
            <code class="command">node client.cjs ui --state ~/.yesimbot-device --open</code>
            <p>工作区文件可以直接使用；桌面和浏览器操作需要在本机配置对应服务。</p>
          </div>
        </div>
      </li>
      <li>
        <span class="step-index">2</span>
        <div class="step-body">
          <strong>生成一次性配对码</strong>
          <div v-if="pairing" class="pairing">
            <Input class="mono code" :value="pairing.code" readonly aria-label="一次性配对码" />
            <Button variant="outline" @click="copyCode">{{ copied ? "已复制" : "复制" }}</Button>
            <span class="muted">有效期至 {{ formatTime(pairing.expiresAt, "clock") }}</span>
          </div>
          <div>
            <Button :variant="pairing ? 'outline' : 'default'" :disabled="busy" @click="pair">
              {{ pairing ? "重新生成" : "生成配对码" }}
            </Button>
          </div>
        </div>
      </li>
      <li>
        <span class="step-index">3</span>
        <div class="step-body">
          <strong>在客户端里填写网关地址和配对码</strong>
          <label v-if="downloads?.gateway" class="field gateway"
            >网关地址<Input class="mono" :value="downloads.gateway" readonly aria-label="客户端网关地址"
          /></label>
          <p class="muted">在本机设置页选择要开放的能力。关闭页面后客户端仍保持连接，绑定成功后会出现在上方列表。</p>
        </div>
      </li>
    </ol>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

import { api } from "../lib/api";
import { loadClientDownloads, releaseLabel, type ClientDownloads } from "../lib/client-downloads";
import { formatBytes, formatTime } from "../lib/format";
import { toast } from "../lib/toast";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";

/** The three steps that bind a new computer: download the client, get a pairing code, enter it with the gateway address. */
const downloads = ref<ClientDownloads>(),
  downloadsLoading = ref(false),
  busy = ref(false),
  copied = ref(false),
  pairing = ref<{ code: string; expiresAt: number }>();
let disposed = false;
async function loadDownloads() {
  downloadsLoading.value = true;
  try {
    const result = await loadClientDownloads();
    if (!disposed) downloads.value = result;
  } catch {
    if (!disposed) downloads.value = undefined;
  } finally {
    if (!disposed) downloadsLoading.value = false;
  }
}
async function pair() {
  busy.value = true;
  copied.value = false;
  try {
    pairing.value = await api("/yesimbot/api/v1/devices/pair", {});
  } catch {
    toast("配对码生成失败，请确认设备连接服务可用。", "danger");
  } finally {
    busy.value = false;
  }
}
async function copyCode() {
  if (!pairing.value) return;
  try {
    await navigator.clipboard.writeText(pairing.value.code);
    copied.value = true;
  } catch {
    toast("无法自动复制，请选中配对码手动复制。", "danger");
  }
}
void loadDownloads();
onBeforeUnmount(() => {
  disposed = true;
  pairing.value = undefined;
});
</script>
<style scoped>
@reference "../styles/app.css";

.bind {
  scroll-margin-top: 72px;
}
.bind h2 {
  @apply text-base;
}
.bind h2 [data-slot="badge"] {
  margin-left: 8px;
  vertical-align: 2px;
}
.details {
  @apply text-sm;
  margin-top: 12px;
}
.steps {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.steps li {
  @apply border-t border-border;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 16px;
  padding: 16px 0;
}
.steps li:first-child {
  border-top: 0;
  padding-top: 4px;
}
.step-index {
  @apply rounded-full bg-brand-soft text-brand-text text-sm font-semibold;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
}
.step-body {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.downloads,
.pairing {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.downloads small {
  @apply font-normal;
  opacity: 0.75;
}
.code {
  @apply text-base;
  width: 200px;
  letter-spacing: 0.08em;
}
.gateway {
  max-width: 460px;
}
.command {
  @apply rounded-md bg-code text-code-foreground;
  display: block;
  padding: 8px 12px;
  overflow-wrap: anywhere;
}
</style>

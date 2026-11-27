<template>
  <div v-if="core" class="grid min-w-0 gap-7">
    <TopicFeedback :state="subscription.state" label="管理员" />
    <SettingsGroup title="管理员">
      <template v-if="config" #actions>
        <Button variant="outline" size="sm" type="button" :disabled="busy || !writable" @click="openAdd">添加</Button>
      </template>
      <div v-if="!config" class="p-2">
        <Alert v-if="error" variant="destructive" as="p" role="alert"
          >{{ error }} <Button variant="outline" size="sm" :disabled="busy" @click="load()">重试读取</Button></Alert
        >
        <Skeleton v-else class="h-10" aria-busy="true" />
      </div>
      <template v-else>
        <GroupRow v-for="id in ids" :key="id" :title="nameOf(id) || id" :detail="nameOf(id) ? id : undefined" :icon="UserRound">
          <Button variant="ghost" size="icon-sm" class="remove" type="button" :aria-label="`移除管理员 ${id}`" :disabled="busy || !writable" @click="remove(id)"
            ><X
          /></Button>
        </GroupRow>
        <GroupRow v-if="!ids.length" title="管理员" value="尚未添加" tone="warn" :icon="UserRound" />
      </template>
    </SettingsGroup>
    <SettingsSubpage :open="adding" title="添加管理员" dialog-class="sm:max-w-md" @update:open="setAdding">
      <form :id="formId" class="grid gap-4" @submit.prevent="add">
        <label class="grid gap-2 text-sm">
          <span>管理员账号</span>
          <SuggestInput v-model="draft" class="control mono-input" label="好友" :options="contactOptions" :placeholder="placeholder" />
        </label>
        <p v-if="problem" class="problem" role="alert">{{ problem }}</p>
      </form>
      <template #footer>
        <Button variant="outline" type="button" :disabled="busy" @click="setAdding(false)">取消</Button>
        <Button type="submit" :form="formId" :disabled="busy || !writable || !draft.trim()">添加</Button>
      </template>
    </SettingsSubpage>
  </div>
</template>
<script setup lang="ts">
import { platformDefinition } from "@yesimbot/contracts/platforms";
import { User as UserRound, X } from "reicon-vue";
import { computed, onUnmounted, ref, watch } from "vue";

import type { ContactEntry, ContactsResponse } from "../../../src/shared/contacts";
import type { PluginConfigSnapshot, PluginsSnapshot } from "../../../src/shared/plugin-config";
import { useLive } from "../context";
import { api, ApiError } from "../lib/api";
import { onCacheRefresh } from "../lib/cache";
import type { PickerOption } from "../lib/picker";
import { checkAdminId, platformAdminIds, readAdmins, withAdmin, withoutAdmin } from "../lib/platform-admins";
import { flattenPlugins, pluginError, pluginIdentity } from "../lib/plugin-config";
import { toast, toastErrors } from "../lib/toast";
import TopicFeedback from "../shell/TopicFeedback.vue";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import SettingsSubpage from "./SettingsSubpage.vue";
import SuggestInput from "./SuggestInput.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

/**
 * The core plugin's 管理员 (`admins`) for one chat platform. Each add or remove is applied to the latest
 * saved list and saved at once, so a stale page never overwrites someone else's change and the other
 * platforms' entries are kept as they are. The saved list is only ever updated in place.
 */
const props = defineProps<{ platform: string }>();
const subscription = useLive().use<PluginsSnapshot>("plugins");
const formId = `admin-add-${props.platform}`;
let disposed = false,
  generation = 0;
const core = computed(() => flattenPlugins(subscription.state.data?.tree ?? []).find((v) => v.name === "yesimbot" && !v.group));
const writable = computed(() => !!subscription.state.data?.writable);
const config = ref<PluginConfigSnapshot>(),
  saved = ref<unknown[]>([]),
  draft = ref(""),
  problem = ref(""),
  error = ref(""),
  busy = ref(false),
  adding = ref(false);
toastErrors(
  error,
  () => (error.value = ""),
  () => !config.value,
  () => busy.value,
);
const ids = computed(() => platformAdminIds(saved.value, props.platform));
const placeholder = computed(() => platformDefinition(props.platform)?.ids.direct ?? "账号");
const contacts = ref<(ContactEntry & { platform: string })[]>([]);
void api<ContactsResponse>("/yesimbot/api/v1/bot/contacts")
  .then((result) => (contacts.value = result.bots.flatMap((bot) => bot.contacts.map((contact) => ({ ...contact, platform: bot.platform })))))
  .catch(() => {});
const friends = computed(() => contacts.value.filter((entry) => entry.platform === props.platform && entry.direct));
const bare = (channelId: string) => channelId.replace(/^private:/, "");
const nameOf = (id: string) => friends.value.find((entry) => bare(entry.channelId) === id)?.name;
const contactOptions = computed<PickerOption[]>(() =>
  friends.value.map((entry) => ({ value: bare(entry.channelId), label: entry.name, note: bare(entry.channelId) })),
);

onUnmounted(() => {
  disposed = true;
  generation++;
  subscription.release();
});
// Declared before the immediate watch below, which loads at once.
const current = (path: string, token: number) => !disposed && token === generation && core.value?.path === path;
const readConfig = (path: string) => api<PluginConfigSnapshot>(`/yesimbot/api/v1/plugins/config?path=${encodeURIComponent(path)}`, undefined, { fresh: true });
onUnmounted(
  onCacheRefresh((path) => {
    if (core.value && !busy.value && path.endsWith(`config?path=${encodeURIComponent(core.value.path)}`)) void load();
  }),
);
watch(
  () => core.value?.path,
  (path, previous) => {
    generation++;
    busy.value = false;
    if (path && previous && config.value && pluginIdentity(path) === pluginIdentity(previous)) {
      void load();
      return;
    }
    config.value = undefined;
    saved.value = [];
    error.value = problem.value = "";
    void load();
  },
  { immediate: true, flush: "sync" },
);

async function load() {
  if (disposed || busy.value) return;
  const path = core.value?.path,
    token = ++generation;
  if (!path) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await readConfig(path);
    if (!current(path, token)) return;
    config.value = result;
    saved.value = readAdmins(result.config.admins);
  } catch (e) {
    if (current(path, token)) error.value = pluginError(e);
  } finally {
    if (current(path, token)) busy.value = false;
  }
}

/** Applies `change` to the newest saved list; a changed revision is re-read and retried. */
async function commit(change: (list: unknown[]) => unknown[], done: string) {
  if (disposed || busy.value || !core.value || !writable.value) return false;
  const path = core.value.path,
    token = ++generation;
  busy.value = true;
  error.value = "";
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await readConfig(path);
      if (!current(path, token)) return false;
      const next = change(readAdmins(latest.config.admins));
      const merged = { ...latest.config, admins: next };
      try {
        const result = await api<{ revision: string }>("/yesimbot/api/v1/plugins/update", { revision: latest.revision, path, config: merged });
        if (!current(path, token)) return false;
        latest.revision = result.revision;
        latest.config = merged;
        config.value = latest;
        saved.value = next;
        toast(done);
        return true;
      } catch (e) {
        if (!current(path, token)) return false;
        if (e instanceof ApiError && e.code === "config_changed" && attempt < 2) continue;
        throw e;
      }
    }
  } catch (e) {
    if (current(path, token)) error.value = pluginError(e);
  } finally {
    if (current(path, token)) busy.value = false;
  }
  return false;
}

async function add() {
  const checked = checkAdminId(props.platform, draft.value, ids.value);
  if ("error" in checked) {
    problem.value = checked.error;
    return;
  }
  problem.value = "";
  if (await commit((list) => withAdmin(list, props.platform, checked.id), "已添加管理员。")) {
    draft.value = "";
    adding.value = false;
  }
}
function openAdd() {
  draft.value = problem.value = "";
  adding.value = true;
}
function setAdding(open: boolean) {
  if (!open && busy.value) return;
  adding.value = open;
}

function remove(id: string) {
  problem.value = "";
  void commit((list) => withoutAdmin(list, props.platform, id), "已移除管理员。");
}
</script>
<style scoped>
@reference "../styles/app.css";

.remove {
  @apply text-muted-foreground;
}
.remove:hover:not(:disabled) {
  @apply text-destructive;
}
.problem {
  @apply text-sm text-destructive;
  margin: 0;
}
</style>

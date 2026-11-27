<template>
  <SettingsGroup title="模型服务">
    <template #actions>
      <Button variant="outline" size="sm" :disabled="!editable" @click="startConnection">添加服务</Button>
    </template>
    <label v-if="(state.draft?.connections.length ?? 0) > SEARCH_FROM" class="search-field"
      ><span class="sr-only">搜索服务</span
      ><Input
        v-model="state.query"
        type="search"
        class="rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile"
        placeholder="搜索名称或协议"
    /></label>
    <div v-if="!state.draft && state.loading" class="grid gap-2 p-2"><Skeleton v-for="n in 2" :key="n" class="h-10" /></div>
    <div v-else-if="!state.draft" class="state-line">
      <span>尚未读取模型服务</span>
      <Button variant="outline" size="sm" @click="view.reload(true)">重试读取</Button>
    </div>
    <template v-else-if="view.connections.value.length">
      <GroupRow
        v-for="connection in view.connections.value"
        :key="connection.key"
        :title="connectionName(connection)"
        :detail="empty(connection) ? '没有模型，也没有启用' : connectionSubtitle(connection)"
        clickable
        @open="selectConnection(connection.key)"
      >
        <template #icon><ProtocolMark :type="connection.type" large /></template>
        <Switch
          :model-value="connection.enabled"
          :aria-label="`${connection.enabled ? '停用' : '启用'}${connectionName(connection)}`"
          :disabled="!editable"
          @update:model-value="enable(connection, $event)"
        />
      </GroupRow>
    </template>
    <div v-else class="state-line">
      <span>{{ state.query ? "没有匹配的服务" : "还没有模型服务" }}</span>
      <Button v-if="state.query" variant="outline" size="sm" @click="state.query = ''">清除搜索</Button>
      <Button v-else size="sm" :disabled="!editable" @click="startConnection">添加服务</Button>
    </div>
  </SettingsGroup>
  <SettingsSubpage
    :open="mobileEditor && !!(creating || selected)"
    :title="creating ? '添加服务' : selected ? connectionName(selected) : '模型服务'"
    dialog-class="sm:max-w-4xl"
    @update:open="(open) => !open && closeConnection()"
  >
    <SettingsGroup v-if="selected && !creating" label="服务状态">
      <GroupRow title="启用此服务" :icon="Power">
        <Switch :model-value="selected.enabled" aria-label="启用此服务" :disabled="!editable" @update:model-value="enable(selected, $event)" />
      </GroupRow>
    </SettingsGroup>
    <ConnectionEditor embedded />
    <template v-if="creating" #footer>
      <Button variant="outline" type="button" :disabled="adding" @click="closeConnection">取消</Button>
      <Button type="button" :disabled="adding || !editable || !(creating.baseURL.trim() || creating.apiKey?.trim())" @click="add">
        {{ adding ? "正在添加…" : "添加" }}
      </Button>
    </template>
  </SettingsSubpage>
</template>

<script setup lang="ts">
import { Power } from "reicon-vue";
import { inject, ref } from "vue";

import type { ModelSettingsConnection } from "../../../../src/model-settings-types";
import { connectionName } from "../../state/model-settings-state";
import { connectionSubtitle, MODELS_PAGE } from "../../state/models-page";
import GroupRow from "../group/GroupRow.vue";
import SettingsGroup from "../group/SettingsGroup.vue";
import SettingsSubpage from "../SettingsSubpage.vue";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import ConnectionEditor from "./ConnectionEditor.vue";
import ProtocolMark from "./ProtocolMark.vue";

/** The list stays an overview; each service opens as its own page (a dialog outside the 设置 window). */
const SEARCH_FROM = 6;
const { view, state, selected, creating, editable, selectConnection, closeConnection, startConnection, addConnection, setConnection, mobileEditor } =
  inject(MODELS_PAGE)!;
const adding = ref(false);
const empty = (connection: ModelSettingsConnection) =>
  !connection.enabled && !connection.chatModels.length && !connection.embeddingModels.length && !connection.imageModels?.length;
function enable(connection: ModelSettingsConnection, on: boolean) {
  if (editable.value) void setConnection(connection, `${on ? "启用" : "停用"} ${connectionName(connection)}`, "enabled", on);
}

async function add() {
  if (adding.value) return;
  adding.value = true;
  try {
    await addConnection();
  } finally {
    adding.value = false;
  }
}
</script>

<style scoped>
@reference "../../styles/app.css";

.search-field {
  display: block;
  padding: 4px 8px 8px;
}
.state-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 16px;
  color: var(--text-3);
  font-size: 14px;
}
</style>

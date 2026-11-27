<template>
  <Alert v-if="editor.state.error && !editor.state.config" variant="destructive" as="p" role="alert">
    {{ editor.state.error }} <Button variant="outline" size="sm" :disabled="editor.state.loading" @click="editor.load(path)">重试读取</Button>
  </Alert>
  <SettingsGroup v-else-if="!editor.state.config" :label="label" aria-busy="true">
    <div class="grid gap-2 p-2"><Skeleton v-for="n in 3" :key="n" class="h-10" /></div>
  </SettingsGroup>
  <ConfigForm v-else class="arrive" :node="snapshot.schema" :path="[]" :label="label" :store="settings.store" />
</template>
<script setup lang="ts">
import { computed, onUnmounted, provide, watch } from "vue";

import type { PluginSchemaSnapshot } from "../../../src/shared/plugin-config";
import { pluginIdentity } from "../lib/plugin-config";
import { toast, toastErrors } from "../lib/toast";
import ConfigForm from "../schema/ConfigForm.vue";
import { SCHEMA_SCOPE } from "../schema/schema-model";
import { createPluginSettings } from "../state/settings-store";
import SettingsGroup from "./group/SettingsGroup.vue";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

/** The fields of one plugin instance, saved as they change; `path` follows the instance across enable renames. */
const props = defineProps<{ path: string; name: string; label: string; snapshot: PluginSchemaSnapshot; writable: boolean }>();
let disposed = false;
const settings = createPluginSettings(props.snapshot, {
  writable: () => props.writable,
  disposed: () => disposed,
  notify: (text, undo) => toast(text, "ok", undefined, undo && { label: "撤销", run: undo }),
});
const editor = settings.editor;
onUnmounted(() => {
  disposed = true;
  editor.dispose();
});
// Uploads from a path field are filed under the plugin's name.
provide(
  SCHEMA_SCOPE,
  computed(() => props.name),
);
toastErrors(
  () => editor.state.error,
  () => (editor.state.error = ""),
  () => !editor.state.config || settings.refusing(),
  () => editor.state.busy,
);
// Enabling or disabling renames the instance (`~name`); it stays the same settings.
watch(
  () => props.path,
  (path, previous) => {
    if (previous && pluginIdentity(path) === pluginIdentity(previous)) editor.state.path = path;
    else void editor.load(path);
  },
  { immediate: true },
);
</script>

<template>
  <!-- A long text or a file: the name above, the field across the row; without a name (a shape's only content), just the field. -->
  <GroupRow v-if="wide" :title="row.title" :class="{ untitled: !row.title }">
    <template #below>
      <PathField
        v-if="row.kind === 'path'"
        :input-id="id"
        :model-value="current"
        :extra="meta.extra"
        :placeholder="placeholder"
        :disabled="store.disabled"
        @update:model-value="change"
      />
      <Textarea
        v-else
        :id="id"
        class="wide-input min-h-24"
        :class="{ 'font-mono': row.kind === 'json' }"
        :aria-label="label"
        :aria-invalid="!!error || undefined"
        :value="text"
        :placeholder="placeholder"
        :disabled="store.disabled"
        spellcheck="false"
        @change="changeText"
      />
      <p v-if="error" class="row-error mt-2" role="alert">{{ error }}</p>
    </template>
  </GroupRow>
  <GroupRow v-else :title="row.title || label" :class="{ 'field-row': row.kind !== 'switch' && row.kind !== 'number' }">
    <Switch v-if="row.kind === 'switch'" :aria-label="label" :model-value="flag" :disabled="store.disabled" @update:model-value="change" />
    <div v-else-if="row.kind === 'select'" class="control">
      <PickerMenu
        :id="id"
        field
        :label="label"
        :model-value="current ?? meta.default"
        :options="options"
        :placeholder="placeholder || '未设置'"
        :disabled="store.disabled"
        @update:model-value="change"
      />
    </div>
    <span v-else class="control flex items-center gap-2" :class="{ number: row.kind === 'number' }">
      <Input
        :id="id"
        class="field-input min-w-0 flex-1"
        :type="row.kind === 'number' ? 'number' : row.kind === 'secret' ? 'password' : 'text'"
        :autocomplete="row.kind === 'secret' ? 'new-password' : 'off'"
        :aria-label="label"
        :aria-invalid="!!error || undefined"
        :min="meta.min"
        :max="meta.max"
        :step="row.kind === 'number' ? (meta.step ?? 'any') : undefined"
        :value="text"
        :placeholder="placeholder"
        :disabled="store.disabled"
        @change="changeText"
      /><span v-if="meta.unit" class="unit">{{ meta.unit }}</span
      ><Button
        v-if="row.kind === 'secret' && hasValue && !required"
        variant="ghost"
        size="icon-sm"
        type="button"
        class="text-faint hover:text-destructive"
        :aria-label="`清除${label}`"
        :disabled="store.disabled"
        @click="clearSecret"
        ><X
      /></Button>
    </span>
    <template v-if="error" #below
      ><p class="row-error" role="alert">{{ error }}</p></template
    >
  </GroupRow>
</template>
<script setup lang="ts">
import { X } from "reicon-vue";
import { computed, inject } from "vue";

import GroupRow from "../components/group/GroupRow.vue";
import PickerMenu from "../components/PickerMenu.vue";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { confirmDialog } from "../lib/dialog";
import { CONFIG_STORE, type ConfigStore } from "./config-store";
import PathField from "./PathField.vue";
import { constOptions, isSecret, validate, type FieldRow } from "./schema-model";

/**
 * One setting as a row (user, 2026-11-25: like 对话 and 模型服务): the name on the left, its control on the right.
 * Switches and selects save when changed; text and numbers when the field is left or Enter is pressed. A value the
 * field cannot take is refused in place: its reason under the row, the saved value back in the field.
 */
const props = defineProps<{ row: FieldRow; label: string }>();

const store = inject(CONFIG_STORE) as ConfigStore;

const meta = computed(() => (props.row.node.meta ?? {}) as Record<string, unknown> & { min?: number; max?: number; step?: number; unit?: string });

const id = computed(() => `config-${props.row.path.join("-") || "value"}`);

const current = computed(() => store.value(props.row.path));

const error = computed(() => store.error(props.row.path));

const required = computed(() => meta.value.required === true && meta.value.default === undefined);

const wide = computed(() => ["textarea", "path", "json"].includes(props.row.kind));

const hasValue = computed(() => current.value !== undefined && current.value !== "");

const flag = computed(() => (typeof current.value === "boolean" ? current.value : meta.value.default === true));

const options = computed(() => constOptions(props.row.node, store.dynamics));

/** What the field shows; a secret never comes back to the browser, so its field stays empty. */
const text = computed(() => {
  const value = current.value;
  if (props.row.kind === "secret" || value === undefined || value === null) return "";
  if (props.row.kind === "json") return JSON.stringify(value, null, 2);
  return typeof value === "string" ? value : String(value);
});

/** State only: the default that applies, or whether a secret is set. */
const placeholder = computed(() => {
  if (props.row.kind === "secret") return isSecret(current.value) || hasValue.value ? "已设置" : "未设置";
  const fallback = meta.value.default;
  if (fallback !== undefined && fallback !== "" && typeof fallback !== "object")
    return `默认 ${String(options.value.find((item) => item.value === fallback)?.label ?? fallback)}`;
  return required.value ? "未设置" : "";
});

function change(next: unknown) {
  if (store.disabled) return;
  const problem = validate(props.row.node, next, store.dynamics)[0];
  if (problem) return void store.fail(props.row.path, problem.message);
  if (JSON.stringify(next) === JSON.stringify(current.value)) return;
  store.commit(props.label, [[props.row.path, next]], { irreversible: props.row.kind === "secret" });
}

function changeText(event: Event) {
  const input = event.target as HTMLInputElement | HTMLTextAreaElement;
  const raw = input.value;
  // A secret field only ever sets a new one; leaving it empty keeps the one saved.
  if (props.row.kind === "secret") {
    input.value = "";
    if (raw) change(raw);
    return;
  }
  if (props.row.kind === "json") {
    if (!raw.trim()) return change(undefined);
    try {
      return change(JSON.parse(raw));
    } catch {
      // The text stays so it can be fixed; nothing is saved.
      return void store.fail(props.row.path, "请输入有效的 JSON");
    }
  }
  const next = raw.trim() === "" ? undefined : props.row.kind === "number" ? Number(raw) : raw;
  if (props.row.kind === "number" && (!Number.isFinite(next) || !(input as HTMLInputElement).checkValidity?.())) {
    const problem = validate(props.row.node, next, store.dynamics)[0];
    store.fail(props.row.path, problem?.message ?? "请输入有效数字");
    input.value = text.value;
    return;
  }
  const before = text.value;
  change(next);
  // Refused: the field shows the saved value again.
  if (error.value) input.value = before;
}

async function clearSecret() {
  if (store.disabled || !(await confirmDialog({ title: `清除${props.label}？`, confirmLabel: "清除", danger: true }))) return;
  change(undefined);
}
</script>
<style scoped>
@reference "../styles/app.css";

.control {
  width: 260px;
  max-width: 100%;
}
/* Numbers are short: a narrower field, its unit beside it, as on 对话. */
.control.number {
  width: 13rem;
}
.control :deep([data-slot="select-trigger"]),
.field-input,
.wide-input {
  @apply rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile;
}
.path-field :deep(input[type="text"]) {
  @apply rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile;
}
.unit {
  @apply shrink-0 whitespace-nowrap text-sm text-muted-foreground;
}
/* Without a name the field is the whole row. */
.untitled :deep(.row-main) {
  display: none;
}
.untitled :deep(.row-below) {
  padding-top: 0;
}
.row-error {
  @apply text-sm text-destructive;
}
/* On a phone a text or a choice takes the row's width under its name; a number stays beside it. */
@media (max-width: 640px) {
  .field-row :deep(.row-control) {
    flex: 1 0 100%;
  }
  .field-row .control {
    width: 100%;
  }
  .control.number {
    width: 8.5rem;
  }
}
</style>

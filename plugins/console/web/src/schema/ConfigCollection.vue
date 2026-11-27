<template>
  <!-- A fixed set of options: one switch each. -->
  <template v-if="collection.kind === 'choices'">
    <GroupRow v-for="option in options" :key="String(option.value)" :title="option.label">
      <Switch
        :aria-label="option.label"
        :model-value="list.some((item) => same(item, option.value))"
        :disabled="store.disabled"
        @update:model-value="toggleChoice(option.value, $event)"
      />
    </GroupRow>
  </template>

  <!-- Texts or numbers: one field each, saved when left. -->
  <template v-else-if="collection.kind === 'items'">
    <div v-for="(item, index) in list" :key="`${index}:${list.length}`" class="item-row">
      <p v-if="store.error([...collection.path, String(index)])" class="item-error" role="alert">{{ store.error([...collection.path, String(index)]) }}</p>
      <Input
        class="field-input min-w-0 flex-1"
        :type="secret ? 'password' : collection.item.type === 'number' ? 'number' : 'text'"
        :autocomplete="secret ? 'new-password' : 'off'"
        :aria-label="`${collection.title} ${index + 1}`"
        :aria-invalid="!!store.error([...collection.path, String(index)]) || undefined"
        :value="secret ? '' : String(item ?? '')"
        :placeholder="secret ? '已设置' : ''"
        :disabled="store.disabled"
        @change="editItem(index, $event)"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        class="text-faint hover:text-destructive"
        :aria-label="`移除${collection.title} ${index + 1}`"
        :disabled="store.disabled"
        @click="removeAt(index)"
        ><X
      /></Button>
    </div>
    <div v-if="adding" class="item-row">
      <Input
        ref="addInput"
        class="field-input min-w-0 flex-1"
        :type="secret ? 'password' : collection.item.type === 'number' ? 'number' : 'text'"
        :autocomplete="secret ? 'new-password' : 'off'"
        :aria-label="`新的${collection.title}`"
        :disabled="store.disabled"
        @change="addItem"
        @blur="adding = false"
        @keydown.esc.stop="adding = false"
      />
    </div>
    <button v-else type="button" class="add-row" :disabled="store.disabled" @click="startAdding"><Plus aria-hidden="true" />添加</button>
  </template>

  <!-- Names and values (headers, environment variables). -->
  <template v-else-if="collection.kind === 'pairs'">
    <div v-for="(value, name) in record" :key="name" class="item-row">
      <Input
        class="field-input pair-name font-mono"
        :value="String(name)"
        :aria-label="`${collection.title}名称`"
        :disabled="store.disabled"
        @change="rename(String(name), $event)"
      />
      <Input
        class="field-input min-w-0 flex-1 font-mono"
        :value="value == null ? '' : String(value)"
        :aria-label="`${name} 的值`"
        :disabled="store.disabled"
        @change="setPair(String(name), $event)"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        class="text-faint hover:text-destructive"
        :aria-label="`移除 ${name}`"
        :disabled="store.disabled"
        @click="removeKey(String(name))"
        ><X
      /></Button>
    </div>
    <div v-if="adding" class="item-row" @focusout="leavePair">
      <Input
        ref="addInput"
        v-model="pairName"
        class="field-input pair-name font-mono"
        placeholder="KEY"
        :aria-label="`新的${collection.title}名称`"
        :disabled="store.disabled"
        @keydown.enter.prevent="addPair"
        @keydown.esc.stop="adding = false"
      />
      <Input
        v-model="pairValue"
        class="field-input min-w-0 flex-1 font-mono"
        :aria-label="`新的${collection.title}值`"
        :disabled="store.disabled"
        @keydown.enter.prevent="addPair"
        @keydown.esc.stop="adding = false"
      />
    </div>
    <button v-else type="button" class="add-row" :disabled="store.disabled" @click="startAdding"><Plus aria-hidden="true" />添加</button>
  </template>

  <!-- Items with settings of their own: each opens as a page of the 设置 window. -->
  <template v-else>
    <GroupRow
      v-for="item in members"
      :key="item.key"
      :title="item.title"
      :detail="item.detail"
      clickable
      :data-config-item="item.key"
      @open="opened = item.key"
    >
      <Switch
        v-if="toggle"
        :aria-label="`${item.title}：${item.on ? '已启用' : '已停用'}`"
        :model-value="item.on"
        :disabled="store.disabled"
        @update:model-value="setToggle(item.key, $event)"
      />
    </GroupRow>
    <button type="button" class="add-row" :disabled="store.disabled" @click="startDraft"><Plus aria-hidden="true" />添加</button>
    <SettingsSubpage
      v-for="item in members"
      :key="`page:${item.key}`"
      :open="opened === item.key"
      :title="item.title"
      dialog-class="sm:max-w-2xl"
      @update:open="(open) => !open && (opened = '')"
    >
      <ConfigForm
        :node="collection.item"
        :path="collection.kind === 'entries' ? [...collection.path, item.key] : []"
        :label="item.title"
        :store="collection.kind === 'records' ? itemStore(store, collection.path, Number(item.key)) : store"
      />
      <SettingsGroup :label="`移除「${item.title}」`">
        <GroupRow :title="`移除「${item.title}」`" :icon="Trash2" icon-tone="danger">
          <Button variant="danger" size="sm" type="button" :disabled="store.disabled" @click="removeMember(item.key)">移除</Button>
        </GroupRow>
      </SettingsGroup>
    </SettingsSubpage>
    <SettingsSubpage :open="!!draft" title="添加" dialog-class="sm:max-w-2xl" @update:open="(open) => !open && (draft = undefined)">
      <template v-if="draft">
        <SettingsGroup v-if="collection.kind === 'entries'" label="名称">
          <GroupRow title="名称" class="field-row">
            <Input
              v-model="draftName"
              class="field-input control"
              :aria-label="`${collection.title}名称`"
              :aria-invalid="taken || undefined"
              :disabled="store.disabled"
            />
            <template v-if="taken" #below><p class="text-sm text-destructive" role="alert">已有同名的一项</p></template>
          </GroupRow>
        </SettingsGroup>
        <ConfigForm :node="collection.item" :path="[]" :label="collection.title" :store="draft.store" />
      </template>
      <template #footer>
        <Button type="button" variant="outline" @click="draft = undefined">取消</Button>
        <Button type="button" :disabled="!addable" @click="addDraft">添加</Button>
      </template>
    </SettingsSubpage>
  </template>
  <p v-if="store.error(collection.path)" class="collection-error" role="alert">{{ store.error(collection.path) }}</p>
</template>
<script setup lang="ts">
import { Add as Plus, Trash2, X } from "reicon-vue";
import { computed, inject, nextTick, ref, shallowRef } from "vue";

import GroupRow from "../components/group/GroupRow.vue";
import SettingsGroup from "../components/group/SettingsGroup.vue";
import SettingsSubpage from "../components/SettingsSubpage.vue";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { confirmDialog } from "../lib/dialog";
import { CONFIG_STORE, draftStore, itemStore, type ConfigStore } from "./config-store";
import ConfigForm from "./ConfigForm.vue";
import { constOptions, hasSecret, isRecord, itemSummary, itemToggle, recordTitle, validate, type Collection } from "./schema-model";

/**
 * A list or a set of named items as rows of its group, each change saved at once. Plain items are edited in their
 * row; items with settings of their own open as pages of the 设置 window (user, 2026-11-23: 「最忌弹窗套弹窗」), and
 * a new one is filled in on its own page before it is added.
 */
const props = defineProps<{ collection: Collection }>();

const store = inject(CONFIG_STORE) as ConfigStore;

const label = computed(() => props.collection.title);

const value = computed(() => store.value(props.collection.path));

const list = computed(() => (Array.isArray(value.value) ? value.value : []));

const record = computed(() => (isRecord(value.value) ? value.value : {}));

/** Secrets never come back to the browser: a changed or removed one cannot be put back by 撤销. */
const secret = computed(() => hasSecret(props.collection.item, store.dynamics));

const options = computed(() => constOptions(props.collection.item, store.dynamics));

// ---- items
const adding = ref(false);

const addInput = ref<{ $el?: HTMLElement } | HTMLElement>();

// ---- pairs
const pairName = ref(""),
  pairValue = ref("");

// ---- records and entries
const opened = ref("");

const toggle = computed(() => (props.collection.kind === "entries" ? itemToggle(props.collection.item, store.dynamics) : undefined));

const members = computed(() =>
  props.collection.kind === "entries"
    ? Object.entries(record.value).map(([key, item]) => ({
        key,
        title: key,
        detail: itemSummary(props.collection.item, item, store.dynamics),
        on: toggle.value ? (isRecord(item) && typeof item[toggle.value.key] === "boolean" ? item[toggle.value.key] === true : toggle.value.fallback) : false,
      }))
    : list.value.map((item, index) => ({ key: String(index), title: recordTitle(item, index), detail: "", on: false })),
);

const draft = shallowRef<ReturnType<typeof draftStore>>();

const draftName = ref("");

const taken = computed(() => props.collection.kind === "entries" && Object.hasOwn(record.value, draftName.value.trim()));

const addable = computed(
  () =>
    !!draft.value && !store.disabled && (props.collection.kind !== "entries" || (!!draftName.value.trim() && !taken.value)) && !draft.value.problems().length,
);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const save = (next: unknown, origin = props.collection.path) =>
  store.commit(label.value, [[props.collection.path, next]], { irreversible: secret.value, origins: [origin] });

// ---- choices
function toggleChoice(option: unknown, on: boolean) {
  if (store.disabled) return;
  const known = options.value.map((item) => item.value);
  const picked = list.value.filter((item) => !same(item, option));
  if (on) picked.push(option);
  // The options' order; values the schema does not list stay at the end.
  save([...known.filter((item) => picked.some((value) => same(value, item))), ...picked.filter((item) => !known.some((value) => same(value, item)))]);
}

async function startAdding() {
  if (store.disabled) return;
  adding.value = true;
  await nextTick();
  const element = addInput.value && "$el" in addInput.value ? addInput.value.$el : (addInput.value as HTMLElement | undefined);
  (element instanceof HTMLInputElement ? element : element?.querySelector?.("input"))?.focus();
}

function itemValue(input: HTMLInputElement): unknown {
  return props.collection.item.type === "number" ? Number(input.value) : input.value;
}

function checked(next: unknown, at: readonly string[]): boolean {
  const problem = validate(props.collection.item, next, store.dynamics)[0];
  if (problem) store.fail(at, problem.message);
  return !problem;
}

function editItem(index: number, event: Event) {
  const input = event.target as HTMLInputElement;
  const at = [...props.collection.path, String(index)];
  if (store.disabled || (secret.value && !input.value)) return;
  if (!input.value.trim()) {
    input.value = secret.value ? "" : String(list.value[index] ?? "");
    return;
  }
  const next = itemValue(input);
  if (secret.value) input.value = "";
  if (!checked(next, at)) return void (input.value = secret.value ? "" : String(list.value[index] ?? ""));
  save(
    list.value.map((item, i) => (i === index ? next : item)),
    at,
  );
}

function addItem(event: Event) {
  const input = event.target as HTMLInputElement;
  if (store.disabled || !input.value.trim()) return;
  const next = itemValue(input);
  if (!checked(next, props.collection.path)) return;
  input.value = "";
  save([...list.value, next]);
}

async function removeAt(index: number) {
  if (store.disabled) return;
  if (secret.value && !(await confirmDialog({ title: `移除这个${label.value}？`, confirmLabel: "移除", danger: true }))) return;
  save(list.value.filter((_, i) => i !== index));
}

function setPair(name: string, event: Event) {
  if (store.disabled) return;
  save({ ...record.value, [name]: (event.target as HTMLInputElement).value });
}

function rename(from: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const to = input.value.trim();
  if (store.disabled || to === from) return;
  if (!to || Object.hasOwn(record.value, to)) return void (input.value = from);
  save(Object.fromEntries(Object.entries(record.value).map(([key, value]) => [key === from ? to : key, value])));
}

function removeKey(name: string) {
  if (store.disabled) return;
  save(Object.fromEntries(Object.entries(record.value).filter(([key]) => key !== name)));
}

function addPair() {
  const name = pairName.value.trim();
  if (store.disabled || !name) return;
  if (Object.hasOwn(record.value, name)) return void store.fail(props.collection.path, "已有同名的一项");
  save({ ...record.value, [name]: pairValue.value });
  pairName.value = pairValue.value = "";
  adding.value = false;
}

/** Leaving the new row adds it when it has a name. */
function leavePair(event: FocusEvent) {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
  if (pairName.value.trim()) addPair();
  else adding.value = false;
}

function setToggle(key: string, on: boolean) {
  if (store.disabled || !toggle.value) return;
  store.commit(key, [[[...props.collection.path, key, toggle.value.key], on]]);
}

async function removeMember(key: string) {
  if (store.disabled) return;
  if (
    secret.value &&
    !(await confirmDialog({ title: `移除「${members.value.find((item) => item.key === key)?.title ?? ""}」？`, confirmLabel: "移除", danger: true }))
  )
    return;
  opened.value = "";
  if (props.collection.kind === "entries") save(Object.fromEntries(Object.entries(record.value).filter(([name]) => name !== key)));
  else save(list.value.filter((_, index) => index !== Number(key)));
}

function startDraft() {
  if (store.disabled) return;
  draftName.value = "";
  draft.value = draftStore(props.collection.item, store.dynamics, () => store.disabled);
}

function addDraft() {
  if (!addable.value || !draft.value) return;
  const item = draft.value.draft;
  if (props.collection.kind === "entries") save({ ...record.value, [draftName.value.trim()]: item });
  else save([...list.value, item]);
  draft.value = undefined;
}
</script>
<style scoped>
@reference "../styles/app.css";

.field-input {
  @apply rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile;
}
.control {
  width: 260px;
  max-width: 100%;
}
.item-row {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 8px 8px 8px 16px;
}
.item-row + .item-row::before {
  content: "";
  position: absolute;
  top: 0;
  right: 16px;
  left: 16px;
  height: 1px;
  background: var(--group-line);
}
/* Below its field: the row wraps, and the reason takes the next line. */
.item-error {
  @apply text-sm text-destructive;
  order: 1;
  flex: 1 0 100%;
}
.pair-name {
  width: 38%;
  max-width: 14rem;
  flex: none;
}
.add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 12px 16px;
  border-radius: 14px;
  color: var(--accent-text);
  font-size: 16px;
  text-align: left;
  transition: background-color var(--t-fast) ease;
}
.add-row:hover:not(:disabled) {
  background: var(--group-hover);
}
.add-row:disabled {
  opacity: 0.5;
}
.add-row :deep(svg) {
  width: 18px;
  height: 18px;
}
@media (max-width: 640px) {
  .field-row :deep(.row-control) {
    flex: 1 0 100%;
  }
  .field-row .control {
    width: 100%;
  }
}
.collection-error {
  @apply text-sm text-destructive;
  padding: 4px 16px 12px;
}
</style>

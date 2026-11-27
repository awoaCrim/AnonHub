<template>
  <form class="grid min-w-0 gap-7" @submit.prevent="view.create">
    <SettingsGroup title="账号">
      <GroupRow title="用户名" :icon="User">
        <Input
          v-model="state.username"
          :class="field"
          aria-label="用户名"
          autocomplete="off"
          required
          minlength="3"
          maxlength="32"
          pattern="[a-zA-Z0-9._-]{3,32}"
          :disabled="state.busy"
        />
      </GroupRow>
      <GroupRow title="初始密码" :icon="KeyRound">
        <Input
          v-model="state.password"
          :class="field"
          aria-label="初始密码"
          :type="generated ? 'text' : 'password'"
          autocomplete="new-password"
          required
          minlength="12"
          maxlength="4096"
          :disabled="state.busy"
          @input="generated = false"
        />
        <Button type="button" variant="outline" size="sm" class="rounded-full" :disabled="state.busy" @click="generate">随机生成</Button>
      </GroupRow>
      <GroupRow title="QQ 号码" detail="选填" :icon="MessageCircle">
        <Input v-model="state.qqAccount" :class="field" aria-label="QQ 号码" inputmode="numeric" pattern="[1-9][0-9]{4,11}" :disabled="state.busy" />
      </GroupRow>
    </SettingsGroup>
    <PluginGrants v-model="grant" :disabled="state.busy" />
    <div class="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" class="rounded-full" :disabled="state.busy" @click="emit('close')">取消</Button>
      <Button variant="default" class="rounded-full" :disabled="state.busy">添加好友</Button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { Key as KeyRound, ChatRound as MessageCircle, User } from "reicon-vue";
import { computed, ref } from "vue";

import { OPTIONAL_MEMBER_PLUGINS } from "../../../src/shared/plugin-catalog";
import { generatePassword, type createAccountsState } from "../state/accounts-state";
import GroupRow from "./group/GroupRow.vue";
import SettingsGroup from "./group/SettingsGroup.vue";
import PluginGrants from "./PluginGrants.vue";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const props = defineProps<{ view: ReturnType<typeof createAccountsState> }>();
const emit = defineEmits<{ close: [] }>();
const state = props.view.state;
const field = "w-56 max-w-full rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile";
/** A generated password stays readable so the owner can check it before sending. */
const generated = ref(false);
function generate() {
  state.password = generatePassword();
  generated.value = true;
}
/** `null` in the state means every optional plugin; the form always shows an explicit choice. */
const grant = computed({
  get: () => state.plugins ?? OPTIONAL_MEMBER_PLUGINS.map((item) => item.name),
  set: (plugins: string[]) => (state.plugins = plugins),
});
</script>

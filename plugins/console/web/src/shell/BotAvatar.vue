<template>
  <Avatar class="size-[var(--avatar-size,38px)] rounded-lg" aria-hidden="true">
    <AvatarFallback class="rounded-lg bg-primary/10 font-semibold text-primary" :class="shown === source ? 'text-transparent' : ''">{{
      initial
    }}</AvatarFallback>
    <!-- UI-EXCEPTION avatar-probe: native load dimensions reject 1x1 placeholder role images before showing the fallback account image. -->
    <img
      v-if="source"
      :key="source"
      class="absolute inset-0 size-full object-contain"
      :class="shown === source ? 'opacity-100' : 'opacity-0'"
      :src="source"
      alt=""
      referrerpolicy="no-referrer"
      @error="fail"
      @load="check"
    />
  </Avatar>
</template>
<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import { Avatar, AvatarFallback } from "../components/ui/avatar";
import { injectBotIdentity } from "./bot-identity";

/**
 * The bot's face: the active role card's 参考图, else the bot's own account picture, over its initial.
 * The initial shows until a picture has loaded; cards created in the WebUI carry a 1×1 placeholder, which
 * never covers it and gives way to the account picture. Size it with `--avatar-size`.
 */
const bot = injectBotIdentity();
const broken = reactive(new Set<string>()),
  shown = ref("");
const source = computed(() => [bot.value.image, bot.value.avatar].find((url): url is string => !!url && !broken.has(url)));
const initial = computed(() => [...bot.value.name][0]?.toUpperCase() ?? "B");
const fail = () => source.value && broken.add(source.value);
function check(event: Event) {
  const image = event.target as HTMLImageElement;
  if (image.naturalWidth <= 1) fail();
  else shown.value = source.value ?? "";
}
</script>

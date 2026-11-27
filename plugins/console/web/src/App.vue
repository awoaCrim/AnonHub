<template>
  <!-- Only neutral feedback may render before the first auth guard resolves. -->
  <div v-if="!route.matched.length" class="startup" role="status">正在连接后台…</div>
  <!-- The shell and its page see the page under the 设置 window as the route; the window sees the real one. -->
  <RouteScope v-else-if="route.meta.shell !== false" :route="page">
    <AppShell>
      <RouterView :route="page" v-slot="{ Component }">
        <Transition name="page"><component :is="Component" /></Transition>
      </RouterView>
      <RouteScope v-if="route.meta.settings" :route="route"><RouterView /></RouteScope>
    </AppShell>
  </RouteScope>
  <RouterView v-else />
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

import AppShell from "./shell/AppShell.vue";
import { RouteScope, settingsBackground } from "./shell/settings-window";

const route = useRoute();
const router = useRouter();
/** The page in the shell: the current one, or, while the 设置 window is open, the page it opened over. */
const page = computed(() => (route.meta.settings ? router.resolve(settingsBackground.value) : route));
</script>

<style scoped>
@reference "./styles/app.css";

.startup {
  @apply bg-background text-subtle text-sm;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
}
</style>

<template>
  <Card class="gap-0 p-5 max-sm:p-4" as-child
    ><section class="card missing">
      <p class="missing-code" aria-hidden="true">404</p>
      <p class="muted">地址可能已经变化。</p>
      <RouterLink :class="buttonVariants({ variant: 'outline' })" to="/">回到对话</RouterLink>
    </section></Card
  >
</template>
<style scoped>
@reference "../styles/app.css";

.missing {
  text-align: center;
  padding: 48px 24px;
  display: grid;
  gap: 12px;
  justify-items: center;
}
.missing p {
  margin: 0;
}
.missing-code {
  @apply text-5xl font-bold text-muted-foreground;
}
</style>

<script setup lang="ts">
import { buttonVariants } from "../components/ui/button";
import { Card } from "../components/ui/card";
</script>

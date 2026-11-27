<template>
  <Avatar :class="large ? 'size-10 rounded-lg' : 'size-8 rounded-lg'" aria-hidden="true">
    <AvatarFallback class="rounded-lg font-semibold">{{ (type || "?").slice(0, 1).toUpperCase() }}</AvatarFallback>
  </Avatar>
</template>
<script setup lang="ts">
import { Avatar, AvatarFallback } from "../ui/avatar";
defineProps<{ type: string; large?: boolean }>();
</script>

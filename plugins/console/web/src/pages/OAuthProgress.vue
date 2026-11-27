<template>
  <main class="grid min-h-dvh place-items-center bg-background p-4 text-foreground">
    <Card class="w-full max-w-md">
      <CardHeader><CardTitle as="h1">正在完成 Google 授权…</CardTitle></CardHeader>
      <CardContent class="space-y-4">
        <p class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />完成后会自动返回设置。
        </p>
        <Button variant="outline" as-child><a href="/settings/connections">返回设置</a></Button>
        <noscript><p>请开启 JavaScript 后重新连接 Google。</p></noscript>
      </CardContent>
    </Card>
  </main>
</template>
<script setup lang="ts">
import { Loader as LoaderCircle } from "reicon-vue";

import { Button } from "../components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
</script>

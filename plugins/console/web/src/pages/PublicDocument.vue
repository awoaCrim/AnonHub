<template>
  <div class="min-h-dvh bg-background font-sans text-foreground">
    <header class="border-b bg-card">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <a href="/about.html" class="text-lg font-semibold">YesImBot</a>
        <nav class="flex flex-wrap gap-1" aria-label="公开页面">
          <Button v-for="(item, key) in meta" :key="key" :variant="page === key ? 'secondary' : 'ghost'" as-child>
            <a :href="`/${key}.html`" :aria-current="page === key ? 'page' : undefined">{{ key === "about" ? "应用介绍" : item.title }}</a>
          </Button>
          <Button variant="outline" as-child><a href="/login">登录</a></Button>
        </nav>
      </div>
    </header>
    <main class="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <Card>
        <CardHeader
          ><CardTitle as="h1" class="text-2xl sm:text-3xl">{{ meta[page].title }}</CardTitle></CardHeader
        >
        <CardContent>
          <!-- UI-EXCEPTION legal-prose: trusted static legal text has document semantics, not interactive component semantics. Typography uses the shared Tailwind theme. -->
          <article
            class="space-y-4 leading-7 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_p]:my-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_a]:text-primary [&_a]:underline [&_strong]:font-semibold [&_.date]:text-sm [&_.date]:text-muted-foreground"
            v-html="body"
          />
        </CardContent>
      </Card>
    </main>
  </div>
</template>
<script setup lang="ts">
import { Button } from "../components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import meta from "../public-content/meta.json";
defineProps<{ page: keyof typeof meta; body: string }>();
</script>

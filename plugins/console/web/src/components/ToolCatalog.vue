<template>
  <DetailDialog
    title="各平台可用工具"
    description="由代码统一声明，对话里实际给它的工具就按这张表来。所有会话都有这些工具，只有管理员（在平台页登记）能让它调用带“敏感”标记的工具；扩展和 MCP 工具按各自声明，不在表内。"
    @update:open="(open) => open && load()"
  >
    <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>
    <p v-else-if="!catalog" class="text-sm text-muted-foreground">正在读取…</p>
    <div v-else class="catalog-scroll">
      <Table class="catalog">
        <TableHeader>
          <TableRow>
            <TableHead class="tool-col">工具</TableHead>
            <TableHead v-for="column in catalog.columns" :key="column.platform + column.kind" class="text-center whitespace-nowrap">{{
              column.label
            }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody v-for="group in catalog.groups" :key="group.plugin">
          <TableRow class="group-row">
            <TableCell :colspan="catalog.columns.length + 1" class="font-medium">{{ group.label }}</TableCell>
          </TableRow>
          <TableRow v-for="tool in group.tools" :key="tool.name">
            <TableCell class="tool-col"
              ><code>{{ tool.name }}</code
              ><Badge v-if="tool.sensitive" variant="outline" class="ml-2">敏感</Badge></TableCell
            >
            <TableCell v-for="(allowed, index) in tool.allowed" :key="index" class="text-center">
              <Check v-if="allowed" class="inline size-4 text-primary" :aria-label="`${catalog.columns[index]!.label}可用`" />
              <span v-else class="text-muted-foreground" :aria-label="`${catalog.columns[index]!.label}不可用`">—</span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </DetailDialog>
</template>
<script setup lang="ts">
import { Check } from "reicon-vue";
import { ref } from "vue";

import type { ToolCatalog } from "../../../src/shared/tool-catalog";
import { api } from "../lib/api";
import DetailDialog from "./DetailDialog.vue";
import { Badge } from "./ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

/** The table is fixed by code, so one read per page visit is enough. */
const catalog = ref<ToolCatalog>();
const error = ref("");
async function load() {
  if (catalog.value) return;
  error.value = "";
  try {
    catalog.value = await api<ToolCatalog>("/yesimbot/api/v1/tools/catalog");
  } catch {
    error.value = "读取失败，请稍后再试。";
  }
}
</script>
<style scoped>
.catalog-scroll {
  overflow-x: auto;
}
.catalog code {
  font-size: 14px;
}
.tool-col {
  white-space: nowrap;
}
.group-row {
  background: var(--surface-2);
}
</style>

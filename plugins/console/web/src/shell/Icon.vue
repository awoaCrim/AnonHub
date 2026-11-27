<template>
  <component :is="icons[name]" class="icon" aria-hidden="true" />
</template>
<script setup lang="ts">
import {
  Archive,
  Widget as Blocks,
  Chart as ChartColumn,
  Check,
  ChevronRight,
  Cpu,
  DocumentText as FileText,
  Home2 as House,
  Gallery as Image,
  Widget as LayoutGrid,
  Logout as LogOut,
  Maximize as Maximize2,
  Menu,
  Message as MessageSquare,
  Monitor,
  Moon,
  SidebarRight as PanelRight,
  Pause,
  Play,
  Plug,
  Add as Plus,
  UnorderedList as Rows3,
  Search,
  Send,
  Server,
  Setting2 as Settings2,
  Tuning as SlidersHorizontal,
  Stars as Sparkles,
  UserSquare as SquareUser,
  Sun,
  User,
  Users,
  Users as UsersRound,
  X,
  Ghost as Bot,
  History,
  Box,
  Mobile,
} from "reicon-vue";
import type { Component } from "vue";

import type { IconName } from "../nav";

/** Every icon is a Reicon icon, sized by the global icon rule (app.css); the names stay the app's own. */
defineProps<{ name: IconName | ExtraIcon }>();
type ExtraIcon =
  | "panel"
  | "model"
  | "channel"
  | "community"
  | "menu"
  | "close"
  | "plus"
  | "expand"
  | "sun"
  | "moon"
  | "logout"
  | "app"
  | "search"
  | "user"
  | "send"
  | "chevron"
  | "archive"
  | "play"
  | "check"
  | "image"
  | "file"
  | "pause";
const icons: Record<string, Component> = {
  home: House,
  check: Check,
  image: Image,
  file: FileText,
  pause: Pause,
  qq: MessageSquare,
  bot: Bot,
  model: Box,
  channel: Rows3,
  plugin: Plug,
  chat: MessageSquare,
  community: UsersRound,
  chart: ChartColumn,
  users: Users,
  settings: Settings2,
  menu: Menu,
  panel: PanelRight,
  close: X,
  plus: Plus,
  expand: Maximize2,
  sun: Sun,
  moon: Moon,
  logout: LogOut,
  app: Mobile,
  search: Search,
  user: User,
  send: Send,
  chevron: ChevronRight,
  archive: Archive,
  play: Play,
  spark: Sparkles,
  device: Monitor,
  sliders: SlidersHorizontal,
  server: Server,
  platform: LayoutGrid,
  role: SquareUser,
  history: History,
  cpu: Cpu,
  blocks: Blocks,
};
</script>
<style scoped>
@reference "../styles/app.css";

.icon {
  width: 18px;
  height: 18px;
  flex: none;
}
</style>

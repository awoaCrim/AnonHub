import { connector as onebot } from "@yesimbot/onebot";
import { connector as wechat } from "koishi-plugin-adapter-wechat-bridge/connector";
import { extension as deviceConnection } from "koishi-plugin-yesimbot-device-connection/extension";
import { extension as google } from "koishi-plugin-yesimbot-google/extension";
import { extension as imageTools } from "koishi-plugin-yesimbot-image-tools/extension";
import { extension as mcpClient } from "koishi-plugin-yesimbot-mcp-client/extension";
import { extension as memorizer } from "koishi-plugin-yesimbot-memorizer/extension";
import { extension as messageDebounce } from "koishi-plugin-yesimbot-message-debounce/extension";
import { extension as modelProvider } from "koishi-plugin-yesimbot-model-provider/extension";
import { extension as onebotUtils } from "koishi-plugin-yesimbot-onebot-utils/extension";
import { extension as roleplay } from "koishi-plugin-yesimbot-roleplay/extension";
import { extension as schedule } from "koishi-plugin-yesimbot-schedule/extension";
import { extension as searchService } from "koishi-plugin-yesimbot-search-service/extension";
import { extension as stickerManager } from "koishi-plugin-yesimbot-sticker-manager/extension";
import { extension as usage } from "koishi-plugin-yesimbot-usage/extension";
import { extension as workspace } from "koishi-plugin-yesimbot-workspace/extension";
import { extension as xiaoheihe } from "koishi-plugin-yesimbot-xiaoheihe/extension";

import type { Module } from "./extensions.js";

/**
 * Every extension and connector this host runs (conventions 09 and 10: registered statically). They start side by
 * side; stopping goes in reverse of this order, so model providers stop last. The console is not a module of the
 * registry.
 */
export const EXTENSIONS: readonly Module[] = [
  modelProvider,
  deviceConnection,
  workspace,
  memorizer,
  roleplay,
  schedule,
  searchService,
  stickerManager,
  imageTools,
  google,
  mcpClient,
  xiaoheihe,
  onebotUtils,
  messageDebounce,
  usage,
  onebot,
  wechat,
];

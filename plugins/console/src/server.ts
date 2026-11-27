/**
 * The console without Koishi, for `apps/server`: the install, its host interface and the pieces a host builds that
 * interface from. Nothing here loads Koishi.
 */
export { moduleConfig, type Config } from "./config.js";

export { pluginConfigSource } from "./config/form.js";

export { formNode } from "./config/form.js";

export { modelPickers, type ModelLists } from "./config/model-pickers.js";

export { splitSecrets } from "./config/secrets.js";

export { kRecord } from "./config/settle.js";

export type {
  BotLike,
  ExtensionInstalls,
  ForkLike,
  Host,
  HttpContext,
  HttpHandler,
  InstalledPackage,
  Loader,
  Middleware,
  RuntimeLike,
  Server,
  SocketHandler,
  TurnEvent,
} from "./host.js";

export { checkConsoleConfig, installConsole, type ConsoleHooks } from "./install.js";

export { memberId } from "./accounts.js";

export { CONTEXT_POLICY_FILE, contextPolicy, readContextPolicy } from "./context-policy.js";

export { LOCKED, POLICY_FILE, readPluginPolicy } from "./plugin-policy.js";

export type { WebUILogEntry } from "./shared/webui.js";

export { projectChatContent, WebChat } from "./webui/web-chat.js";

import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";

import type { Clock } from "@yesimbot/foundation";
import type { CoreService, Event as YesImBotEvent } from "koishi-plugin-yesimbot/kernel";
import type { WebSocket } from "ws";

import type { WebUILogEntry } from "./shared/webui.js";
import type { ProjectedChat, WebChatTransport } from "./webui/chat-bot.js";

/** Koishi `Status.ONLINE`. */
export const BOT_ONLINE = 1;

export type HttpHandler = (http: HttpContext) => unknown;

export type SocketHandler = (socket: WebSocket, request: IncomingMessage) => unknown;

export type Middleware = (http: HttpContext, next: () => Promise<unknown>) => unknown;

/** A forked plugin scope: a host of its own. */
export type ScopeHost = Host;

/** The request and response a console route reads and writes. Only the fields the handlers use. */
export interface HttpContext {
  status: number;
  body: unknown;
  type: string;
  path: string;
  method: string;
  originalUrl: string;
  length: number;
  accepts(...types: string[]): string | string[] | false;
  query: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  origin: string;
  secure: boolean;
  request: object;
  req: IncomingMessage;
  res: ServerResponse;
  get(name: string): string;
  set(name: string, value: string | string[]): void;
}

export interface Server {
  get(path: string, handler: HttpHandler): unknown;
  post(path: string, handler: HttpHandler): unknown;
  ws(path: string, handler: SocketHandler): unknown;
  /** Runs before the router's body parsing. Returns the function that removes it. */
  prepend(middleware: Middleware): () => void;
  readonly http: HttpServer;
  readonly port: number | undefined;
  readonly listenHost: string | undefined;
}

export interface BotLike {
  platform: string;
  selfId: string;
  status: number;
  error?: { message?: string };
  config?: unknown;
  user?: { avatar?: unknown; name?: string; nick?: string };
}

/** What the config editor needs of the module loader (`config/` on `apps/server`). Plugin scopes are opaque to the console. */
export interface Loader {
  config: { plugins?: Record<string, unknown>; port?: unknown; host?: unknown; [key: string]: unknown };
  entry: ScopeHost | undefined;
  writable: boolean | undefined;
  baseDir: string | undefined;
  isTruthyLike(value: unknown): boolean;
  interpolate?(config: unknown): unknown;
  keyFor(plugin: unknown): string;
  resolve(name: string): Promise<{ moduleConfig?: unknown; usage?: unknown } | undefined>;
  reload(parent: ScopeHost, key: string, config: unknown): Promise<ForkLike | undefined>;
  unload(parent: ScopeHost, key: string): void;
  writeConfig(silent?: boolean): Promise<void>;
  forkPlugin(name: string, config: unknown, parent: unknown): Promise<unknown>;
}

export interface ForkLike {
  error?: unknown;
  isActive?: boolean;
  runtime?: { error?: unknown; isReusable?: boolean; isActive?: boolean };
}

/** A plugin runtime of the loader registry, as the model settings page checks it after a reload. */
export interface RuntimeLike {
  plugin: unknown;
  error?: unknown;
  isReusable?: boolean;
  isActive?: boolean;
  children: {
    key: string;
    error?: unknown;
    isActive?: boolean;
    parent: { scope: unknown & { key?: string } };
  }[];
}

export interface TurnEvent {
  context: { platform: string; type: string; selfId: string; userId: string; channelId: string };
  turnId: string;
  active: boolean;
  activity?: string;
}

/** An installed package as the host reports it (`apps/server/src/installs.ts`). */
export interface InstalledPackage {
  readonly name: string;
  readonly version?: string;
  readonly module?: string;
  readonly installing?: boolean;
  /** Why it did not install or load: a registered code. */
  readonly error?: string;
  /** How its module runs, once it joined. */
  readonly state?: { readonly state: "disabled" | "waiting" | "running" | "failed"; readonly error?: { readonly code?: string } };
}

/** Extensions from npm, installed into this instance by its owner or the bot. */
export interface ExtensionInstalls {
  list(): InstalledPackage[];
  /** Checks the request (a refusal throws its registered error), then installs in the background; `list` shows how it goes. */
  install(name: unknown, version: unknown): { name: string };
  /** Stops its module and deletes its settings and files. */
  remove(name: unknown): Promise<void>;
}

/** What the console uses of its host; `apps/server` implements it (`apps/server/src/console-host.ts`). */
export interface Host {
  readonly baseDir: string;
  readonly clock: Clock;
  readonly server: Server;
  readonly loader: Loader;
  readonly yesimbot: CoreService;
  readonly bots: readonly BotLike[];
  readonly registry: { values(): Iterable<RuntimeLike> };
  readonly lifecycle: { flush(): Promise<void> };
  /** The plugin scope this host belongs to. */
  readonly scope: unknown;
  /** Registered dynamic schemas, by name. */
  readonly schema: { get(name: string): { toJSON(): unknown } | undefined } | undefined;
  /** Registers the web chat as a chat account of Core; `changed` is called when the bot writes to a conversation. */
  openWebChat(changed: (conversation: string) => void): WebChatTransport;
  /** A saved web chat message as text, attachments and choices. */
  projectChatContent(content: string): ProjectedChat;
  /** Every log record from now on, until the returned function is called. */
  onLog(listener: (record: WebUILogEntry) => void): () => void;
  readonly extensions: ExtensionInstalls;
  /** Services by name, for plugins the console reads without depending on their package. */
  get(name: string): unknown;
  inject(deps: readonly string[], callback: (host: Host) => void): void;
  setInterval(callback: () => void, ms: number): () => void;
  debounce(callback: () => void, ms: number): () => void;
  on(event: "dispose" | "ready" | "config" | "internal/runtime" | "internal/fork" | "internal/status" | "internal/schema", listener: () => unknown): () => void;
  on(event: "yesimbot/event", listener: (event: YesImBotEvent) => unknown): () => void;
  on(event: "yesimbot/turn", listener: (event: TurnEvent) => unknown): () => void;
  on(event: "yesimbot/model-usage", listener: () => unknown): () => void;
  on(event: "yesimbot/message", listener: (message: { data: { platform: string; selfId: string; messageId: string } }) => unknown): () => void;
}

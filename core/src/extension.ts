import type { IncomingMessage } from "node:http";

import { parseConfig, type Clock, type ModuleConfig } from "@yesimbot/foundation";
import type { z } from "zod/v4";

import type { ChatAccount } from "./accounts.js";
import type { ChannelContext } from "./channels/index.js";
import type { CoreService } from "./core.js";
import type { MessageEvents } from "./messages/index.js";
import type { ModelEvents } from "./models/index.js";

/** Core's events, as a module listens to them. */
export type CoreEvents = MessageEvents & ModelEvents;

/** Undoes what a start did: registrations, services, open connections. */
export type Undo = () => unknown;

/**
 * What a host gives an extension while it runs (convention 10). Timers, listeners and provided services go away with the
 * extension, so `start` only returns what else it must undo.
 */
export interface ExtensionContext<C> {
  /** The module's config, parsed (`Extension.parse`). */
  readonly config: C;
  readonly core: CoreService;
  /** The instance directory; module data lives under `data/`. */
  readonly baseDir: string;
  readonly clock: Clock;
  /** Returns the function that cancels it. */
  setTimeout(callback: () => void, ms: number): () => void;
  setInterval(callback: () => void, ms: number): () => void;
  on<K extends keyof CoreEvents>(name: K, listener: CoreEvents[K]): () => void;
  /** A service other modules read by name (the console's pages: `yesimbotSchedule`, `yesimbotMemory`, …). */
  provide(name: string, service: object): void;
  /** Trusted ingress only: a live account of this instance authenticated this very context (the web chat's owner). */
  isOwnerContext(context: ChannelContext): boolean;
}

/** A WebSocket as a connector's endpoint receives it (the `ws` package's socket, narrowed). */
export interface ConnectorSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "pong", listener: () => void): unknown;
}

/**
 * What a connector (convention 09) gets beyond an extension: its chat accounts and the host's HTTP.
 */
export interface ConnectorContext<C> extends ExtensionContext<C> {
  /** Puts a chat account online for Core to send through and the console to list; the returned function takes it off. */
  account(account: ChatAccount): () => void;
  /** A WebSocket endpoint at exactly `path`. `accept` runs before the upgrade: false refuses it with 401. */
  ws(path: string, handler: (socket: ConnectorSocket, request: IncomingMessage) => void, accept?: (request: IncomingMessage) => boolean): () => void;
}

/** A platform's connector: a module with accounts (convention 09). */
export interface Connector<C = unknown> {
  readonly kind: "connector";
  readonly moduleConfig: ModuleConfig;
  parse(raw: unknown): C;
  start(ctx: ConnectorContext<C>): void | Undo | Promise<void | Undo>;
}

/**
 * One module as both hosts run it: Koishi through `koishiExtension`, `apps/server` from its registry. `parse` runs when
 * the module is loaded, so a config that does not fit stops it before anything starts; `start` runs once every module
 * is loaded (Koishi's `ready`).
 */
export interface Extension<C = unknown> {
  readonly moduleConfig: ModuleConfig;
  parse(raw: unknown): C;
  start(ctx: ExtensionContext<C>): void | Undo | Promise<void | Undo>;
}

/** `parse` defaults to `parseConfig(moduleConfig, raw ?? {})`. */
export function defineExtension<S extends z.ZodType, C = z.output<S>>(extension: {
  readonly moduleConfig: ModuleConfig<S>;
  parse?(raw: unknown): C;
  start(ctx: ExtensionContext<C>): void | Undo | Promise<void | Undo>;
}): Extension<C> {
  return {
    moduleConfig: extension.moduleConfig,
    parse: extension.parse ?? ((raw) => parseConfig(extension.moduleConfig, raw ?? {}) as C),
    start: (ctx) => extension.start(ctx),
  };
}

/** `parse` defaults to `parseConfig(moduleConfig, raw ?? {})`. */
export function defineConnector<S extends z.ZodType, C = z.output<S>>(connector: {
  readonly moduleConfig: ModuleConfig<S>;
  parse?(raw: unknown): C;
  start(ctx: ConnectorContext<C>): void | Undo | Promise<void | Undo>;
}): Connector<C> {
  return {
    kind: "connector",
    moduleConfig: connector.moduleConfig,
    parse: connector.parse ?? ((raw) => parseConfig(connector.moduleConfig, raw ?? {}) as C),
    start: (ctx) => connector.start(ctx),
  };
}

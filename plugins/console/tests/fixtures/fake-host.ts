import { systemClock, type Clock } from "@yesimbot/foundation";
import type { CoreService } from "koishi-plugin-yesimbot/kernel";

import type { Host, Loader } from "../../src/host.js";
import { projectChatContent, WebChat } from "../../src/webui/web-chat.js";

export interface FakeHostOptions {
  baseDir?: string;
  clock?: Clock;
  loader?: Partial<Loader> | Record<string, unknown>;
  yesimbot?: unknown;
  /** What `on` listens to; inert when absent. */
  events?: { on(name: string, listener: (...args: never[]) => unknown): () => void };
}

/** A console host without any real host behind it: a service table, inert timers and events, and the real web chat. */
export function fakeHost(options: FakeHostOptions = {}): Host & { baseDir: string; services: Map<string, unknown>; yesimbot: CoreService } {
  const clock = options.clock ?? systemClock();
  const services = new Map<string, unknown>();
  const host = {
    baseDir: options.baseDir ?? "/nonexistent-instance",
    clock,
    server: { get() {}, post() {}, ws() {}, prepend: () => () => {}, http: undefined, port: undefined, listenHost: undefined },
    loader: options.loader as unknown as Loader,
    yesimbot: options.yesimbot as CoreService,
    bots: [],
    registry: { values: () => [] },
    lifecycle: { flush: async () => {} },
    scope: {},
    schema: undefined,
    services,
    extensions: { list: () => [], install: () => ({ name: "" }), remove: async () => {} },
    openWebChat: (changed: (conversation: string) => void) => new WebChat(host.yesimbot, changed, clock, () => true),
    projectChatContent: (content: string) => projectChatContent(content),
    onLog: () => () => {},
    get: (name: string) => services.get(name),
    inject: (_deps: readonly string[], callback: (host: Host) => void) => callback(host as unknown as Host),
    setInterval: () => () => {},
    debounce: () => () => {},
    on: (name: string, listener: (...args: never[]) => unknown) => options.events?.on(name, listener) ?? (() => {}),
  };
  return host as unknown as Host & { baseDir: string; services: Map<string, unknown>; yesimbot: CoreService };
}

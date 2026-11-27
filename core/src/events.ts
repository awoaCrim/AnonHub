import type { MessageEvents } from "./messages/index.js";

/**
 * What the runtimes announce (`yesimbot/message`, `yesimbot/delivered`, `yesimbot/turn`, …) and the model registry
 * revision they follow: the host's event bus.
 */
export interface CoreEventBus {
  emit<K extends keyof MessageEvents>(name: K, ...args: Parameters<MessageEvents[K]>): void;
  on(name: "yesimbot/model-registry-changed", listener: (revision: number) => void): () => void;
}

import { errorFields, logger } from "@yesimbot/foundation";

const log = logger("host.events");

type Listener = (...args: never[]) => unknown;

/**
 * The host's one event bus (convention 10): Core's `yesimbot/*` events today, modules' later. A listener that throws or
 * rejects is logged and does not stop the others.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  public emit(name: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      try {
        const result = (listener as (...values: unknown[]) => unknown)(...args);
        if (result instanceof Promise) result.catch((error: unknown) => log.warn("event.listener_failed", { eventName: name, ...errorFields(error) }));
      } catch (error) {
        log.warn("event.listener_failed", { eventName: name, ...errorFields(error) });
      }
    }
  }

  /** Returns the function that removes the listener. */
  public on(name: string, listener: Listener): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}

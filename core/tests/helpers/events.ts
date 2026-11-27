import type { CoreEventBus } from "../../src/events.js";

type Listener = (...args: never[]) => unknown;

/** A host's event bus for tests: what Core emits reaches the listeners a test adds, synchronously. */
export class TestEvents implements CoreEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  public emit(name: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) (listener as (...values: unknown[]) => unknown)(...args);
  }

  public on(name: string, listener: Listener): () => void {
    const set = this.listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(name, set);
    return () => void set.delete(listener);
  }
}

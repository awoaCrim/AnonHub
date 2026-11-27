import type { AdminSession } from "../admin-auth.js";

export const topicName = /^[a-z][a-z0-9-]{0,31}$/;

/** A live data source the WebUI subscribes to over server-sent events. */
export interface Topic<T = unknown> {
  readonly name: string;
  authorize(session: AdminSession): boolean;
  get(session: AdminSession): Promise<T>;
  /** Notifies that `get` may now return different data. Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
}

export class TopicRegistry {
  private readonly topics = new Map<string, Topic>();

  register(topic: Topic): () => void {
    if (!topicName.test(topic.name) || this.topics.has(topic.name)) throw new Error(`invalid or duplicate topic ${topic.name}`);
    this.topics.set(topic.name, topic);
    return () => {
      if (this.topics.get(topic.name) === topic) this.topics.delete(topic.name);
    };
  }

  get(name: string): Topic | undefined {
    return this.topics.get(name);
  }
}

/** Minimal change emitter for topic implementations. */
export class ChangeSignal {
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One broken subscriber must not starve the others.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

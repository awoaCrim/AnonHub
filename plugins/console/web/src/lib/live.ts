import { reactive } from "vue";

import { readPersisted, writePersisted } from "./cache";

export interface TopicState<T = unknown> {
  data: T | undefined;
  revision: number;
  /** True while the last known data may be outdated (disconnected or reconnecting). */
  stale: boolean;
  /** Data came from browser storage and the stream has not confirmed it yet. */
  cached: boolean;
  failed: boolean;
  /** The server does not offer this topic here (plugin not installed or not permitted). */
  unavailable: boolean;
}

export type LiveStatus = "idle" | "connecting" | "open" | "reconnecting";

interface SourceLike {
  readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void;
  close(): void;
}

export interface LiveOptions {
  url?: string;
  createSource?: (url: string) => SourceLike;
  /** The server ended the session; the caller decides where to navigate. Never reloads. */
  onSessionEnded?: () => void;
  /** Called after the stream failed hard (e.g. 401/403); resolves whether to retry. */
  onHardFailure?: () => Promise<boolean>;
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Topics whose last snapshot is kept in browser storage and shown (as stale) before the stream answers. */
  persist?: (topic: string) => boolean;
  cancelSchedule?: (handle: unknown) => void;
}

const CLOSED = 2;

/**
 * Server-sent topic subscriptions shared by the whole app. Data survives
 * disconnects (marked stale) and is replaced by the next snapshot.
 */
export function createLiveClient(options: LiveOptions = {}) {
  const url = options.url ?? "/yesimbot/api/v1/events";
  const createSource = options.createSource ?? ((target: string) => new EventSource(target));
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const status = reactive({ value: "idle" as LiveStatus });
  const topics = new Map<string, { state: TopicState; refs: number }>();
  interface Stream {
    source: SourceLike;
    names: string;
    remaining: Set<string>;
  }
  let active: Stream | undefined;
  let pending: Stream | undefined;
  let handoverTimer: unknown;
  let retryTimer: unknown;
  let generation = 0;
  let queued = false;
  let backoff = 1000;
  let stopped = false;
  let sessionEnded = false;
  const cancel = options.cancelSchedule ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  function stateOf(name: string) {
    let entry = topics.get(name);
    if (!entry)
      topics.set(
        name,
        (entry = { state: reactive({ data: undefined, revision: 0, stale: true, cached: false, failed: false, unavailable: false }) as TopicState, refs: 0 }),
      );
    return entry;
  }

  function wanted() {
    return [...topics]
      .filter(([, entry]) => entry.refs > 0)
      .map(([name]) => name)
      .sort()
      .join(",");
  }

  function markStale() {
    for (const { state, refs } of topics.values()) if (refs > 0) state.stale = true;
  }

  function closePending(preserveDeadline = false) {
    if (!preserveDeadline) {
      if (handoverTimer !== undefined) cancel(handoverTimer);
      handoverTimer = undefined;
    }
    pending?.source.close();
    pending = undefined;
  }

  function closeAll() {
    generation++;
    if (retryTimer !== undefined) cancel(retryTimer);
    retryTimer = undefined;
    closePending();
    active?.source.close();
    active = undefined;
  }

  function promote(stream: Stream) {
    if (pending !== stream) return;
    if (handoverTimer !== undefined) cancel(handoverTimer);
    handoverTimer = undefined;
    active?.source.close();
    active = stream;
    pending = undefined;
  }

  function reconcile() {
    queued = false;
    if (stopped || sessionEnded) return;
    const names = wanted();
    if (!names) {
      closeAll();
      status.value = "idle";
      return;
    }
    if (pending?.names === names) return;
    closePending(true);
    if (active?.names === names && active.source.readyState !== CLOSED) {
      closePending();
      return;
    }
    // The incumbent keeps shared topics fresh until the replacement answers all
    // requested topics. Never classify an intentional subscription edit as a drop.
    const retain = active && active.source.readyState !== CLOSED;
    if (!retain) {
      closePending();
      active?.source.close();
      active = undefined;
      status.value = status.value === "reconnecting" ? "reconnecting" : "connecting";
    }
    generation++;
    if (retryTimer !== undefined) cancel(retryTimer);
    retryTimer = undefined;
    const stream: Stream = { source: createSource(`${url}?topics=${encodeURIComponent(names)}`), names, remaining: new Set(names.split(",")) };
    if (retain) {
      pending = stream;
      // Keep one deadline for the incumbent, even if rapid route changes
      // replace the candidate repeatedly. Hidden subscriptions remain bounded.
      handoverTimer ??= schedule(() => {
        const replacement = pending;
        if (!replacement) return;
        promote(replacement);
        for (const name of replacement.remaining) {
          const entry = topics.get(name);
          if (entry?.refs) entry.state.stale = true;
        }
        if (replacement.remaining.size) status.value = "reconnecting";
      }, 15_000);
    } else active = stream;
    const current = () => !stopped && !sessionEnded && (active === stream || pending === stream);
    const onTopic = (kind: "data" | "unavailable" | "failed", event: MessageEvent | Event) => {
      if (!current()) return;
      const payload = JSON.parse((event as MessageEvent).data) as { topic: string; revision: number; data: unknown };
      const entry = topics.get(payload.topic);
      if (!entry?.refs || !stream.names.split(",").includes(payload.topic)) return;
      // A replacement's negative result supersedes the incumbent's availability.
      if (pending && active === stream && (kind !== "data" || !pending.remaining.has(payload.topic))) return;
      stream.remaining.delete(payload.topic);
      if (kind === "data") {
        Object.assign(entry.state, { data: payload.data, revision: payload.revision, stale: false, cached: false, failed: false, unavailable: false });
        if (options.persist?.(payload.topic)) writePersisted("topic:" + payload.topic, payload.data);
      } else if (kind === "unavailable")
        Object.assign(entry.state, { data: undefined, revision: 0, unavailable: true, cached: false, failed: false, stale: false });
      else Object.assign(entry.state, { failed: true, stale: true });
      if (pending === stream && !stream.remaining.size) promote(stream);
      if (kind !== "failed") {
        status.value = "open";
        backoff = 1000;
      }
    };
    stream.source.addEventListener("snapshot", (event) => onTopic("data", event));
    stream.source.addEventListener("update", (event) => onTopic("data", event));
    stream.source.addEventListener("unavailable", (event) => onTopic("unavailable", event));
    stream.source.addEventListener("topic-error", (event) => onTopic("failed", event));
    stream.source.addEventListener("closed", () => {
      if (!current()) return;
      sessionEnded = true;
      closeAll();
      markStale();
      status.value = "idle";
      options.onSessionEnded?.();
    });
    stream.source.addEventListener("error", () => {
      if (!current()) return;
      // A failed replacement must not keep hidden incumbent topics alive.
      if (pending === stream) promote(stream);
      else if (pending) {
        const replacement = pending;
        promote(replacement);
        for (const name of replacement.remaining) {
          const entry = topics.get(name);
          if (entry?.refs) entry.state.stale = true;
        }
        status.value = "reconnecting";
      }
      if (active !== stream) return;
      markStale();
      status.value = "reconnecting";
      if (stream.source.readyState !== CLOSED) return; // Native EventSource retry.
      active = undefined;
      const attempt = ++generation;
      const delay = backoff;
      backoff = Math.min(backoff * 2, 30_000);
      void (options.onHardFailure?.() ?? Promise.resolve(true)).then((retry) => {
        if (attempt !== generation || stopped || sessionEnded || !wanted()) return;
        if (retry)
          retryTimer = schedule(() => {
            retryTimer = undefined;
            if (attempt === generation) queue();
          }, delay);
        else status.value = "idle";
      });
    });
  }

  function queue() {
    if (queued) return;
    queued = true;
    queueMicrotask(reconcile);
  }

  /** Subscribe to a topic; returns its reactive state and a release function. */
  function use<T>(name: string): { state: TopicState<T>; release: () => void } {
    const entry = stateOf(name);
    entry.refs++;
    if (entry.state.data === undefined && !entry.state.unavailable && options.persist?.(name)) {
      const cached = readPersisted(`topic:${name}`);
      if (cached !== undefined) Object.assign(entry.state, { data: cached, stale: true, cached: true });
    }
    queue();
    let released = false;
    return {
      state: entry.state as TopicState<T>,
      release: () => {
        if (released) return;
        released = true;
        entry.refs--;
        queue();
      },
    };
  }

  /** Keeps topics subscribed for the session so page changes never reopen the stream. */
  function pin(names: string[]): () => void {
    const handles = names.map((name) => use(name));
    return () => handles.forEach((handle) => handle.release());
  }

  function reset() {
    closeAll();
    sessionEnded = false;
    status.value = "idle";
    for (const entry of topics.values())
      Object.assign(entry.state, { data: undefined, revision: 0, stale: true, cached: false, failed: false, unavailable: false });
    queue();
  }

  function stop() {
    stopped = true;
    closeAll();
    status.value = "idle";
  }

  return { status, use, pin, reset, stop, reconnect: queue };
}

export type LiveClient = ReturnType<typeof createLiveClient>;

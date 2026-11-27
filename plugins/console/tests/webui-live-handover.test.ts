import { afterEach, expect, it, vi } from "vitest";

import { createLiveClient } from "../web/src/lib/live";

class Source {
  readyState = 1;
  listeners = new Map<string, (event: MessageEvent | Event) => void>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent | Event) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, topic = "panel", data: unknown = 1) {
    this.listeners.get(type)?.({ data: JSON.stringify({ topic, data, revision: 1 }) } as MessageEvent);
  }
}
const tick = () => Promise.resolve();
afterEach(() => vi.useRealTimers());
function setup(options = {}) {
  const sources: Source[] = [];
  const live = createLiveClient({
    ...options,
    createSource: (url) => {
      const source = new Source(url);
      sources.push(source);
      return source;
    },
  });
  return { live, sources };
}

it("keeps shared data fresh and status open until every replacement topic answers", async () => {
  const { live, sources } = setup();
  const panel = live.use("panel");
  await tick();
  sources[0].emit("snapshot");
  const logs = live.use("logs");
  await tick();
  expect(live.status.value).toBe("open");
  expect(panel.state.stale).toBe(false);
  sources[0].emit("update", "panel", 2);
  expect(panel.state.data).toBe(2);
  sources[1].emit("snapshot", "panel", 3);
  sources[0].emit("update", "panel", 0);
  expect(panel.state.data).toBe(3);
  expect(sources[0].readyState).toBe(1);
  sources[1].emit("unavailable", "logs");
  expect(logs.state.unavailable).toBe(true);
  expect(sources[0].readyState).toBe(2);
  sources[0].emit("closed");
  expect(live.status.value).toBe("open");
  live.stop();
});

it("cancels rapid A to B to A handovers and releases all sources with no refs", async () => {
  const { live, sources } = setup();
  const panel = live.use("panel");
  await tick();
  sources[0].emit("snapshot");
  const logs = live.use("logs");
  await tick();
  logs.release();
  await tick();
  expect(sources).toHaveLength(2);
  expect(sources[1].readyState).toBe(2);
  sources[1].emit("unavailable");
  expect(panel.state.data).toBe(1);
  panel.release();
  await tick();
  expect(sources[0].readyState).toBe(2);
  expect(live.status.value).toBe("idle");
  live.stop();
});

it("bounds hidden subscriptions and retains native retries on a real drop", async () => {
  vi.useFakeTimers();
  const { live, sources } = setup();
  const panel = live.use("panel");
  await tick();
  sources[0].emit("snapshot");
  live.use("logs");
  await tick();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(sources[0].readyState).toBe(2);
  expect(panel.state.stale).toBe(true);
  sources[1].emit("snapshot");
  sources[1].emit("error");
  expect(panel.state.data).toBe(1);
  expect(panel.state.stale).toBe(true);
  expect(live.status.value).toBe("reconnecting");
  expect(sources).toHaveLength(2);
  sources[1].emit("update", "panel", 2);
  expect(panel.state.stale).toBe(false);
  live.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("revocation closes both sources and late hard-failure promises cannot undo reset or stop", async () => {
  vi.useFakeTimers();
  let resolve!: (retry: boolean) => void;
  const ended = vi.fn();
  const { live, sources } = setup({
    onSessionEnded: ended,
    onHardFailure: () =>
      new Promise<boolean>((r) => {
        resolve = r;
      }),
  });
  live.use("panel");
  await tick();
  sources[0].emit("snapshot");
  live.use("logs");
  await tick();
  sources[1].emit("closed");
  expect(ended).toHaveBeenCalledOnce();
  expect(sources.every((source) => source.readyState === 2)).toBe(true);
  live.reconnect();
  await tick();
  expect(sources).toHaveLength(2);
  live.reset();
  await tick();
  sources[2].readyState = 2;
  sources[2].emit("error");
  live.reset();
  await tick();
  resolve(true);
  await tick();
  expect(vi.getTimerCount()).toBe(0);
  live.stop();
  sources[3].emit("update");
  expect(live.status.value).toBe("idle");
});

it("warns when the incumbent drops during handover and replaces hidden topic polling", async () => {
  vi.useFakeTimers();
  const { live, sources } = setup();
  const panel = live.use("panel");
  const logs = live.use("logs");
  await tick();
  sources[0].emit("snapshot");
  sources[0].emit("snapshot", "logs");
  logs.release();
  await tick();
  sources[0].emit("error");
  expect(sources[0].readyState).toBe(2);
  expect(panel.state.stale).toBe(true);
  expect(live.status.value).toBe("reconnecting");
  sources[1].emit("snapshot", "panel", 2);
  expect(panel.state.stale).toBe(false);
  expect(live.status.value).toBe("open");
  expect(vi.getTimerCount()).toBe(0);
  live.stop();
});

it("keeps the incumbent deadline bounded across repeated subscription changes", async () => {
  vi.useFakeTimers();
  const { live, sources } = setup();
  live.use("panel");
  const logs = live.use("logs");
  await tick();
  sources[0].emit("snapshot");
  sources[0].emit("snapshot", "logs");
  logs.release();
  await tick();
  await vi.advanceTimersByTimeAsync(10_000);
  live.use("usage");
  await tick();
  expect(sources[1].readyState).toBe(2);
  expect(sources[0].readyState).toBe(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sources[0].readyState).toBe(2);
  expect(sources[2].readyState).toBe(1);
  expect(live.status.value).toBe("reconnecting");
  live.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("retries a closed replacement and cancels its retry when all subscribers leave", async () => {
  vi.useFakeTimers();
  const hardFailure = vi.fn(async () => true);
  const { live, sources } = setup({ onHardFailure: hardFailure });
  const panel = live.use("panel");
  await tick();
  sources[0].emit("snapshot");
  const logs = live.use("logs");
  await tick();
  sources[1].readyState = 2;
  sources[1].emit("error");
  await tick();
  expect(hardFailure).toHaveBeenCalledOnce();
  expect(sources[0].readyState).toBe(2);
  expect(panel.state.stale).toBe(true);
  expect(live.status.value).toBe("reconnecting");
  expect(vi.getTimerCount()).toBe(1);
  panel.release();
  logs.release();
  await tick();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sources).toHaveLength(2);
  expect(live.status.value).toBe("idle");
  live.stop();
});

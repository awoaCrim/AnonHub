import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { cachedFetch, clearCaches, onCacheRefresh, readPersisted, setCacheOwner } from "../web/src/lib/cache";
import { createLiveClient } from "../web/src/lib/live";

class MemoryStorage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  clearCaches();
  setCacheOwner("admin");
});
afterEach(() => {
  clearCaches();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

it("serves cached GETs at once, revalidates in the background and notifies on change", async () => {
  vi.useFakeTimers();
  let version = 1;
  const fetcher = vi.fn(async () => json({ version }));
  const first = await cachedFetch(fetcher as typeof fetch, "/yesimbot/model-settings");
  expect(await first.json()).toEqual({ version: 1 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  // Within the fresh window the cache answers without touching the network.
  await cachedFetch(fetcher as typeof fetch, "/yesimbot/model-settings");
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5000);
  version = 2;
  const refreshed = vi.fn();
  const stop = onCacheRefresh(refreshed);
  const stale = await cachedFetch(fetcher as typeof fetch, "/yesimbot/model-settings");
  expect(await stale.json()).toEqual({ version: 1 });
  await vi.waitFor(() => expect(refreshed).toHaveBeenCalledWith("/yesimbot/model-settings"));
  expect(await (await cachedFetch(fetcher as typeof fetch, "/yesimbot/model-settings")).json()).toEqual({ version: 2 });
  stop();
});

it("never caches failures or unlisted paths, and writes drop cached reads of the same area", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => (String(input).includes("fail") ? json({ message: "x" }, 401) : json({ ok: String(input) })));
  expect((await cachedFetch(fetcher as typeof fetch, "/yesimbot/napcat/qrcode")).ok).toBe(true);
  await cachedFetch(fetcher as typeof fetch, "/yesimbot/napcat/qrcode");
  expect(fetcher).toHaveBeenCalledTimes(2);
  await cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/plugins/config?path=a");
  await cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/plugins/config?path=a");
  expect(fetcher).toHaveBeenCalledTimes(3);
  await cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/plugins/update", { method: "POST" });
  await cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/plugins/config?path=a");
  expect(fetcher).toHaveBeenCalledTimes(5);
  // Plugin configs stay in memory only; listed persistent reads survive a reload.
  expect([...storage.data.keys()].some((key) => key.includes("plugins/config"))).toBe(false);
  await cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/system");
  expect(readPersisted("get:/yesimbot/api/v1/system")).toBeTruthy();
  clearCaches();
  expect(storage.data.size).toBe(0);
});

it("keeps other plugins' configs and schemas when one plugin saves or switches", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => json({ ok: String(input) }));
  const config = (path: string) => `/yesimbot/api/v1/plugins/config?path=${encodeURIComponent(path)}`;
  const reads = [config("yesimbot:core"), config("yesimbot-memorizer:m"), "/yesimbot/api/v1/plugins/schema?name=yesimbot"];
  for (const path of reads) await cachedFetch(fetcher as typeof fetch, path);
  expect(fetcher).toHaveBeenCalledTimes(3);
  // Enabling renames the key (`~yesimbot:core`); that is the same plugin, so its cached config is dropped too.
  const body = JSON.stringify({ path: "~yesimbot:core", revision: "r", enabled: true });
  await cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/plugins/enabled", { method: "POST", body });
  for (const path of reads) await cachedFetch(fetcher as typeof fetch, path);
  expect(fetcher.mock.calls.slice(4).map(([input]) => String(input))).toEqual([config("yesimbot:core")]);
});

it("shows a persisted topic snapshot as cached until the stream confirms it", () => {
  const sources: Array<{ listeners: Map<string, (event: unknown) => void> }> = [];
  const make = () =>
    createLiveClient({
      persist: (topic) => topic === "panel",
      createSource: () => {
        const source = {
          readyState: 0,
          listeners: new Map<string, (event: unknown) => void>(),
          addEventListener: (type: string, fn: (event: unknown) => void) => source.listeners.set(type, fn),
          close: () => {},
        };
        sources.push(source);
        return source;
      },
    });
  const live = make();
  const { state } = live.use<{ value: number }>("panel");
  expect(state.data).toBeUndefined();
  return Promise.resolve().then(() => {
    sources[0].listeners.get("snapshot")!({ data: JSON.stringify({ topic: "panel", revision: 1, data: { value: 7 } }) });
    expect(state).toMatchObject({ data: { value: 7 }, cached: false, stale: false });
    const reloaded = make().use<{ value: number }>("panel").state;
    expect(reloaded).toMatchObject({ data: { value: 7 }, cached: true, stale: true });
  });
});

it("coalesces simultaneous reads while giving each caller its own response body", async () => {
  const fetcher = vi.fn(async () => json({ devices: [] }));
  const responses = await Promise.all([
    cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/devices"),
    cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/devices"),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await responses[0]!.json()).toEqual({ devices: [] });
  expect(await responses[1]!.json()).toEqual({ devices: [] });
});

it("does not let a read started before a write repopulate stale configuration", async () => {
  let resolve!: (value: Response) => void;
  const path = "/yesimbot/api/v1/plugins/config?path=a";
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(json({ ok: true }))
    .mockResolvedValueOnce(json({ version: 2 }));
  const pending = cachedFetch(fetcher as typeof fetch, path);
  await cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/plugins/update", { method: "POST" });
  resolve(json({ version: 1 }));
  await pending;
  expect(await (await cachedFetch(fetcher as typeof fetch, path)).json()).toEqual({ version: 2 });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("does not retain an old account's late response after switching accounts", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(json({ owner: "next" }));
  const pending = cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/devices");
  setCacheOwner("next");
  resolve(json({ owner: "old" }));
  await pending;
  expect(await (await cachedFetch(fetcher as typeof fetch, "/yesimbot/api/v1/devices")).json()).toEqual({ owner: "next" });
});

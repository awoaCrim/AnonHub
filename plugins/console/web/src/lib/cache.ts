import { clearEditorDrafts } from "./editor-drafts";
/**
 * Client-side caches that hide the slow origin round trip (seconds through the
 * public tunnel): last known topic snapshots and GET responses are shown at once
 * and refreshed in the background. The server still authorizes every request;
 * nothing secret is cached (API keys never leave the server, plugin configs stay in memory).
 */

const PREFIX = "yesimbot:cache:v1:";
const MAX_ITEM = 512 * 1024;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function storage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

let owner = "";
let epoch = 0;
const versions = new Map<string, number>();
const views = new Map<string, unknown>();
/** Small account-scoped in-memory view snapshots; never serialized to browser storage. */
export function readView<T>(key: string): T | undefined {
  return views.get(key) as T | undefined;
}

export function writeView(key: string, value: unknown): void {
  views.delete(key);
  views.set(key, value);
  if (views.size > 32) views.delete(views.keys().next().value!);
}

function resetMemory() {
  epoch++;
  memory.clear();
  inflight.clear();
  versions.clear();
  views.clear();
}

/** Scopes persisted entries to one signed-in user; an empty name disables persistence. */
export function setCacheOwner(username: string): void {
  if (owner !== username) {
    resetMemory();
    clearEditorDrafts();
  }
  owner = username;
}

export function readPersisted<T>(key: string): T | undefined {
  if (!owner) return;
  try {
    const raw = storage()?.getItem(PREFIX + owner + ":" + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return;
  }
}

export function writePersisted(key: string, value: unknown): void {
  if (!owner) return;
  try {
    const raw = JSON.stringify(value);
    const store = storage();
    if (raw.length > MAX_ITEM) store?.removeItem(PREFIX + owner + ":" + key);
    else store?.setItem(PREFIX + owner + ":" + key, raw);
  } catch {
    // Quota or privacy mode: the cache is a convenience only.
  }
}

/** Logout: forget everything cached for every user on this browser. */
export function clearCaches(): void {
  clearEditorDrafts();
  resetMemory();
  owner = "";
  try {
    const store = storage();
    if (!store) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Ignore unavailable storage.
  }
}

interface Entry {
  text: string;
  at: number;
}

/** GET endpoints whose last response may be shown while a fresh one loads. */
const RULES: Array<{ pattern: RegExp; persist: boolean; ttl?: number }> = [
  { pattern: /^\/yesimbot\/model-settings$/, persist: true },
  { pattern: /^\/yesimbot\/napcat\/status$/, persist: true },
  { pattern: /^\/yesimbot\/admin\/accounts$/, persist: true },
  { pattern: /^\/yesimbot\/api\/v1\/system$/, persist: true },
  { pattern: /^\/yesimbot\/api\/v1\/plugins\/schema\?/, persist: true, ttl: 300_000 },
  { pattern: /^\/yesimbot\/api\/v1\/plugins\/config\?/, persist: false, ttl: 30_000 },
  { pattern: /^\/yesimbot\/api\/v1\/connectors\/google$/, persist: false, ttl: 15_000 },
  { pattern: /^\/yesimbot\/admin\/context-policy$/, persist: false, ttl: 30_000 },
  { pattern: /^\/yesimbot\/api\/v1\/devices$/, persist: false },
];

const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<Response>>();
const listeners = new Set<(path: string) => void>();
/** Responses younger than this are reused without a background check. */
const FRESH_MS = 3000;

function rule(path: string) {
  return RULES.find((item) => item.pattern.test(path));
}

function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, "http://local");
  return url.pathname + url.search;
}

/** Writes invalidate cached reads of the same area (e.g. any plugins/* POST drops plugins/config). */
function area(path: string): string {
  const segments = path.split("?")[0].split("/").filter(Boolean);
  return "/" + segments.slice(0, segments[1] === "api" ? 4 : 2).join("/");
}

const CONFIG_READ = "/yesimbot/api/v1/plugins/config?path=";
/** The same plugin instance across enable/disable (`~name:id`); kept in step with `pluginIdentity`. */
const identity = (path: string) => path.replace(/(^|\/)~(?=[^/]*$)/, "$1");

/**
 * Saving or switching one plugin changes only that plugin's config (user, 2026-11-21: settings must not reload all
 * over a ~1s link after each autosave). Other plugins' configs and every schema stay cached. Any other plugin write
 * (add, remove, move) still drops the whole area.
 */
function ownConfig(path: string, body: unknown): ((key: string) => boolean) | undefined {
  if (!/^\/yesimbot\/api\/v1\/plugins\/(?:update|enabled)$/.test(path.split("?")[0]) || typeof body !== "string") return;
  let target: unknown;
  try {
    target = (JSON.parse(body) as { path?: unknown }).path;
  } catch {
    return;
  }
  if (typeof target !== "string" || !target) return;
  const id = identity(target);
  return (key) => {
    if (!key.startsWith(CONFIG_READ)) return false;
    try {
      return identity(decodeURIComponent(key.slice(CONFIG_READ.length))) === id;
    } catch {
      return true;
    }
  };
}

function lookup(path: string, persist: boolean): Entry | undefined {
  const hit = memory.get(path);
  if (hit || !persist) return hit;
  const stored = readPersisted<Entry>("get:" + path);
  if (stored && typeof stored.text === "string") memory.set(path, stored);
  return stored;
}

function respond(text: string): Response {
  return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Notified when a background refresh returned different data for `path`. */
export function onCacheRefresh(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function cachedFetch(fetcher: typeof fetch, input: RequestInfo | URL, init?: RequestInit, fresh = false): Promise<Response> {
  const path = pathOf(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    const own = ownConfig(path, init?.body);
    const invalidate = () => {
      const prefix = area(path);
      for (const key of new Set([...memory.keys(), ...inflight.keys(), ...versions.keys()]))
        if (own ? own(key) : key.startsWith(prefix)) {
          memory.delete(key);
          inflight.delete(key);
          versions.set(key, (versions.get(key) ?? 0) + 1);
        }
      // Plugin configs are never persisted, so a plugin's own write leaves storage alone.
      if (!own) removePersisted(prefix);
    };
    invalidate();
    return fetcher(input, init).finally(invalidate);
  }
  const matched = rule(path);
  if (!matched) return fetcher(input, init);
  const load = () => {
    let request = fresh ? undefined : inflight.get(path);
    if (!request) {
      const currentEpoch = epoch;
      const version = (versions.get(path) ?? 0) + 1;
      versions.set(path, version);
      // A background refresh outlives the initiating component and has its own bounded timeout.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const signal = fresh ? init?.signal : controller.signal;
      request = fetcher(input, { ...init, signal, cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return response;
          const text = await response.text();
          if (currentEpoch === epoch && versions.get(path) === version) {
            const previous = memory.get(path);
            const entry = { text, at: Date.now() };
            memory.set(path, entry);
            if (matched.persist) writePersisted("get:" + path, entry);
            if (previous && previous.text !== text) for (const listener of [...listeners]) listener(path);
          }
          return respond(text);
        })
        .finally(() => {
          clearTimeout(timeout);
          if (inflight.get(path) === request) inflight.delete(path);
        });
      inflight.set(path, request);
    }
    // Each consumer owns a body, including non-200 responses.
    return request.then((response) => response.clone());
  };
  if (fresh) return load();
  const hit = lookup(path, matched.persist);
  if (!hit) return load();
  if (Date.now() - hit.at > (matched.ttl ?? FRESH_MS)) void load().catch(() => {});
  return Promise.resolve(respond(hit.text));
}

function removePersisted(prefix: string) {
  if (!owner) return;
  try {
    const store = storage();
    if (!store) return;
    const start = PREFIX + owner + ":get:" + prefix;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(start)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Ignore unavailable storage.
  }
}

/** Warms the cache in the background; failures are ignored (the page will retry). */
export function prefetch(paths: string[], fetcher: typeof fetch = (...args) => fetch(...args), concurrency = 4): Promise<void> {
  const queue = paths.filter((path) => rule(path));
  const worker = async () => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      try {
        const response = await cachedFetch(fetcher, path, { credentials: "same-origin", headers: { Accept: "application/json" } });
        if (response.status === 401) return;
      } catch {
        // Ignore: the page loads it on demand.
      }
    }
  };
  return Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker)).then(() => {});
}

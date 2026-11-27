// One writer per document/module instance, shared by every draft handle in that tab.
const documentWriterId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

/** Unsaved edits persisted per page. Storage can be unavailable (private mode); every access is guarded. */
export interface DraftStore<T> {
  load(): { value: T; savedAt: number } | undefined;
  save(value: T): void;
  clear(): void;
  clearOwned(): void;
}

export function createDraft<T>(
  key: string,
  version: number,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = safeStorage(),
  writerId: string = documentWriterId,
): DraftStore<T> {
  const name = `yesimbot:draft:${key}`;
  return {
    load() {
      try {
        const raw = storage?.getItem(name);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { version?: number; savedAt?: number; value?: T };
        if (parsed.version !== version || typeof parsed.savedAt !== "number") return;
        return { value: parsed.value as T, savedAt: parsed.savedAt };
      } catch {
        return;
      }
    },
    save(value) {
      try {
        storage?.setItem(name, JSON.stringify({ version, savedAt: Date.now(), value, writerId }));
      } catch {
        // Quota or privacy mode: drafts are a convenience only.
      }
    },
    clearOwned() {
      try {
        const raw = storage?.getItem(name);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { version?: number; writerId?: string };
        if (parsed.version === version && parsed.writerId === writerId) storage?.removeItem(name);
      } catch {
        // Invalid or unavailable drafts must never cause another document's edits to be deleted.
      }
    },
    clear() {
      try {
        storage?.removeItem(name);
      } catch {
        // Ignored for the same reason.
      }
    },
  };
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

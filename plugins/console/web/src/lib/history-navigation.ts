import type { Codec } from "./route-state";

export const pageCodec: Codec<number> = {
  parse: (raw) => (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : undefined),
  serialize: String,
};
export const expandedCodec: Codec<string[]> = {
  parse(raw) {
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
    } catch {
      return undefined;
    }
  },
  serialize: (value) => (value.length ? JSON.stringify(value) : ""),
};

export interface HistoryList {
  /** Old list paths still accepted (they redirect to the current list). */
  aliases?: readonly string[];
  /** Fallback query for the list, e.g. the Xiaoheihe tab of the history page. */
  query?: Readonly<Record<string, string>>;
}

/** Detail return targets must resolve to this local list (or one of its old paths), never a different route or origin. */
export function historyReturnTo(value: unknown, listPath: string, list: HistoryList = {}): string {
  const fallback = list.query && Object.keys(list.query).length ? `${listPath}?${new URLSearchParams(list.query)}` : listPath;
  const paths = [listPath, ...(list.aliases ?? [])];
  if (typeof value !== "string" || !paths.some((path) => value === path || value.startsWith(`${path}?`))) return fallback;
  try {
    const url = new URL(value, "https://local.invalid");
    if (url.origin !== "https://local.invalid" || !paths.includes(url.pathname) || url.hash) return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

export function sortedSessions<T extends { filename: string }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => b.filename.localeCompare(a.filename));
}

export function historySessions<T extends { filename: string }>(sessions: T[], expanded: boolean): T[] {
  const ordered = sortedSessions(sessions);
  return expanded ? ordered : ordered.slice(0, 4);
}

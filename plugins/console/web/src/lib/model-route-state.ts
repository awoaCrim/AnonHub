/** Stable across refresh; index disambiguates duplicate and unnamed models. */
export function modelSelectionKey(id: string, index: number): string {
  return `${index}:${id}`;
}
/** The connection shown when none is named: the first enabled one, else the first. */
export function defaultConnectionKey(connections: Array<{ key: string; enabled?: boolean }>): string {
  return (connections.find((item) => item.enabled !== false) ?? connections[0])?.key ?? "roles";
}

export function resolveConnectionSelection(requested: string, connections: Array<{ key: string; id: string; enabled?: boolean }>): string {
  if (requested === "roles") return "roles";
  // An empty request must not match a connection whose ID is still blank.
  const named = requested ? (connections.find((item) => item.id === requested) ?? connections.find((item) => item.key === requested)) : undefined;
  return named?.key ?? defaultConnectionKey(connections);
}

/** Prefer identity after row deletion; a bounded index also restores renamed drafts. */
export function resolveModelSelection(requested: string, rows: Array<{ key: string }>): string {
  if (rows.some((row) => row.key === requested)) return requested;
  const match = /^(0|[1-9]\d*):(.*)$/s.exec(requested);
  const index = match ? Number(match[1]) : -1;
  if (Number.isSafeInteger(index) && index >= 0) {
    const id = match![2];
    if (id) {
      const matches = rows.filter((row) => row.key.slice(row.key.indexOf(":") + 1) === id);
      if (matches.length === 1) return matches[0]!.key;
    }
    if (rows[index]) return rows[index]!.key;
  }
  return rows[0]?.key ?? "";
}

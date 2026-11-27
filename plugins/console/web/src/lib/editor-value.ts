/** Compare JSON editor data by content: object key order is not a user edit. Arrays retain their order. */
export function editorValue(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, item[key]]),
    );
  });
}

import { computed, type WritableComputedRef } from "vue";
import { useRoute, useRouter, type LocationQuery, type LocationQueryRaw, type Router } from "vue-router";

export interface Codec<T> {
  parse(raw: string): T | undefined;
  serialize(value: T): string;
}

export const stringCodec: Codec<string> = { parse: (raw) => raw, serialize: (value) => value };
export const numberCodec: Codec<number> = {
  parse: (raw) => (/^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : undefined),
  serialize: (value) => String(value),
};
export const booleanCodec: Codec<boolean> = {
  parse: (raw) => (raw === "1" ? true : raw === "0" ? false : undefined),
  serialize: (value) => (value ? "1" : "0"),
};
export const listCodec: Codec<string[]> = {
  parse: (raw) => raw.split(",").filter(Boolean),
  serialize: (value) => value.join(","),
};

/** Pure query update used by the composable; defaults are omitted to keep URLs short. */
export function nextQuery<T>(query: LocationQuery, key: string, value: T, defaultValue: T, codec: Codec<T>): LocationQueryRaw {
  const next: LocationQueryRaw = { ...query };
  const serialized = codec.serialize(value);
  if (serialized === codec.serialize(defaultValue) || serialized === "") delete next[key];
  else next[key] = serialized;
  return next;
}

export function readQuery<T>(query: LocationQuery, key: string, defaultValue: T, codec: Codec<T>): T {
  const raw = query[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return defaultValue;
  return codec.parse(value) ?? defaultValue;
}

// Several fields may change in one tick (a filter also resets the page). Each
// replace must build on the not-yet-committed query, or later writes drop earlier ones.
const pending = new WeakMap<Router, LocationQuery>();

export function writeQuery<T>(router: Router, key: string, value: T, defaultValue: T, codec: Codec<T>): Promise<unknown> {
  const base = pending.get(router) ?? router.currentRoute.value.query;
  const next = nextQuery(base, key, value, defaultValue, codec) as LocationQuery;
  pending.set(router, next);
  return router.replace({ query: next, hash: router.currentRoute.value.hash }).finally(() => {
    if (pending.get(router) === next) pending.delete(router);
  });
}

/**
 * View state stored in the URL query, so refresh, back/forward and shared links
 * reproduce the same view. Uses replace to avoid flooding history.
 */
export function useRouteState<T>(key: string, defaultValue: T, codec: Codec<T> = stringCodec as unknown as Codec<T>): WritableComputedRef<T> {
  const route = useRoute();
  const router = useRouter();
  return computed({
    get: () => {
      // Always track the committed route, even while an optimistic query exists.
      // WeakMap cleanup is not reactive; short-circuiting this read drops the
      // dependency after the first navigation and freezes later query renders.
      const committed = route.query;
      return readQuery(pending.get(router) ?? committed, key, defaultValue, codec);
    },
    set: (value) => void writeQuery(router, key, value, defaultValue, codec),
  });
}

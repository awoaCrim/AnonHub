import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** A record ID (UUID v4). */
export function newId(): string {
  return randomUUID();
}

/**
 * A token or key: `bytes` random bytes as base64url. `hex` is for a protocol that fixes that form (the device
 * protocol's credentials and pairing codes).
 */
export function newSecret(bytes = 32, options: { encoding?: "base64url" | "hex" } = {}): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 1024) throw new RangeError("secret length must be 16 to 1024 bytes");
  return randomBytes(bytes).toString(options.encoding ?? "base64url");
}

/** What is stored instead of a secret: its SHA-256, hex. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Compares a presented secret with the expected one in constant time. Both must be strings of the given format and
 * length; anything else is unequal.
 */
export function safeEqual(a: unknown, b: unknown, options: { format?: RegExp; length?: number } = {}): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  for (const value of [a, b]) {
    if (options.length !== undefined && value.length !== options.length) return false;
    if (options.format && !new RegExp(options.format.source, options.format.flags.replace(/[gy]/g, "")).test(value)) return false;
  }
  // Equal-length digests make the comparison constant time whatever the inputs' lengths are.
  return timingSafeEqual(createHash("sha256").update(a, "utf8").digest(), createHash("sha256").update(b, "utf8").digest()) && a === b;
}

/** SHA-256 of content, hex, cut to `hexLength` (at least 16, that is 64 bits). */
export function contentHash(bytes: Uint8Array | string, options: { hexLength?: number } = {}): string {
  const length = options.hexLength ?? 64;
  if (!Number.isInteger(length) || length < 16 || length > 64) throw new RangeError("hexLength must be 16 to 64");
  return createHash("sha256").update(bytes).digest("hex").slice(0, length);
}

/** SHA-256 of a JSON value with object keys sorted, for etags and revisions. */
export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** JSON with object keys sorted at every level; same omissions as `JSON.stringify`. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort()) sorted[key] = (item as Record<string, unknown>)[key];
    return sorted;
  });
}

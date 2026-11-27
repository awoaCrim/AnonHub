/** A non-null, non-array object: what a parsed JSON value or an untrusted payload is checked as before its fields are read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

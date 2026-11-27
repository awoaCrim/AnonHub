import { z } from "zod/v4";

/** Config pieces several modules share, in zod (convention 02). */

/** A per-model override of native thinking-level values: each level maps to one of `nativeValues`, or `null` (不支持). */
export function thinkingLevelMapConfig(nativeValues: readonly string[]) {
  return z.record(z.string(), z.union([z.literal(null).meta({ title: "不支持" }), ...nativeValues.map((value) => z.literal(value))]));
}

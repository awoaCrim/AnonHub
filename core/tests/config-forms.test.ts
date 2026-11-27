import { describe, expect, it } from "vitest";

import { thinkingLevelMapConfig } from "../src/config-forms.js";

describe("shared config pieces", () => {
  it("maps thinking levels to native values or null", () => {
    const map = thinkingLevelMapConfig(["low", "high"]);
    expect(map.parse({ low: "low", off: null })).toEqual({ low: "low", off: null });
    expect(map.safeParse({ low: "nope" }).success).toBe(false);
  });
});

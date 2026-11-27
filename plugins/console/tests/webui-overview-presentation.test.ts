import { expect, it } from "vitest";

import { formatMemoryRatio, modelIdentity } from "../web/src/pages/overview-model";

it("shows the panel's memory fractions as percentages without inventing missing measurements", () => {
  expect(formatMemoryRatio(0.0325)).toBe("3.3%");
  expect(formatMemoryRatio(0.726)).toBe("72.6%");
  expect(formatMemoryRatio(0)).toBe("0.0%");
  expect(formatMemoryRatio(1)).toBe("100.0%");
  for (const value of [undefined, null, NaN, Infinity, -0.1, 1.1, "0.2"]) {
    expect(formatMemoryRatio(value)).toBe("未知");
  }
});

it("separates the connection from a complete model ID, retaining colons inside that ID", () => {
  expect(modelIdentity("antigravity-gemini:gemini-2.5-pro:preview")).toEqual({
    provider: "antigravity-gemini",
    modelId: "gemini-2.5-pro:preview",
  });
  expect(modelIdentity("plain-model")).toEqual({ modelId: "plain-model" });
  expect(modelIdentity("provider:")).toEqual({ modelId: "provider:" });
  expect(modelIdentity(null)).toEqual({});
});

import { configForm, parseConfig } from "@yesimbot/foundation";
import { describe, expect, it } from "vitest";

import { moduleConfig } from "../src/config.js";

describe("sticker-manager moduleConfig", () => {
  it("omits the unused per-plugin classification model selector", () => {
    const form = configForm(moduleConfig.schema) as { properties: Record<string, unknown> };
    expect(Object.hasOwn(form.properties, "classificationModel")).toBe(false);
    expect(parseConfig(moduleConfig, {})).not.toHaveProperty("classificationModel");
  });
  it("leaves collecting and managing to the tool policy instead of separate switches", () => {
    const parsed = parseConfig(moduleConfig, {});
    expect(parsed).not.toHaveProperty("enableSteal");
    expect(parsed).not.toHaveProperty("enableManage");
  });
});

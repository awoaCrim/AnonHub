import { configForm, parseConfig } from "@yesimbot/foundation";
import { describe, expect, it } from "vitest";

import { moduleConfig } from "../src/config.js";

type Field = { hidden?: boolean };

describe("roleplay configuration", () => {
  it("needs nothing: an empty config is valid", () => {
    expect(parseConfig(moduleConfig, {})).toEqual({ characterCards: [] });
  });

  it("retains the default card and unknown keys", () => {
    expect(parseConfig(moduleConfig, { characterCard: "abc", extra: 1 })).toMatchObject({ characterCard: "abc", extra: 1 });
  });

  it("shows nothing in the settings form: the library is edited on the role page", () => {
    const form = configForm(moduleConfig.schema) as { properties: Record<string, Field> };
    expect(Object.values(form.properties).every((field) => field.hidden)).toBe(true);
  });
});

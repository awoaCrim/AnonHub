import { configForm, parseConfig } from "@yesimbot/foundation";
import { describe, expect, it } from "vitest";

import { moduleConfig } from "../src/index.js";

describe("memorizer configuration", () => {
  it("omits the retired model selector and internal tuning while retaining embedding settings", () => {
    const form = JSON.stringify(configForm(moduleConfig.schema));
    for (const retired of ["model", "dataPath", "batchDelayMs", "maxPendingPerBatch", "searchTimeoutMs", "halfLifeDays", "semanticQueryPrefix"]) {
      expect(form).not.toContain(`"${retired}":`);
    }
    expect(parseConfig(moduleConfig, {})).not.toHaveProperty("model");
    expect(parseConfig(moduleConfig, { embeddingModel: "test:embedding" })).toMatchObject({ embeddingModel: "test:embedding" });
  });
});

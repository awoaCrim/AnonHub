import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineModuleConfig } from "@yesimbot/foundation";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { ConfigStore } from "../src/config/store.js";

describe("plugin schema catalog", () => {
  it("limits resolution to installed/configured plugins, expands refs and refreshes dynamic options", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "plugin-catalog-"));
    try {
      let dynamic = { toJSON: () => ({ type: "union", list: [{ type: "const", value: "first" }] }) };
      const resolve = vi.fn(async () => ({
        moduleConfig: defineModuleConfig("catalog-fixture", z.object({ model: z.string().optional().meta({ optionsSource: "models.chat" }) })),
        usage: "plain <script> text",
      }));
      // Every module the host runs is in its config tree, those that are off too.
      const plugins = { example: {}, "~http": {}, "@scope/special": {} };
      const ctx = { baseDir, schema: { get: () => dynamic }, loader: { config: { plugins }, writable: true, resolve } };
      const catalog = new ConfigStore(ctx as never).catalog;
      expect((await catalog.available()).map((entry) => entry.name)).toEqual(["@scope/special", "example", "http"]);
      await expect(catalog.schema("../../outside")).rejects.toMatchObject({ code: "not_found" });
      expect(resolve).not.toHaveBeenCalled();
      const first = await catalog.schema("example");
      expect(first.schema?.dict?.model).toMatchObject({ type: "dynamic", name: "registry.chatModels" });
      expect(first.dynamics["registry.chatModels"].list?.[0].value).toBe("first");
      dynamic = { toJSON: () => ({ type: "union", list: [{ type: "const", value: "second" }] }) };
      expect((await catalog.schema("example")).dynamics["registry.chatModels"].list?.[0].value).toBe("second");
      expect(resolve).toHaveBeenCalledOnce();
      catalog.invalidate();
      await catalog.schema("example");
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { AppError, checkConfig, configForm, defineModuleConfig, isSecretRef, parseConfig, resolveSecretRefs } from "../src/index.js";

const schema = z.looseObject({
  enabled: z.boolean().default(true).meta({ title: "启用" }),
  apiKey: z.string().optional().meta({ title: "密钥", secret: true }),
  model: z
    .string()
    .default("")
    .meta({ title: "模型", optionsSource: "models.chat", visibleTo: ["owner"] }),
  items: z
    .array(z.object({ id: z.string() }))
    .default([])
    .meta({ widget: "table", group: "高级" }),
  limit: z.number().default(5).meta({ title: "上限", unit: "条" }),
});
const example = defineModuleConfig("example-module", schema);

describe("module config", () => {
  it("fills defaults, keeps unknown keys and never changes the raw value", () => {
    const raw = { apiKey: "k", extra: 1 };
    expect(parseConfig(example, raw)).toEqual({ enabled: true, apiKey: "k", model: "", items: [], limit: 5, extra: 1 });
    expect(raw).toEqual({ apiKey: "k", extra: 1 });
  });

  it("refuses a config that does not fit, with Chinese issues and the module in the detail", () => {
    expect(checkConfig(schema, { enabled: "yes" })).toEqual({ ok: false, issues: [{ path: ["enabled"], message: expect.stringMatching(/[㐀-鿿]/) }] });
    try {
      parseConfig(example, { items: [{}] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("config_invalid");
      expect((error as AppError).effect).toBe("none");
      expect((error as AppError).detail).toMatch(/^example-module: items\.0\.id /);
    }
  });

  it("builds the form from the input side with the form metadata on its nodes", () => {
    const form = configForm(schema) as { properties: Record<string, Record<string, unknown>>; required?: string[] };
    expect(form.required ?? []).toEqual([]);
    expect(form.properties.apiKey).toMatchObject({ title: "密钥", secret: true, type: "string" });
    expect(form.properties.model).toMatchObject({ optionsSource: "models.chat", visibleTo: ["owner"], default: "" });
    expect(form.properties.items).toMatchObject({ widget: "table", group: "高级", type: "array" });
    expect(form.properties.limit).toMatchObject({ unit: "条", type: "number" });
  });

  it("reads metadata written through the other zod build (CommonJS beside ESM)", () => {
    const other = createRequire(import.meta.url)("zod/v4") as { z: typeof z };
    expect(other.z.globalRegistry).not.toBe(z.globalRegistry);
    const shared = other.z.object({ a: other.z.string() }).default({ a: "" }).meta({ title: "共享", hidden: true });
    const form = configForm(z.looseObject({ shared })) as { properties: Record<string, Record<string, unknown>> };
    expect(form.properties.shared).toMatchObject({ title: "共享", hidden: true });
  });

  it("refuses metadata nothing reads and module IDs that are not kebab-case", () => {
    expect(() => defineModuleConfig("bad-meta", z.object({ a: z.string().meta({ role: "secret" }) }))).toThrow('unknown form metadata "role" at /properties/a');
    expect(() => defineModuleConfig("Bad_Id", z.object({}))).toThrow("kebab-case");
    // Property names that happen to equal metadata or keywords are data, not metadata.
    expect(() => configForm(z.object({ role: z.string(), widget: z.string() }))).not.toThrow();
  });

  it("resolves secret references from the secrets file and names a missing one without its value", () => {
    const config = { endpoint: "x", connections: [{ apiKey: { $secret: "/connections/0/apiKey" } }], note: { $secret: 1 } };
    const resolved = resolveSecretRefs(config, { "/connections/0/apiKey": "sk-real" });
    expect(resolved).toEqual({ endpoint: "x", connections: [{ apiKey: "sk-real" }], note: { $secret: 1 } });
    expect(config.connections[0]!.apiKey).toEqual({ $secret: "/connections/0/apiKey" });
    expect(isSecretRef({ $secret: "/a" })).toBe(true);
    expect(isSecretRef({ $secret: "/a", other: 1 })).toBe(false);
    expect(() => resolveSecretRefs(config, {}, "example-module")).toThrow(
      expect.objectContaining({ code: "config_secret_missing", detail: "example-module: /connections/0/apiKey" }),
    );
  });
});

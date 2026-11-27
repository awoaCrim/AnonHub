import { defineModuleConfig } from "@yesimbot/foundation";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { formNode, pluginConfigSource } from "../src/config/form.js";
import { redactSecrets, restoreSecrets } from "../src/config/secrets.js";

const moduleConfig = defineModuleConfig(
  "form-fixture",
  z.looseObject({
    enabled: z.boolean().default(true).meta({ title: "启用" }),
    apiKey: z.string().optional().meta({ title: "密钥", secret: true }),
    chatModel: z.string().optional().meta({ title: "对话模型", optionsSource: "models.chat" }),
    mode: z.enum(["fast", "slow"]).default("fast").meta({ title: "模式" }),
    limit: z.number().int().min(1).max(10).default(3).meta({ title: "上限", description: "每次最多处理的条数" }),
    endpoint: z.string().meta({ title: "地址" }),
    prompt: z.string().nullable().default(null).meta({ widget: "textarea", group: "高级" }),
    rules: z
      .array(z.object({ name: z.string(), weight: z.number() }))
      .default([])
      .meta({ widget: "table", group: "高级" }),
    headers: z.record(z.string(), z.string()).default({}).meta({ group: "高级" }),
  }),
);

describe("zod config forms in the console", () => {
  const source = pluginConfigSource({ moduleConfig });
  const form = source.form()!;

  it("turns grouped root fields into sections and keeps the rest under 基本设置", () => {
    expect(form.type).toBe("intersect");
    expect(form.list!.map((section) => section.meta?.description)).toEqual(["基本设置", "高级"]);
    expect(Object.keys(form.list![0]!.dict!)).toEqual(["enabled", "apiKey", "chatModel", "mode", "limit", "endpoint"]);
    expect(Object.keys(form.list![1]!.dict!)).toEqual(["prompt", "rules", "headers"]);
  });

  it("maps fields to the nodes and metadata the form renders", () => {
    const basic = form.list![0]!.dict!;
    const advanced = form.list![1]!.dict!;
    expect(basic.enabled).toEqual({ type: "boolean", meta: { description: "启用", default: true } });
    expect(basic.apiKey).toEqual({ type: "string", meta: { description: "密钥", role: "secret" } });
    expect(basic.chatModel).toEqual({ type: "dynamic", name: "registry.chatModels", meta: { description: "对话模型" } });
    expect(basic.mode).toEqual({
      type: "union",
      list: [
        { type: "const", value: "fast" },
        { type: "const", value: "slow" },
      ],
      meta: { description: "模式", default: "fast" },
    });
    expect(basic.limit).toEqual({ type: "number", meta: { description: "上限\n每次最多处理的条数", default: 3, min: 1, max: 10, step: 1 } });
    expect(basic.endpoint).toEqual({ type: "string", meta: { description: "地址", required: true } });
    expect(advanced.prompt).toMatchObject({ type: "string", meta: { role: "textarea", default: null } });
    expect(advanced.rules).toMatchObject({ type: "array", meta: { role: "table" }, inner: { type: "object", dict: { name: { meta: { required: true } } } } });
    expect(advanced.headers).toMatchObject({ type: "dict", inner: { type: "string" } });
  });

  it("checks a save against the zod definition and names the first bad field", () => {
    expect(source.check({ endpoint: "https://example.test" })).toBeUndefined();
    expect(source.check({})).toBe("endpoint");
    expect(source.check({ endpoint: "x", rules: [{ name: "a", weight: "heavy" }] })).toBe("rules[0].weight");
  });

  it("redacts and restores secrets through the converted form", () => {
    const stored = { endpoint: "x", apiKey: "sk-real" };
    const shown = redactSecrets(stored, form) as Record<string, unknown>;
    expect(shown.apiKey).toEqual({ $secret: true, sourcePath: ["apiKey"] });
    expect(restoreSecrets(shown, stored, form)).toEqual(stored);
  });

  it("gives a module without a zod definition no form and accepts any value", () => {
    const bare = pluginConfigSource({});
    expect(bare.form()).toBeNull();
    expect(bare.check({})).toBeUndefined();
    expect(pluginConfigSource(undefined).form()).toBeNull();
  });

  it("follows $ref definitions and stops at the first repeat", () => {
    expect(formNode({ $defs: { n: { type: "object", properties: { next: { $ref: "#/$defs/n" } } } }, $ref: "#/$defs/n" })).toEqual({
      type: "object",
      dict: { next: {} },
      meta: {},
    });
  });
});

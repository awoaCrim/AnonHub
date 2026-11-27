import { describe, expect, it } from "vitest";

import { ApiError, api } from "../web/src/lib/api";
import { flattenPlugins, pluginError, pluginStatus } from "../web/src/lib/plugin-config";
import { branch, resolve, emptyValue, switchBranch, validate, type Schema } from "../web/src/schema/schema-model";
import { createDraft } from "./legacy-draft-fixture";
const secret: Schema = { type: "string", meta: { role: "secret" } };
describe("插件 Schema 模型", () => {
  it("校验只看给出的值，不补默认值", () => {
    const schema: Schema = {
      type: "object",
      dict: {
        untouched: { type: "number", meta: { default: 3 } },
        edited: { type: "string" },
      },
    };
    expect(validate(schema, { unknown: { $if: "keep" }, edited: "new" })).toEqual([]);
  });
  it("动态、交集及联合分支支持原始值与对象值", () => {
    const options: Schema = {
      type: "union",
      list: [
        { type: "const", value: "a" },
        { type: "const", value: 2 },
      ],
    };
    expect(branch(options, 2)).toBe(1);
    expect(emptyValue(options)).toBe("a");
    expect(validate({ type: "dynamic", name: "models" }, "a", { models: options })).toEqual([]);
    expect(
      validate(
        {
          type: "intersect",
          list: [
            { type: "object", dict: { a: { type: "boolean" } } },
            { type: "object", dict: { b: { type: "number" } } },
          ],
        },
        { a: false, b: 2 },
      ),
    ).toEqual([]);
    expect(emptyValue({ type: "dict" })).toEqual({});
    expect(emptyValue({ type: "array" })).toEqual([]);
  });
  it("切换对象分支保留交集与未知字段", () => {
    const schema: Schema = {
      type: "union",
      list: [
        { type: "object", dict: { kind: { type: "const", value: "auth" }, token: secret } },
        { type: "object", dict: { kind: { type: "const", value: "none" } } },
      ],
    };
    const value = { kind: "auth", token: "private-token", shared: 42, extension: { keep: true } };
    const next = switchBranch(schema.list![1], value);
    expect(next).toEqual({ ...value, kind: "none" });
    expect(value.kind).toBe("auth");
    expect(switchBranch({ type: "const", value: false }, next)).toBe(false);
  });
  it("transform按输入Schema渲染校验且不吞掉union分支或密钥", () => {
    const numeric: Schema = { type: "transform", inner: { type: "number", meta: { min: 2 } }, meta: { description: "外层描述" } };
    expect(resolve(numeric)).toMatchObject({ type: "number", meta: { min: 2, description: "外层描述" } });
    expect(validate(numeric, 1)).toHaveLength(1);
    expect(branch({ type: "union", list: [numeric, { type: "string" }] }, "text")).toBe(1);
    expect(validate({ type: "never" }, "value")).toHaveLength(1);
    expect(branch({ type: "union", list: [{ type: "never" }, { type: "string" }] }, "text")).toBe(1);
  });
  it("必填、数值与长度范围、正则定位到嵌套字段", () => {
    const schema: Schema = {
      type: "object",
      dict: {
        required: { type: "string", meta: { required: true } },
        rows: {
          type: "array",
          inner: {
            type: "object",
            dict: {
              count: { type: "number", meta: { min: 2, max: 4 } },
              name: {
                type: "string",
                meta: { pattern: { source: "^ok$", flags: "" } },
              },
            },
          },
        },
      },
    };
    expect(validate(schema, { rows: [{ count: 1, name: "bad" }] }).map((v) => v.path)).toEqual(["required", "rows[0].count", "rows[0].name"]);
    expect(validate({ type: "string", meta: { min: 3 } }, "a")).toHaveLength(1);
    expect(validate({ type: "number", meta: { max: 3 } }, 5)).toHaveLength(1);
    expect(validate({ type: "string", meta: { required: true, default: "placeholder" } }, undefined)).toEqual([]);
  });
  it("并发错误保留独立草稿并提供固定中文文案", async () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memory.set(k, v);
      },
      removeItem: (k: string) => {
        memory.delete(k);
      },
    };
    const a = createDraft("plugin:owner:a:group/x", 1, storage),
      b = createDraft("plugin:member:b:group/x", 1, storage);
    a.save({ revision: "old", config: { x: 1 } });
    const fetcher = async () =>
      new Response(JSON.stringify({ message: "config_changed", path: "x" }), {
        status: 409,
      });
    try {
      await api("/plugins/update", {}, {}, fetcher as typeof fetch);
    } catch (error) {
      expect(pluginError(error)).toContain("你的修改还在");
      expect((error as ApiError).path).toBe("x");
    }
    expect(a.load()?.value).toEqual({ revision: "old", config: { x: 1 } });
    expect(b.load()).toBeUndefined();
  });
  it("异步保存清理只清当前标签写入的草稿，显式放弃仍可清全部", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    };
    const a = createDraft("plugin:shared", 1, storage, "tab-a");
    const b = createDraft("plugin:shared", 1, storage, "tab-b");
    a.save({ label: "submitted-a" });
    b.save({ label: "conflicted-b" });
    a.clearOwned();
    expect(b.load()?.value).toEqual({ label: "conflicted-b" });
    // A freshly created handle in the same document still owns that document's writes.
    createDraft("plugin:shared", 1, storage, "tab-b").clearOwned();
    expect(b.load()).toBeUndefined();
    b.save({ label: "explicit-discard" });
    a.clear();
    expect(b.load()).toBeUndefined();
    const defaultWriter = createDraft("plugin:default", 1, storage);
    defaultWriter.save("same-document");
    createDraft("plugin:default", 1, storage).clearOwned();
    expect(defaultWriter.load()).toBeUndefined();
  });
  it("状态和目录使用同一数据投影", () => {
    const entry = {
      path: "group/a",
      key: "a",
      name: "a",
      label: "A",
      enabled: false,
      group: false,
      status: "disabled" as const,
      needsConfig: true,
      locked: false,
    };
    expect(pluginStatus(entry)).toBe("需要配置");
    expect(flattenPlugins([{ ...entry, group: true, children: [entry] }])).toHaveLength(2);
  });
});

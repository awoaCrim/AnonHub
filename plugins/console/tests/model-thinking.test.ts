import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as vue from "vue";

import type { ModelSettingsModel } from "../src/model-settings-types";
import * as thinking from "../web/src/lib/model-thinking";

describe("model thinking editor", () => {
  it.each(["openai", "anthropic", "deepseek"])("makes a new extended selection explicit for %s without changing other model settings", (protocol) => {
    for (const level of ["xhigh", "max"] as const) {
      const model: ModelSettingsModel = { id: "model", reasoning: true, toolCall: false, thinkingLevelMap: { low: "medium" } };
      thinking.selectModelThinkingLevel(protocol, model, level);
      expect(model).toEqual({ id: "model", reasoning: true, toolCall: false, thinkingLevel: level, thinkingLevelMap: { low: "medium", [level]: level } });
      expect(thinking.modelThinkingHint(protocol, model)).toBe("");
    }
  });

  it.each(["openai", "anthropic", "deepseek"])("preserves explicit custom and unsupported maps on a manual %s selection", (protocol) => {
    for (const mapped of ["high", "max", null]) {
      const model: ModelSettingsModel = { id: "model", thinkingLevelMap: { xhigh: mapped } };
      const original = model.thinkingLevelMap;
      thinking.selectModelThinkingLevel(protocol, model, "xhigh");
      expect(model.thinkingLevelMap).toBe(original);
      expect(model.thinkingLevelMap).toEqual({ xhigh: mapped });
    }
  });

  it("does not opt old unmapped configurations in merely by displaying them", () => {
    const model: ModelSettingsModel = { id: "model", reasoning: true, thinkingLevel: "xhigh" };
    const old = structuredClone(model);
    expect(thinking.modelThinkingOptions("openai", model).map((option) => option.value)).toContain("max");
    expect(thinking.modelThinkingLevels("openai", model)).toContain("xhigh");
    expect(thinking.modelThinkingHint("openai", model)).toContain("尚未设置映射");
    expect(model).toEqual(old);
    thinking.selectModelThinkingLevel("openai", model, undefined);
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it("keeps DeepSeek xhigh distinct from max instead of silently increasing native effort", () => {
    const model: ModelSettingsModel = { id: "deepseek-v4-pro" };
    thinking.selectModelThinkingLevel("deepseek", model, "xhigh");
    expect(model.thinkingLevelMap).toEqual({ xhigh: "xhigh" });
  });

  it("does not offer Google native extended levels on a new model", () => {
    const model: ModelSettingsModel = { id: "gemini" };
    expect(thinking.modelThinkingOptions("google", model).map((option) => option.value)).toEqual([undefined, "off", "minimal", "low", "medium", "high"]);
    expect(thinking.modelThinkingLevels("google", model)).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("retains Google custom extended mappings and unsupported markers without emitting a native extended value", () => {
    const model: ModelSettingsModel = { id: "gemini", reasoning: true, thinkingLevel: "xhigh", thinkingLevelMap: { xhigh: "high", max: null } };
    const old = structuredClone(model);
    const options = thinking.modelThinkingOptions("google", model);
    expect(options.find((option) => option.value === "xhigh")?.disabled).toBe(false);
    expect(options.find((option) => option.value === "max")?.disabled).toBe(true);
    expect(thinking.modelThinkingLevels("google", model)).toContain("max");
    expect(thinking.modelThinkingHint("google", model)).toBe("");
    thinking.selectModelThinkingLevel("google", model, "xhigh");
    expect(model).toEqual(old);
  });

  it("shows a legacy Google extended value while explaining why it cannot be selected as a native value", () => {
    for (const thinkingLevelMap of [undefined, { xhigh: "xhigh" }, { xhigh: null }]) {
      const model: ModelSettingsModel = { id: "gemini", reasoning: true, thinkingLevel: "xhigh", thinkingLevelMap };
      const old = structuredClone(model);
      expect(thinking.modelThinkingOptions("google", model).find((option) => option.value === "xhigh")?.disabled).toBe(true);
      expect(thinking.modelThinkingHint("google", model)).not.toBe("");
      expect(model).toEqual(old);
    }
  });

  it("explains when the model's reasoning switch prevents an extended level from taking effect", () => {
    const model: ModelSettingsModel = { id: "model", reasoning: false, thinkingLevel: "max", thinkingLevelMap: { max: "max" } };
    expect(thinking.modelThinkingHint("openai", model)).toContain("未启用推理");
    expect(thinking.modelThinkingHint("openai", { ...model, thinkingLevel: "high" })).toBe("");
  });

  it("wires a real model page's selection to the explicit mapping without migrating on open", () => {
    const filename = "components/models/ModelList.vue";
    const { descriptor } = parse(readFileSync(new URL(`../web/src/${filename}`, import.meta.url), "utf8"));
    const script = compileScript(descriptor, { id: filename });
    expect(compileTemplate({ source: descriptor.template!.content, filename, id: filename }).errors).toEqual([]);
    // oxlint-disable-next-line typescript/no-explicit-any
    const module = { exports: {} as { default: { setup(...args: unknown[]): Record<string, any> } } };
    const model = vue.ref<ModelSettingsModel>({ id: "model", reasoning: true, thinkingLevel: "xhigh" });
    // The page saves each change; here a change applies to the model directly.
    const models = {
      activeModel: model,
      editable: vue.ref(true),
      tab: vue.ref("chat"),
      models: vue.ref([]),
      state: { saving: false },
      changeModel: (target: ModelSettingsModel, _label: string, change: (value: ModelSettingsModel) => void) => change(target),
    };
    const imports: Record<string, unknown> = { vue: { ...vue, inject: () => models }, "../../lib/model-thinking": thinking };
    runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      module,
      exports: module.exports,
      require: (name: string) => imports[name] ?? { default: {} },
    });
    const scope = vue.effectScope();
    try {
      const component = scope.run(() => module.exports.default.setup({ connection: { type: "openai" }, probedModels: [] }, { expose() {} }))!;
      expect(model.value.thinkingLevelMap).toBeUndefined();
      component.setThinkingLevel("max");
      expect(model.value.thinkingLevel).toBe("max");
      expect(model.value.thinkingLevelMap).toEqual({ max: "max" });
      expect(component.mapLevels.value).toContain("max");
    } finally {
      scope.stop();
    }
  });
});

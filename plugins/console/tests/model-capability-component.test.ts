import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import type { ModelCapabilityProbeResult } from "../src/model-settings-types";
import { ui } from "./fixtures/ui";

interface Bindings {
  run(): Promise<void>;
  result: vue.Ref<ModelCapabilityProbeResult | undefined>;
  busy: vue.Ref<boolean>;
}

it("only charges a capability probe on an enabled explicit action and discards a stale response after selection changes", async () => {
  let finish!: (value: unknown) => void;
  const request = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/models/ModelCapabilityProbe.vue", import.meta.url), "utf8"));
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => Bindings } } };
  runInNewContext(
    ts.transpileModule(compileScript(descriptor, { id: "model-capability" }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    {
      module,
      exports: module.exports,
      require: (name: string) =>
        name === "vue" ? vue : name === "../../state/model-settings-state" ? { capabilityFailureMessages: {}, requestModelCapabilityProbe: request } : ui(name),
    },
  );
  const scope = vue.effectScope(),
    props = vue.reactive({ connectionKey: "connection:0", model: "saved", enabled: false });
  const state = scope.run(() => module.exports.default.setup(props, { expose() {} }))!;
  try {
    await vue.nextTick();
    expect(request).not.toHaveBeenCalled();
    await state.run();
    expect(request).not.toHaveBeenCalled();
    props.enabled = true;
    await vue.nextTick();
    expect(request).not.toHaveBeenCalled();
    const pending = state.run();
    expect(request).toHaveBeenCalledWith({ key: "connection:0", model: "saved", capabilities: ["text", "tool", "image"] });
    props.model = "another";
    await vue.nextTick();
    finish({ ok: true, checks: [{ capability: "text", ok: true, requestIds: ["request-id"] }] });
    await pending;
    expect(state.result.value).toBeUndefined();
    expect(state.busy.value).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    scope.stop();
  }
});

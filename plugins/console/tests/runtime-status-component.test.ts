import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import { ui } from "./fixtures/ui";

function harness() {
  let mount!: () => Promise<void>, dispose!: () => void;
  const api = vi.fn(async () => ({ available: true, runtime: { id: "local", state: "running", name: "ANON 本机" } }));
  const toast = vi.fn(),
    interval = vi.fn();
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/RuntimeStatus.vue", import.meta.url), "utf8"));
  const code = ts.transpileModule(compileScript(descriptor, { id: "runtime" }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  // The component is compiled at run time; its setup's return has no static type here.
  // oxlint-disable-next-line typescript/no-explicit-any
  const module = { exports: {} as any };
  runInNewContext(code, {
    module,
    exports: module.exports,
    setInterval: interval,
    clearInterval: vi.fn(),
    require: (name: string) =>
      ({
        vue: {
          ...vue,
          onMounted: (f: typeof mount) => {
            mount = f;
          },
          onUnmounted: (f: typeof dispose) => {
            dispose = f;
          },
        },
        "../lib/api": { api },
        "../lib/toast": { toast },
      })[name] ?? ui(name),
  });
  const state = module.exports.default.setup({}, { expose() {} });
  return { state, api, toast, interval, mount: () => mount(), dispose: () => dispose() };
}
it("does not create a polling timer or apply a late response after navigation", async () => {
  const h = harness();
  let resolve!: (v: unknown) => void;
  h.api.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const mounted = h.mount();
  h.dispose();
  resolve({ available: true, runtime: { state: "running" } });
  await mounted;
  expect(h.state.runtime.value).toBeUndefined();
  expect(h.interval).not.toHaveBeenCalled();
});
it("shows an initial connection failure and avoids duplicate lifecycle actions", async () => {
  const h = harness();
  h.api.mockRejectedValueOnce(new Error("offline"));
  await h.mount();
  expect(h.state.error.value).toContain("无法读取运行状态");
  await h.state.load();
  expect(h.state.error.value).toBe("");
  h.api.mockClear();
  await Promise.all([h.state.action("stop"), h.state.action("stop")]);
  expect(h.api.mock.calls.filter((call) => call[1])).toHaveLength(1);
});

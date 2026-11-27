import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import { useComputerControl } from "../web/src/lib/computer-control";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function surface() {
  const { descriptor } = parse(readFileSync(new URL("../web/src/components/ComputerInput.vue", import.meta.url), "utf8"));
  expect(compileTemplate({ source: descriptor.template!.content, filename: "ComputerInput.vue", id: "input" }).errors).toEqual([]);
  const code = ts.transpileModule(compileScript(descriptor, { id: "input" }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  // The compiled SFC exposes a runtime-only setup object in this VM fixture.
  // oxlint-disable-next-line typescript/no-explicit-any
  const module = { exports: {} as any };
  runInNewContext(code, { module, exports: module.exports, require: () => ({ ...vue, onBeforeUnmount() {} }), setTimeout, clearTimeout, Date });
  const emit = vi.fn();
  const view = module.exports.default.setup({ scale: 2, width: 1000, height: 800, busy: false }, { expose() {}, emit });
  view.image.value = { naturalWidth: 1000, naturalHeight: 800, getBoundingClientRect: () => ({ left: 10, top: 20, width: 500, height: 400 }) };
  view.input.value = { value: "", focus() {}, setPointerCapture() {}, hasPointerCapture: () => false };
  const pointer = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, preventDefault() {} });
  return { view, emit, pointer };
}
it("maps scaled clicks, sends one double-click, and turns a gesture into one drag", () => {
  vi.useFakeTimers();
  const { view, emit, pointer } = surface();
  view.down(pointer(110, 120));
  view.up(pointer(110, 120));
  view.down(pointer(110, 120));
  view.up(pointer(110, 120));
  vi.runAllTimers();
  expect(emit.mock.calls).toEqual([["action", { type: "click", x: 100, y: 100, button: "left", count: 2 }]]);
  emit.mockClear();
  view.down(pointer(110, 120));
  view.up(pointer(210, 220));
  expect(emit).toHaveBeenCalledWith("action", { type: "drag", x: 100, y: 100, toX: 200, toY: 200 });
});
it("sends committed Chinese once and flushes the target click before text", () => {
  vi.useFakeTimers();
  const { view, emit, pointer } = surface();
  view.down(pointer(110, 120));
  view.up(pointer(110, 120));
  view.input.value.value = "你好";
  view.composed({ target: view.input.value });
  view.typed({ target: view.input.value });
  expect(emit.mock.calls).toEqual([
    ["action", { type: "click", x: 100, y: 100, button: "left" }],
    ["action", { type: "text", text: "你好" }],
  ]);
});
it("serializes quick input and discards queued input after an uncertain failure", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let finish!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (body.op === "input") return new Promise<Response>((resolve) => (finish = resolve));
      return Promise.resolve(Response.json({ ok: true }));
    }),
  );
  const control = useComputerControl(vue.ref("device"), vue.ref(false));
  control.token.value = "lease";
  const first = control.send({ type: "text", text: "a" });
  const second = control.send({ type: "key", key: "Return" });
  await Promise.resolve();
  expect(requests.filter((r) => r.op === "input")).toHaveLength(1);
  finish(Response.json({ message: "computer_input_unconfirmed" }, { status: 409 }));
  await Promise.all([first, second]);
  expect(requests.filter((r) => r.op === "input")).toHaveLength(1);
  expect(control.token.value).toBe("");
  expect(control.error.value).toContain("未确认");
});
it("coalesces pending text without moving it across an Enter key", async () => {
  const bodies: Array<{ op: string; action?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }),
  );
  const control = useComputerControl(vue.ref("device"), vue.ref(false));
  control.token.value = "lease";
  await Promise.all([
    control.send({ type: "text", text: "a" }),
    control.send({ type: "text", text: "b" }),
    control.send({ type: "key", key: "Return" }),
    control.send({ type: "text", text: "c" }),
  ]);
  expect(bodies.map((body) => body.action)).toEqual([
    { type: "text", text: "ab" },
    { type: "key", key: "Return" },
    { type: "text", text: "c" },
  ]);
});

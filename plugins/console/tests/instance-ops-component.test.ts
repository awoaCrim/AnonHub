import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import * as icons from "reicon-vue";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import type { OpsInstance } from "../src/shared/accounts";
import { formatBytes, formatTime } from "../web/src/lib/format";
import { formatUptime } from "../web/src/pages/overview-model";
import { mergeOps, restartInstance } from "../web/src/state/instance-ops";
import { programLabels, programTone, shortCommit } from "../web/src/state/instance-ops";
import * as instanceOps from "../web/src/state/instance-ops";
import { ui } from "./fixtures/ui";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const transpile = (source: string) =>
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;

function compile(file: string, stubs: Record<string, unknown>, props: Record<string, unknown>) {
  const { descriptor } = parse(readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: file });
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => Record<string, unknown> } } };
  runInNewContext(transpile(script.content), {
    module,
    exports: module.exports,
    require: (name: string) => (name === "vue" ? vue : name === "reicon-vue" ? icons : (stubs[name] ?? ui(name))),
  });
  const template = compileTemplate({ source: descriptor.template!.content, filename: file, id: file, compilerOptions: { bindingMetadata: script.bindings } });
  expect(template.errors).toEqual([]);
  const render = { exports: {} as { render: (...args: unknown[]) => vue.VNode } };
  runInNewContext(transpile(template.code), { module: render, exports: render.exports, require: () => vue });
  const reactiveProps = vue.reactive(props);
  const scope = vue.effectScope();
  const bindings = scope.run(() => module.exports.default.setup(reactiveProps, { expose() {} }))!;
  cleanups.push(() => scope.stop());
  return {
    bindings,
    html: () => renderToString(vue.createSSRApp({ render: () => render.exports.render({}, [], reactiveProps, vue.proxyRefs(bindings as object)) })),
  };
}

const sample: OpsInstance = {
  target: "owner",
  container: { name: "demo-owner", running: true },
  memory: { usedBytes: 512 * 1024 ** 2, limitBytes: 1024 ** 3 },
  programs: { koishi: { state: "RUNNING", uptimeSeconds: 7200 }, napcat: { state: "BACKOFF" } },
  release: { commit: "0123456789abcdef", deployedAt: "2026-11-19T01:00:00.000Z" },
};

function opsCard(ops: OpsInstance | undefined, confirm = async () => true) {
  const restart = vi.fn(async () => {});
  const qq = vue.defineComponent({ props: ["base"], setup: (props: { base: string }) => () => vue.h("div", `QQ-CARD ${props.base}`) });
  const view = compile(
    "InstanceOps.vue",
    {
      "../lib/dialog": { confirmDialog: vi.fn(confirm) },
      "../lib/format": { formatBytes, formatTime },
      "../pages/overview-model": { formatUptime },
      "../state/instance-ops": instanceOps,
      "./QQAccount.vue": { default: qq },
    },
    { ops, base: "admin/instances/abc/napcat", restart },
  );
  return { view, restart };
}

it("shows bot and QQ process state, uptime, memory and the short version, with the QQ card for this instance", async () => {
  const html = await opsCard(sample).view.html();
  expect(html).toContain("已运行 2 小时 0 分钟");
  expect(html).toContain("运行中");
  expect(html).toContain("反复启动失败");
  expect(html).toContain("512.0 MB / 1.0 GB");
  expect(html).toContain("0123456");
  expect(html).not.toContain("0123456789");
  expect(html).toContain("QQ-CARD admin/instances/abc/napcat");
  expect(html).toContain("重启 bot");
  expect(html).toContain("重启 QQ");
});

it("says so, and disables restarting, when the manager cannot be read or the container is down", async () => {
  const unknown = await opsCard(undefined).view.html();
  expect(unknown).toContain("暂时读不到运行状态");
  expect(unknown.match(/ disabled(=""|>| )/g)?.length).toBe(2);
  const down = await opsCard({ ...sample, container: { name: "x", running: false } }).view.html();
  expect(down).toContain("容器没在运行");
  expect(down.match(/ disabled(=""|>| )/g)?.length).toBe(2);
});

it("restarts only after the confirmation, which says what will happen", async () => {
  const dialog = vi.fn(async (_options: { message?: string }) => true);
  const restart = vi.fn(async () => {});
  const view = compile(
    "InstanceOps.vue",
    {
      "../lib/dialog": { confirmDialog: dialog },
      "../lib/format": { formatBytes, formatTime },
      "../pages/overview-model": { formatUptime },
      "../state/instance-ops": instanceOps,
      "./QQAccount.vue": { default: vue.defineComponent({ setup: () => () => null }) },
    },
    { ops: sample, base: "napcat", restart, own: true },
  );
  const ask = view.bindings.ask as (program: string) => Promise<void>;
  await ask("koishi");
  expect(dialog.mock.calls[0]![0].message).toContain("正在进行的对话会中断，约半分钟恢复");
  expect(dialog.mock.calls[0]![0].message).toContain("这个控制台也会断开");
  expect(restart).toHaveBeenCalledWith("koishi");
  await ask("napcat");
  expect(dialog.mock.calls[1]![0].message).toContain("QQ 会掉线片刻，通常自动登回");
  expect(restart).toHaveBeenLastCalledWith("napcat");
  dialog.mockResolvedValueOnce(false);
  await ask("napcat");
  expect(restart).toHaveBeenCalledTimes(2);
});

it("hides the QQ card while the page's own bot restarts, so no poll can fail visibly", async () => {
  const view = compile(
    "InstanceOps.vue",
    {
      "../lib/dialog": { confirmDialog: async () => true },
      "../lib/format": { formatBytes, formatTime },
      "../pages/overview-model": { formatUptime },
      "../state/instance-ops": instanceOps,
      "./QQAccount.vue": { default: vue.defineComponent({ setup: () => () => vue.h("i", "QQ-CARD") }) },
    },
    { ops: sample, base: "napcat", restart: async () => {}, quietQq: true },
  );
  expect(await view.html()).not.toContain("QQ-CARD");
});

it("restartInstance: the owner's own bot dropping the connection is the expected result", async () => {
  const ok = vi.fn(async () => ({ accepted: true }));
  expect(await restartInstance("owner", "koishi", ok as never)).toEqual({ kind: "accepted" });
  expect(ok).toHaveBeenCalledWith("admin/instances/restart", { target: "owner", program: "koishi" });
  expect(
    await restartInstance("owner", "koishi", (async () => {
      throw new TypeError("Failed to fetch");
    }) as never),
  ).toEqual({ kind: "accepted" });
  // Anywhere else a failure stays a failure.
  await expect(
    restartInstance("owner", "napcat", (async () => {
      throw new TypeError("Failed to fetch");
    }) as never),
  ).rejects.toThrow();
  await expect(
    restartInstance("owner", "koishi", (async () => {
      throw new Error("请求失败");
    }) as never),
  ).rejects.toThrow("请求失败");
  expect(await restartInstance("a", "napcat", (async () => ({ instance: sample })) as never)).toEqual({ kind: "done", instance: sample });
});

it("merges a restart result into the last snapshot without dropping the rest", () => {
  const friend = { ...sample, target: "f1" };
  expect(mergeOps(null, sample)).toEqual({ accounts: {}, owner: sample });
  const merged = mergeOps({ owner: sample, accounts: { f1: friend, f2: { ...friend, target: "f2" } } }, { ...friend, memory: undefined });
  expect(Object.keys(merged.accounts)).toEqual(["f1", "f2"]);
  expect(merged.accounts.f1.memory).toBeUndefined();
  expect(merged.owner).toBe(sample);
});

it("labels program states and abbreviates the commit", () => {
  expect(programLabels.FATAL).toBe("无法启动");
  expect(programTone(sample.programs.koishi)).toBe("ok");
  expect(programTone(sample.programs.napcat)).toBe("danger");
  expect(programTone({ state: "STARTING" })).toBe("warn");
  expect(programTone(undefined)).toBe("");
  expect(shortCommit(sample)).toBe("0123456");
  expect(shortCommit(undefined)).toBeUndefined();
});

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import * as vue from "vue";

import type { NapCatStatus } from "../src/shared/napcat";
import { formatTime, onlineLabel } from "../web/src/lib/format";
import { ui } from "./fixtures/ui";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const transpile = (source: string) =>
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;

/** Compiles one SFC with stubbed imports, runs its setup and returns its bindings plus an SSR render of the current state. */
function compile<T>(file: string, stubs: Record<string, unknown>, props: Record<string, unknown>) {
  const { descriptor } = parse(readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: file });
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => T } } };
  const hooks: (() => void)[] = [];
  runInNewContext(transpile(script.content), {
    module,
    exports: module.exports,
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    setTimeout: () => 0,
    require: (name: string) =>
      name === "vue"
        ? { ...vue, onMounted: (fn: () => void) => fn(), onBeforeUnmount: (fn: () => void) => hooks.push(fn), onActivated() {}, onDeactivated() {} }
        : (stubs[name] ?? ui(name)),
  });
  const template = compileTemplate({ source: descriptor.template!.content, filename: file, id: file, compilerOptions: { bindingMetadata: script.bindings } });
  expect(template.errors).toEqual([]);
  const render = { exports: {} as { render: (...args: unknown[]) => vue.VNode } };
  runInNewContext(transpile(template.code), { module: render, exports: render.exports, require: () => vue });
  const reactiveProps = vue.reactive(props);
  const scope = vue.effectScope();
  const bindings = scope.run(() => module.exports.default.setup(reactiveProps, { expose() {} }))!;
  cleanups.push(() => {
    hooks.forEach((fn) => fn());
    scope.stop();
  });
  return {
    bindings,
    html: () => renderToString(vue.createSSRApp({ render: () => render.exports.render({}, [], reactiveProps, vue.proxyRefs(bindings as object)) })),
  };
}

function passwordModel() {
  return {
    state: vue.reactive({ phase: "form", deviceImage: "", scanned: false, notice: "", error: "" }),
    submit: vi.fn(async () => {}),
    renewDevice: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    reset: vi.fn(),
    dispose: vi.fn(),
  };
}

it("password form submits a valid QQ number once and clears the password field right away", async () => {
  const model = passwordModel();
  const view = compile<{ uin: vue.Ref<string>; password: vue.Ref<string>; valid: vue.ComputedRef<boolean>; submit(): void }>(
    "QQPasswordLogin.vue",
    {},
    { model, available: true },
  );
  const form = view.bindings;
  form.uin.value = "01234";
  form.password.value = "pw";
  expect(form.valid.value).toBe(false);
  form.submit();
  expect(model.submit).not.toHaveBeenCalled();
  form.uin.value = "12345";
  expect(form.valid.value).toBe(true);
  form.submit();
  expect(model.submit).toHaveBeenCalledWith("12345", "pw");
  expect(form.password.value).toBe("");
  const html = await view.html();
  expect(html).toContain('type="password"');
  expect(html).toContain('autocomplete="new-password"');
});

it("password form shows the device code only as a PNG data URL and offers renew and cancel", async () => {
  const model = passwordModel();
  const view = compile("QQPasswordLogin.vue", {}, { model, available: true });
  Object.assign(model.state, { phase: "device", deviceImage: "data:image/png;base64,AAAA", notice: "请扫码" });
  let html = await view.html();
  expect(html).toContain('src="data:image/png;base64,AAAA"');
  expect(html).toContain("重新获取验证码");
  model.state.deviceImage = "https://ti.qq.com/device";
  html = await view.html();
  expect(html).not.toContain("ti.qq.com");
  model.state.phase = "submitted";
  expect(await view.html()).toContain("重新填写");
});

function qqPage(status: NapCatStatus, options: { qrCode?: string; deadQrId?: string; accounts?: boolean } = {}) {
  const state = vue.reactive({
    status,
    qrCode: options.qrCode ?? "",
    qrId: status.qrId ?? "",
    deadQrId: options.deadQrId ?? "",
    notice: "",
    error: "",
    busy: false,
    loggingOut: false,
    logoutRequested: false,
    checkedAt: 1,
  });
  const restartInstance = vi.fn(async () => ({ kind: "accepted" }));
  const napcat = { state, refresh: vi.fn(async () => {}), logout: vi.fn(async () => {}), setVisible: vi.fn(async () => {}), dispose: vi.fn() };
  const password = passwordModel();
  const view = compile<{ method: vue.Ref<string> }>(
    "QQAccount.vue",
    {
      "reicon-vue": { Logout: {}, Refresh: {} },
      "../context": { useSession: () => ({ state: { features: { accounts: options.accounts ?? false } } }) },
      "../lib/dialog": { confirmDialog: async () => true },
      "../lib/format": { formatTime, onlineLabel },
      "../lib/toast": { toast: vi.fn() },
      "../state/instance-ops": { restartInstance },
      "../state/napcat-state": { createNapCatState: () => napcat },
      "../state/qq-password-login": { createQQPasswordLogin: () => password },
      "./QQPasswordLogin.vue": { default: vue.defineComponent({ setup: () => () => vue.h("div", "PASSWORD-FORM") }) },
    },
    { base: "napcat" },
  );
  return { view, state, password, restartInstance };
}

it("QQ page offers both login methods and keeps the password flow when switching tabs", async () => {
  const page = qqPage({ available: true, loggedIn: false, online: false, qrId: "a", loginProblem: "kicked" });
  let html = await page.view.html();
  expect(html).toContain("扫码登录");
  expect(html).toContain("账号密码登录");
  expect(html).toContain("QQ 已被下线");
  page.view.bindings.method.value = "password";
  html = await page.view.html();
  expect(html).toContain("PASSWORD-FORM");
  expect(page.password.reset).not.toHaveBeenCalled();
  page.state.status = { available: true, loggedIn: true, connecting: true };
  await vue.nextTick();
  expect(page.password.reset).toHaveBeenCalledTimes(1);
  html = await page.view.html();
  expect(html).toContain("正在连接");
  expect(html).not.toContain("PASSWORD-FORM");
});

it("marks a code NapCat kept past its lifetime as dead and offers to restart QQ", async () => {
  const image = "data:image/png;base64,AAAA";
  const fresh = qqPage({ available: true, loggedIn: false, online: false, qrId: "a", qrAge: 30 }, { qrCode: image, accounts: true });
  let html = await fresh.view.html();
  expect(html).not.toContain("二维码已失效");
  expect(html).not.toContain("重启 QQ");

  const stale = qqPage({ available: true, loggedIn: false, online: false, qrId: "a", qrAge: 600 }, { qrCode: image, accounts: true });
  html = await stale.view.html();
  expect(html).toContain("二维码已失效");
  expect(html).toContain("重启 QQ");
  await stale.view.bindings.restartQq();
  expect(stale.restartInstance).toHaveBeenCalledWith("owner", "napcat");

  // A refresh NapCat could not answer marks the code dead too; without the account manager there is nothing to restart.
  const kept = qqPage({ available: true, loggedIn: false, online: false, qrId: "a", qrAge: 10 }, { qrCode: image, deadQrId: "a" });
  html = await kept.view.html();
  expect(html).toContain("二维码已失效");
  expect(html).not.toContain("重启 QQ");
});

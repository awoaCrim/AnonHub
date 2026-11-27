import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import ts from "typescript";
import { test } from "vitest";
import * as vue from "vue";

const surfaces = [{ name: "standalone", state: "../web/src/state/accounts-state.ts", page: "../web/src/components/AccountRuntime.vue" }];
const setupRequired = { id: "fictional", state: "setup-required" };
const running = { id: "fictional", state: "running", qqAccount: "12345678" };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function runtime(surface) {
  const requests = [];
  const request = (path, body) => {
    const pending = deferred();
    requests.push({ path, body, ...pending });
    return pending.promise;
  };
  const module = { exports: {} };
  runInNewContext(transpile(readFileSync(new URL(surface.state, import.meta.url), "utf8")), {
    module,
    exports: module.exports,
    Error,
    require: (name) => (name === "vue" ? vue : { adminRequest: request }),
  });
  return { view: module.exports.createRuntimeState(), requests, exports: module.exports };
}

function page(surface) {
  const api = runtime(surface);
  const hooks = {},
    listeners = {},
    timers = new Map();
  let nextTimer = 0,
    logoutCalls = 0;
  const logoutRequest = deferred();
  const logout = () => {
    logoutCalls++;
    return logoutRequest.promise;
  };
  const document = {
    hidden: false,
    addEventListener: (name, callback) => {
      listeners[name] = callback;
    },
    removeEventListener: (name) => {
      delete listeners[name];
    },
  };
  const lifecycle = Object.fromEntries(
    ["onMounted", "onActivated", "onDeactivated", "onBeforeUnmount"].map((name) => [
      name,
      (callback) => {
        hooks[name] = callback;
      },
    ]),
  );
  const { descriptor } = parse(readFileSync(new URL(surface.page, import.meta.url), "utf8"));
  const script = compileScript(descriptor, { id: `runtime-${surface.name}` });
  const module = { exports: {} };
  runInNewContext(transpile(script.content), {
    module,
    exports: module.exports,
    Error,
    document,
    setTimeout: (callback, delay) => {
      assert.equal(delay, 3000);
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    require: (name) => {
      if (name === "vue") return { ...vue, ...lifecycle };
      if (name.endsWith("accounts-state")) return { ...api.exports, createRuntimeState: () => api.view };
      if (name === "./admin-session") return { adminSession: { role: "member", username: "fictional" }, logout };
      if (name === "../context")
        return {
          useSession: () => ({ state: { role: "member", username: "fictional" }, logout }),
          useLive: () => ({ reset() {} }),
        };
      if (name === "vue-router") return { useRouter: () => ({ replace: async () => {} }) };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const bindings = module.exports.default.setup({}, { expose() {} });
  const templateModule = { exports: {} };
  const template = compileTemplate({
    source: descriptor.template.content,
    filename: surface.page,
    id: `runtime-${surface.name}`,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  assert.equal(template.errors.length, 0);
  runInNewContext(transpile(template.code), { module: templateModule, exports: templateModule.exports, require: () => vue });
  async function html() {
    const app = vue.createSSRApp({ render: () => templateModule.exports.render({}, [], {}, vue.proxyRefs(bindings)) });
    app.component("k-layout", {
      setup:
        (_, { slots }) =>
        () =>
          vue.h("div", slots.default?.()),
    });
    return renderToString(app);
  }
  return {
    ...api,
    bindings,
    hooks,
    document,
    listeners,
    timers,
    html,
    logoutRequest,
    logoutCalls: () => logoutCalls,
    tick() {
      assert.equal(timers.size, 1);
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
    dispose() {
      hooks.onBeforeUnmount();
    },
  };
}

for (const surface of surfaces) {
  test(`${surface.name}: delayed repeated status reads keep the rendered QQ form editable and never start automatically`, async () => {
    const p = page(surface);
    try {
      p.hooks.onMounted();
      p.hooks.onActivated();
      assert.equal(p.requests.length, 1);
      p.requests[0].resolve({ runtime: setupRequired });
      await flush();
      p.view.state.qqAccount = "12345678";
      for (let index = 1; index <= 3; index++) {
        p.tick();
        assert.equal(p.requests.length, index + 1);
        assert.equal(p.view.state.loading, true);
        assert.equal(p.view.state.submitting, false);
        const html = await p.html();
        const input = html.match(/<input\b[^>]*>/)[0];
        assert.match(input, /value="12345678"/);
        assert.match(input, /required/);
        assert.match(input, /pattern="\[1-9\]\[0-9\]\{4,11\}"/);
        assert.doesNotMatch(input, /disabled/);
        assert.match(html, /<button(?![^>]*disabled)[^>]*>开始设置<\/button>/);
        assert.match(html, /<button(?![^>]*disabled)[^>]*>退出登录<\/button>/);
        assert.doesNotMatch(html, /正在提交/);
        await p.view.refresh();
        assert.equal(p.requests.length, index + 1);
        p.requests[index].resolve({ runtime: setupRequired });
        await flush();
      }
      assert.ok(p.requests.every(({ path, body }) => path === "account/runtime" && body === undefined));
      assert.equal(p.view.state.qqAccount, "12345678");
    } finally {
      p.dispose();
    }
  });

  test(`${surface.name}: explicit start works during a pending GET, prevents duplicate POSTs and rejects the stale GET`, async () => {
    const p = page(surface);
    try {
      p.hooks.onMounted();
      p.requests[0].resolve({ runtime: setupRequired });
      await flush();
      p.view.state.qqAccount = " 12345678 ";
      p.tick();
      const pending = p.view.start();
      assert.equal(p.view.state.submitting, true);
      assert.equal(p.requests.length, 3);
      assert.equal(p.requests[2].path, "account/runtime/start");
      assert.equal(JSON.stringify(p.requests[2].body), '{"qqAccount":"12345678"}');
      await Promise.all([p.view.start(), p.view.refresh()]);
      assert.equal(p.requests.length, 3);
      const html = await p.html();
      assert.match(html, /正在提交…/);
      assert.match(html.match(/<input\b[^>]*>/)[0], /disabled/);
      p.requests[2].resolve({ runtime: running });
      await pending;
      assert.equal(p.view.state.submitting, false);
      assert.equal(p.view.state.runtime.state, "running");
      p.requests[1].resolve({ runtime: setupRequired });
      await flush();
      assert.equal(p.view.state.runtime.state, "running");
      assert.equal(p.view.state.loading, false);
      assert.equal(p.view.state.qqAccount, " 12345678 ");
      assert.equal(p.requests.filter(({ body }) => body !== undefined).length, 1);
    } finally {
      p.dispose();
    }
  });

  test(`${surface.name}: stale read failures and later polling preserve submit errors and the typed draft`, async () => {
    const { view, requests } = runtime(surface);
    view.state.runtime = setupRequired;
    view.state.qqAccount = "12345678";
    const read = view.refresh(),
      start = view.start();
    requests[1].reject(new Error("QQ already assigned"));
    await start;
    requests[0].reject(new Error("Obsolete status failure"));
    await read;
    assert.equal(view.state.error, "QQ already assigned");
    assert.equal(view.state.refreshError, "");
    const failedRead = view.refresh();
    requests[2].reject(new Error("Status unavailable"));
    await failedRead;
    assert.equal(view.state.refreshError, "Status unavailable");
    assert.equal(view.state.error, "QQ already assigned");
    const recoveredRead = view.refresh();
    requests[3].resolve({ runtime: setupRequired });
    await recoveredRead;
    assert.equal(view.state.refreshError, "");
    assert.equal(view.state.error, "QQ already assigned");
    assert.equal(view.state.qqAccount, "12345678");
    const retry = view.start();
    assert.equal(view.state.error, "");
    requests[4].resolve({ runtime: running });
    await retry;
    view.dispose();
  });

  test(`${surface.name}: logout during a pending status read has its own label and coalesces repeated clicks`, async () => {
    const p = page(surface);
    try {
      p.hooks.onMounted();
      p.requests[0].resolve({ runtime: setupRequired });
      await flush();
      p.view.state.qqAccount = "12345678";
      p.tick();
      const logout = p.bindings.signOut();
      await p.bindings.signOut();
      assert.equal(p.logoutCalls(), 1);
      assert.equal(p.view.state.submitting, false);
      const html = await p.html();
      assert.match(html, /正在退出…/);
      assert.doesNotMatch(html, /正在提交/);
      p.logoutRequest.reject(new Error("Sign out failed"));
      await logout;
      p.requests[1].resolve({ runtime: setupRequired });
      await flush();
      assert.equal(p.bindings.loggingOut.value, false);
      assert.equal(p.view.state.error, "Sign out failed");
      assert.doesNotMatch((await p.html()).match(/<input\b[^>]*>/)[0], /disabled/);
    } finally {
      p.dispose();
    }
  });

  test(`${surface.name}: visibility and KeepAlive keep one polling loop and unmount discards pending results`, async () => {
    const p = page(surface);
    p.hooks.onMounted();
    p.hooks.onActivated();
    assert.equal(p.requests.length, 1);
    p.hooks.onDeactivated();
    p.requests[0].resolve({ runtime: setupRequired });
    await flush();
    assert.equal(p.timers.size, 0);
    p.document.hidden = true;
    p.listeners.visibilitychange();
    p.document.hidden = false;
    p.listeners.visibilitychange();
    assert.equal(p.requests.length, 1);
    p.hooks.onActivated();
    assert.equal(p.requests.length, 2);
    p.requests[1].resolve({ runtime: setupRequired });
    await flush();
    assert.equal(p.timers.size, 1);
    p.document.hidden = true;
    p.listeners.visibilitychange();
    assert.equal(p.timers.size, 0);
    p.document.hidden = false;
    p.listeners.visibilitychange();
    assert.equal(p.requests.length, 3);
    p.view.state.qqAccount = "12345678";
    const start = p.view.start();
    p.dispose();
    p.requests[2].resolve({ runtime: { ...running, state: "stopped" } });
    p.requests[3].resolve({ runtime: running });
    await start;
    await flush();
    assert.equal(p.view.state.runtime.state, "setup-required");
    assert.equal(p.timers.size, 0);
    assert.equal(p.listeners.visibilitychange, undefined);
    await Promise.all([p.view.refresh(), p.view.start()]);
    assert.equal(p.requests.length, 4);
  });
}

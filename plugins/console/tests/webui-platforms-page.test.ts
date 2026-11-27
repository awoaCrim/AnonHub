import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as vue from "vue";

import * as platforms from "../../../packages/contracts/src/platforms";
import type { PanelAdapter } from "../src/shared/panel";
import type { PluginConfigEntry, PluginsSnapshot } from "../src/shared/plugin-config";
import { ApiError } from "../web/src/lib/api";
import * as pluginConfig from "../web/src/lib/plugin-config";
import * as webPlatform from "../web/src/lib/web-platform";
import * as model from "../web/src/pages/platforms-model";
import { ui } from "./fixtures/ui";

const entry = (path: string, name: string, extra: Partial<PluginConfigEntry> = {}): PluginConfigEntry => ({
  path,
  key: path,
  name,
  label: name,
  enabled: !path.startsWith("~"),
  group: false,
  status: path.startsWith("~") ? "disabled" : "active",
  needsConfig: false,
  locked: false,
  ...extra,
});

describe("自定义平台标签", () => {
  it("只有注册表之外的适配器才单独成为标签，停用标记不改变标签", () => {
    expect(model.isCustomAdapter("adapter-telegram")).toBe(true);
    expect(model.isCustomAdapter("adapter-onebot")).toBe(false);
    expect(model.isCustomAdapter("yesimbot-onebot-utils")).toBe(false);
    expect(model.adapterLabel("adapter-telegram")).toBe("Telegram");
    expect(model.adapterLabel("adapter-wechat-bridge")).toBe("微信");
    expect(model.customTabId("~adapter-telegram:abc")).toBe(model.customTabId("adapter-telegram:abc"));
    const adapters = [{ key: "adapter-telegram:b", platform: "telegram", state: "online" }] as PanelAdapter[];
    const tabs = model.customPlatformTabs(
      [entry("adapter-onebot:q", "adapter-onebot"), entry("~adapter-telegram:a", "adapter-telegram"), entry("adapter-telegram:b", "adapter-telegram")],
      adapters,
    );
    expect(tabs.map((tab) => [tab.label, tab.platform, tab.state])).toEqual([
      ["Telegram 1", "telegram", undefined],
      ["Telegram 2", "telegram", "online"],
    ]);
  });
});

const { descriptor } = parse(readFileSync(new URL("../web/src/pages/Platforms.vue", import.meta.url), "utf8"));
const code = ts.transpileModule(compileScript(descriptor, { id: "platforms-page" }).content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

type Page = {
  tabs: vue.ComputedRef<{ id: string; label: string }[]>;
  current: vue.ComputedRef<{ id: string } | undefined>;
  scopePlatform: vue.ComputedRef<string>;
  custom: vue.ComputedRef<{ entry: { path: string } } | undefined>;
  installable: vue.ComputedRef<{ name: string }[]>;
  selected: vue.Ref<string>;
  connect(name: string): Promise<void>;
  remove(tab: unknown): Promise<void>;
  custom: vue.ComputedRef<unknown>;
};

function page(options: { tree: PluginConfigEntry[]; available: string[]; confirm?: boolean; add?: () => Promise<unknown>; remove?: () => Promise<unknown> }) {
  const plugins = vue.reactive({
    data: {
      revision: "rev-1",
      writable: true,
      tree: options.tree,
      available: options.available.map((name) => ({ name, label: name })),
    } as PluginsSnapshot,
  });
  const panel = vue.reactive({ data: { adapters: [] as PanelAdapter[] } });
  const query = new Map<string, vue.Ref<string>>();
  const toast = vi.fn();
  const addPluginInstance = vi.fn(options.add ?? (async () => ({ revision: "rev-2", path: "~adapter-telegram:new" })));
  const removePluginInstance = vi.fn(options.remove ?? (async () => ({ revision: "rev-2" })));
  const confirmDialog = vi.fn(async () => options.confirm ?? true);
  const imports: Record<string, unknown> = {
    vue,
    "@yesimbot/contracts/platforms": platforms,
    "../../../src/shared/plugin-catalog": { OPTIONAL_MEMBER_PLUGINS: [{ name: "yesimbot-onebot-utils", label: "QQ 专属动作" }] },
    "../context": { useSession: () => ({ state: { role: "owner", features: { napcat: true } } }) },
    "../lib/api": { ApiError },
    "../lib/dialog": { confirmDialog },
    "../lib/plugin-actions": {
      addPluginInstance,
      removePluginInstance,
      isPlatformPackage: (name: string) => /^adapter-/.test(name) || name === "yesimbot-onebot-utils" || name === "yesimbot-xiaoheihe",
    },
    "../lib/plugin-config": pluginConfig,
    "../lib/web-platform": webPlatform,
    "../lib/route-state": {
      useRouteState: (key: string, fallback: string) => {
        if (!query.has(key)) query.set(key, vue.ref(fallback));
        return query.get(key);
      },
    },
    "../lib/toast": { toast },
    "../lib/use-topic": { useTopic: (name: string) => (name === "panel" ? panel : plugins) },
    "./platforms-model": model,
  };
  const module = { exports: {} as { default: { setup(props: unknown, context: unknown): Page } } };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => (name in imports ? imports[name] : { default: {} }),
  });
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup({}, { expose: () => {} }))!;
  return { view, plugins, toast, addPluginInstance, removePluginInstance, confirmDialog, dispose: () => scope.stop() };
}

describe("平台页", () => {
  it("已知平台和自定义适配器各占一个标签，自定义标签带回复范围并跟随启用后的新路径", async () => {
    const h = page({ tree: [entry("adapter-onebot:q", "adapter-onebot"), entry("~adapter-telegram:a", "adapter-telegram")], available: [] });
    expect(h.view.tabs.value.map((tab) => tab.label)).toEqual(["QQ", "Telegram"]);
    h.view.selected.value = "plugin:adapter-telegram:a";
    expect(h.view.current.value?.id).toBe("plugin:adapter-telegram:a");
    expect(h.view.scopePlatform.value).toBe("telegram");
    expect(h.view.custom.value?.entry.path).toBe("~adapter-telegram:a");
    // Turning it on renames the key; the same tab now edits the new path.
    h.plugins.data.tree = [entry("adapter-onebot:q", "adapter-onebot"), entry("adapter-telegram:a", "adapter-telegram")];
    await vue.nextTick();
    expect(h.view.current.value?.id).toBe("plugin:adapter-telegram:a");
    expect(h.view.custom.value?.entry.path).toBe("adapter-telegram:a");
    h.view.selected.value = "web";
    expect(h.view.current.value?.id).toBe("onebot");
    h.view.selected.value = "onebot";
    expect(h.view.scopePlatform.value).toBe("onebot");
    h.dispose();
  });

  it("能接入但还没接入的平台也有标签，在标签里直接开始接入；修订冲突给出可重试的提示", async () => {
    const h = page({
      tree: [],
      available: ["adapter-wechat-bridge", "adapter-telegram"],
      add: async () => ({ revision: "rev-2", path: "~adapter-wechat-bridge:x" }),
    });
    // Registry platforms the account may set up are listed before they exist; other adapters are not offered.
    expect(h.view.tabs.value.map((tab) => tab.label)).toEqual(["QQ", "微信"]);
    expect(h.view.installable.value.map((item) => item.name)).toEqual(["adapter-wechat-bridge", "adapter-telegram"]);
    await h.view.connect("adapter-wechat-bridge");
    expect(h.addPluginInstance).toHaveBeenCalledWith("rev-1", "adapter-wechat-bridge");
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining("已开始接入微信"));
    h.addPluginInstance.mockRejectedValueOnce(new ApiError(409, "config_changed"));
    await h.view.connect("adapter-wechat-bridge");
    expect(h.toast).toHaveBeenLastCalledWith("设置刚刚有变化，请稍后再试一次。", "danger");
    h.addPluginInstance.mockRejectedValueOnce(new ApiError(403, "not_permitted"));
    await h.view.connect("adapter-wechat-bridge");
    expect(h.toast).toHaveBeenLastCalledWith("当前账号没有这项功能的管理权限。", "danger");
    h.dispose();
  });

  it("移除需要确认，受保护的实例不能移除", async () => {
    const h = page({ tree: [entry("adapter-telegram:a", "adapter-telegram")], available: [], confirm: false });
    h.view.selected.value = "plugin:adapter-telegram:a";
    const tab = h.view.custom.value;
    await h.view.remove(tab);
    expect(h.confirmDialog).toHaveBeenCalledOnce();
    expect(h.removePluginInstance).not.toHaveBeenCalled();
    h.dispose();

    const ok = page({ tree: [entry("adapter-telegram:a", "adapter-telegram")], available: [] });
    ok.view.selected.value = "plugin:adapter-telegram:a";
    await ok.view.remove(ok.view.custom.value);
    expect(ok.removePluginInstance).toHaveBeenCalledWith("rev-1", "adapter-telegram:a");
    expect(ok.view.selected.value).toBe("");
    ok.dispose();

    const locked = page({ tree: [entry("adapter-telegram:a", "adapter-telegram", { locked: true })], available: [] });
    locked.view.selected.value = "plugin:adapter-telegram:a";
    await locked.view.remove(locked.view.custom.value);
    expect(locked.confirmDialog).not.toHaveBeenCalled();
    expect(locked.removePluginInstance).not.toHaveBeenCalled();
    locked.dispose();
  });
});

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import * as platformRegistry from "../../../packages/contracts/src/platforms";
import type { PluginConfigEntry } from "../src/shared/plugin-config";
import * as capabilities from "../web/src/lib/capabilities";
import * as pluginConfig from "../web/src/lib/plugin-config";
import * as webPlatform from "../web/src/lib/web-platform";
import { ui } from "./fixtures/ui";

const entry = (path: string, name: string, children?: PluginConfigEntry[]): PluginConfigEntry => ({
  path,
  key: path.split("/").at(-1)!,
  name,
  label: name,
  group: name === "group",
  enabled: true,
  status: "active",
  needsConfig: false,
  locked: false,
  children,
});

it("ignores legacy group filters, preserves nested instance paths, refuses group editing and keeps toggles on existing instances", async () => {
  const nested = entry("group:outer/group:inner/demo:one", "demo");
  const catalog = {
    revision: "r1",
    writable: true,
    tree: [entry("group:outer", "group", [entry("group:outer/group:inner", "group", [nested])]), entry("other:two", "other")],
    available: [
      { name: "group", label: "分组" },
      { name: "demo", label: "demo" },
    ],
  };
  const api = vi.fn(async (url: string) => (url.includes("/schema?") ? { schema: { type: "object", dict: {} }, dynamics: {}, usage: "" } : { revision: "r2" }));
  const setFeatureEnabled = vi.fn(async () => ({ revision: "r2" }));
  const imports: Record<string, unknown> = {
    "../context": { useSession: () => ({ state: { role: "owner", username: "" } }) },
    "../lib/api": { api },
    "../lib/features": { setFeatureEnabled },
    "../lib/toast": { toast: () => {} },
    "../lib/plugin-config": pluginConfig,
    "../lib/capabilities": capabilities,
    "@yesimbot/contracts/platforms": platformRegistry,
    "../lib/web-platform": webPlatform,
    "../lib/use-topic": { useTopic: () => vue.reactive({ data: catalog }) },
  };
  function setup<T>(file: string, props: Record<string, unknown>) {
    const { descriptor } = parse(readFileSync(new URL(`../web/src/${file}`, import.meta.url), "utf8"));
    const script = compileScript(descriptor, { id: "flat-plugins" });
    const module = { exports: {} as { default: { setup(props: unknown, context: unknown): T } } };
    runInNewContext(ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      module,
      exports: module.exports,
      require: (name: string) =>
        name === "vue" ? { ...vue, onBeforeUnmount: () => {} } : (imports[name] ?? (name.endsWith(".vue") ? { default: {} } : (ui(name) ?? {}))),
    });
    return module.exports.default.setup(props, { expose: () => {}, emit: () => {} });
  }

  type Settings = {
    entry: vue.ComputedRef<PluginConfigEntry | undefined>;
    load(): Promise<void>;
    toggle(enabled: boolean): Promise<void>;
  };
  const scope = vue.effectScope();
  try {
    // The settings read and toggle the nested instance by its full path, and a group has none.
    const props = vue.reactive({ path: nested.path, head: true });
    const settings = scope.run(() => setup<Settings>("components/PluginSettings.vue", props))!;
    await vue.nextTick();
    expect(settings.entry.value?.path).toBe(nested.path);
    expect(api).toHaveBeenCalledWith("/yesimbot/api/v1/plugins/schema?name=demo");
    await settings.toggle(false);
    expect(setFeatureEnabled).toHaveBeenCalledWith("r1", expect.objectContaining({ path: nested.path }), false);
    props.path = "group:outer";
    await vue.nextTick();
    api.mockClear();
    await settings.load();
    expect(settings.entry.value).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  } finally {
    scope.stop();
  }
});

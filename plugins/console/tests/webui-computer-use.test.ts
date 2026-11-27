import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import * as platforms from "@yesimbot/contracts/platforms";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import * as pluginConfig from "../web/src/lib/plugin-config";
import { createConfigFieldsEditor } from "../web/src/state/config-fields";
import { ui } from "./fixtures/ui";

/** The parts of the ComputerUse view this test drives. */
interface ComputerUseView {
  available: { value: boolean };
  devices: { value: unknown[] };
  defaults: { state: { loading: boolean } };
  defaultId: { value: string };
  defaultOptions: { value: unknown[] };
  chooseDefault(id: string): Promise<void>;
}

async function mount(config: Record<string, unknown>) {
  const { descriptor } = parse(readFileSync(new URL("../web/src/pages/Computer.vue", import.meta.url), "utf8"));
  expect(compileTemplate({ source: descriptor.template!.content, filename: "Computer.vue", id: "computer" }).errors).toEqual([]);
  const code = ts.transpileModule(compileScript(descriptor, { id: "computer" }).content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const writes: { config: Record<string, unknown> }[] = [];
  let remote = { revision: "r1", config };
  const request = vi.fn(async (_path: string, body?: { config: Record<string, unknown> }) => {
    if (!body) return remote;
    writes.push(body);
    remote = { revision: "r2", config: body.config };
    return { revision: remote.revision };
  });
  const unmount: (() => void)[] = [];
  const topic = vue.reactive({
    data: { revision: "r1", writable: true, tree: [{ name: "yesimbot-workspace", path: "yesimbot-workspace:a", enabled: true, locked: false }] },
  });
  const imports: Record<string, unknown> = {
    vue: { ...vue, onMounted() {}, onBeforeUnmount: (fn: () => void) => unmount.push(fn) },
    "@yesimbot/contracts/platforms": platforms,
    "../context": { useSession: () => ({ state: { role: "owner", username: "owner", features: { accounts: false } } }) },
    "../lib/api": { api: request },
    "../lib/client-downloads": { loadClientDownloads: vi.fn(), releaseLabel: vi.fn() },
    "../lib/computer-screen": { hasDesktop: () => false },
    "../lib/devices": {
      isWorkspaceDevice: (device: { capabilities: string[] }) => device.capabilities.some((capability) => capability.startsWith("computer.")),
      loadDevices: vi.fn(),
      CAPABILITY_NAMES: {},
    },
    "../lib/features": { setFeatureEnabled: vi.fn() },
    "../lib/format": { onlineLabel: (online: boolean) => (online ? "在线" : "离线"), formatBytes: String },
    "../lib/plugin-actions": { addPluginInstance: vi.fn() },
    "../lib/plugin-config": pluginConfig,
    "../lib/route-state": { useRouteState: () => vue.ref("mine") },
    "../lib/toast": { toast: vi.fn() },
    "../lib/use-topic": { useTopic: () => topic },
    "../state/config-fields": {
      createConfigFieldsEditor: (fields: string[], options: object) => createConfigFieldsEditor(fields, { ...options, request: request as never }),
    },
  };
  const module = { exports: {} as { default: { setup(...args: unknown[]): ComputerUseView } } };
  runInNewContext(code, { module, exports: module.exports, clearTimeout, require: (name: string) => imports[name] ?? ui(name) ?? { default: {} } });
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} }))!;
  view.available.value = true;
  view.devices.value = [
    { deviceId: "pc", name: "家里的电脑", online: false, capabilities: ["computer.shell"] },
    { deviceId: "pc2", name: "工作电脑", online: true, capabilities: ["computer.shell"] },
    { deviceId: "bridge", name: "微信桥", online: true, capabilities: ["wechat.receive"] },
  ];
  await vi.waitFor(() => expect(view.defaults.state.loading).toBe(false));
  return {
    view,
    writes,
    topic,
    dispose: () => {
      unmount.forEach((fn) => fn());
      scope.stop();
    },
  };
}

it("changes the sole default without dropping desktop credentials or unknown fields", async () => {
  const config = {
    storage: { kind: "conversation" },
    untouched: 1,
    computer: {
      deviceId: "pc",
      desktop: { apiKey: { $secret: true }, model: "vision" },
      unknown: "keep",
    },
  };
  const h = await mount(config);
  await h.view.chooseDefault("pc2");
  expect(h.writes.at(-1)!.config).toEqual({ ...config, computer: { ...config.computer, deviceId: "pc2" } });
  h.dispose();
});

it("keeps offline and missing selections explicit, and refuses a bridge-only target", async () => {
  const h = await mount({ computer: { deviceId: "missing" } });
  expect(h.view.defaultId.value).toBe("missing");
  expect(h.view.defaultOptions.value).toContainEqual({ value: "missing", label: "原选中的电脑（当前不可用）", disabled: true });
  expect(h.writes).toEqual([]);
  await h.view.chooseDefault("bridge");
  expect(h.writes).toEqual([]);
  await h.view.chooseDefault("pc");
  expect(h.writes.at(-1)!.config).toEqual({ computer: { deviceId: "pc" } });
  h.dispose();
});

it("refuses a change while the settings are read-only", async () => {
  const h = await mount({ computer: { deviceId: "pc2" } });
  h.topic.data.writable = false;
  await h.view.chooseDefault("pc");
  expect(h.writes).toHaveLength(0);
  h.dispose();
});

it("can clear a stale default to sandbox without dropping credentials", async () => {
  const computer = { deviceId: "revoked", desktop: { apiKey: { $secret: true }, model: "vision" } };
  const h = await mount({ computer, untouched: "keep" });
  await h.view.chooseDefault("");
  expect(h.writes.at(-1)!.config).toEqual({ computer: { ...computer, deviceId: "" }, untouched: "keep" });
  h.dispose();
});

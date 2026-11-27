import { describe, expect, it } from "vitest";

import { checkAdminId, platformAdminIds, readAdmins, withAdmin, withoutAdmin } from "../web/src/lib/platform-admins";

const list = [
  { platform: "onebot", userId: "10001" },
  { platform: "wechat-bridge", userId: "wxid_a" },
];

describe("platform admins", () => {
  it("lists only the platform's IDs", () => {
    expect(platformAdminIds(list, "onebot")).toEqual(["10001"]);
    expect(platformAdminIds(["junk", null, { platform: "onebot" }, ...list], "wechat-bridge")).toEqual(["wxid_a"]);
    expect(readAdmins(undefined)).toEqual([]);
  });
  it("validates trimmed, non-empty, unique IDs; QQ is digits", () => {
    expect(checkAdminId("onebot", "  20002 ", ["10001"])).toEqual({ id: "20002" });
    expect(checkAdminId("onebot", "   ", [])).toHaveProperty("error");
    expect(checkAdminId("onebot", "abc123", [])).toHaveProperty("error");
    expect(checkAdminId("onebot", "10001", ["10001"])).toHaveProperty("error");
    expect(checkAdminId("wechat-bridge", "wxid_b", ["wxid_a"])).toEqual({ id: "wxid_b" });
    expect(checkAdminId("wechat-bridge", "a b", [])).toHaveProperty("error");
  });
  it("adds and removes without touching other platforms or duplicating", () => {
    expect(withAdmin(list, "onebot", "20002")).toEqual([...list, { platform: "onebot", userId: "20002" }]);
    expect(withAdmin(list, "onebot", "10001")).toBe(list);
    expect(withoutAdmin(list, "onebot", "10001")).toEqual([{ platform: "wechat-bridge", userId: "wxid_a" }]);
    expect(withoutAdmin(list, "wechat-bridge", "10001")).toEqual(list);
  });
});

// The component loads at once from an immediate watch; a helper it calls must exist by then (a TDZ error left the
// card stuck on its skeleton in the built page).
describe("PlatformAdmins component", () => {
  it("reads the Core config as soon as it is set up", async () => {
    const { readFileSync } = await import("node:fs");
    const { runInNewContext } = await import("node:vm");
    const { compileScript, parse } = await import("@vue/compiler-sfc");
    const ts = (await import("typescript")).default;
    const vue = await import("vue");
    const { descriptor } = parse(readFileSync(new URL("../web/src/components/PlatformAdmins.vue", import.meta.url), "utf8"));
    const code = ts.transpileModule(compileScript(descriptor, { id: "platform-admins" }).content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const requested: string[] = [];
    const tree = [{ path: "yesimbot", name: "yesimbot", group: false }];
    const api = async (path: string) => {
      requested.push(path);
      if (path.startsWith("/yesimbot/api/v1/plugins/config")) return { revision: "r1", config: { admins: list } };
      if (path.startsWith("/yesimbot/api/v1/bot/contacts")) return { bots: [] };
      throw new Error("unexpected " + path);
    };
    const imports: Record<string, unknown> = {
      vue,
      "reicon-vue": { User: {}, X: {} },
      "@yesimbot/contracts/platforms": { platformDefinition: () => ({ ids: { direct: "QQ 号" } }) },
      "../context": { useLive: () => ({ use: () => ({ state: vue.reactive({ data: { tree, writable: true } }) }) }) },
      "../lib/api": { api, ApiError: class extends Error {} },
      "../lib/cache": { onCacheRefresh: () => () => {} },
      "../lib/platform-admins": await import("../web/src/lib/platform-admins"),
      "../lib/plugin-config": { flattenPlugins: (items: unknown[]) => items, pluginError: () => "error", pluginIdentity: (path: string) => path },
      "../lib/toast": { toast: () => 0, toastErrors: () => {} },
      "../shell/TopicFeedback.vue": { default: {} },
      "./group/GroupRow.vue": { default: {} },
      "./group/SettingsGroup.vue": { default: {} },
      "./SuggestInput.vue": { default: {} },
      "./SettingsSubpage.vue": { default: {} },
      "./ui/alert": { Alert: {} },
      "./ui/badge": { Badge: {}, badgeTone: () => "" },
      "./ui/button": { Button: {} },
      "./ui/dialog": {},
      "./ui/skeleton": { Skeleton: {} },
    };
    const module = { exports: {} as { default: { setup: (props: unknown, context: unknown) => Record<string, unknown> } } };
    runInNewContext(code, { module, exports: module.exports, require: (name: string) => imports[name] });
    const scope = vue.effectScope();
    const view = scope.run(() => module.exports.default.setup({ platform: "onebot" }, { expose() {} }))!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested.some((path) => path.startsWith("/yesimbot/api/v1/plugins/config"))).toBe(true);
    expect((view.ids as { value: string[] }).value).toEqual(["10001"]);
    scope.stop();
  });
});

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as vue from "vue";

import * as platforms from "../../../packages/contracts/src/platforms";
import type { PluginConfigSnapshot, PluginsSnapshot } from "../src/shared/plugin-config";
import { ApiError } from "../web/src/lib/api";
import * as pluginConfig from "../web/src/lib/plugin-config";
import * as replyRules from "../web/src/lib/reply-rules";

type Rule = replyRules.ReplyRule;
type Update = { revision: string; path: string; config: Record<string, unknown> };
type Bindings = {
  rules: vue.ComputedRef<Rule[]>;
  busy: vue.Ref<boolean>;
  draft: vue.Ref<string>;
  draftType: vue.Ref<replyRules.RuleType>;
  problem: vue.Ref<string>;
  adding: vue.Ref<boolean>;
  add(): Promise<void>;
  remove(rule: Rule): void;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const { descriptor } = parse(readFileSync(new URL("../web/src/components/ReplyScope.vue", import.meta.url), "utf8"));
const code = ts.transpileModule(compileScript(descriptor, { id: "reply-scope" }).content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function page(initial: Rule[]) {
  const remote = {
    latest: { revision: "r0", config: { allowedChannels: clone(initial), other: "kept", secret: { $secret: true } } } as PluginConfigSnapshot,
    writes: [] as Update[],
    /** Someone else saves just before this page's next write. */
    race: undefined as ((config: Record<string, unknown>) => void) | undefined,
  };
  const request = vi.fn(async (_path: string, body?: Update) => {
    if (!body) return clone(remote.latest);
    remote.writes.push(clone(body));
    if (remote.race) {
      const race = remote.race;
      remote.race = undefined;
      race(remote.latest.config);
      remote.latest = { revision: "raced", config: remote.latest.config };
    }
    if (body.revision !== remote.latest.revision) throw new ApiError(409, "config_changed");
    remote.latest = { revision: `r${remote.writes.length}`, config: clone(body.config) };
    return { revision: remote.latest.revision };
  });
  const toast = vi.fn();
  const catalog = vue.reactive({
    data: {
      writable: true,
      revision: "catalog",
      available: [],
      tree: [
        {
          path: "yesimbot:main",
          key: "main",
          name: "yesimbot",
          label: "核心",
          enabled: true,
          group: false,
          locked: false,
          needsConfig: false,
          status: "active",
        },
      ],
    } as PluginsSnapshot,
  });
  const unmounts: (() => void)[] = [];
  const scope = vue.effectScope();
  const module = { exports: {} as { default: { setup(props: unknown, context: unknown): Bindings } } };
  const imports: Record<string, unknown> = {
    vue: { ...vue, onUnmounted: (callback: () => void) => unmounts.push(callback) },
    "reicon-vue": {},
    "@yesimbot/contracts/platforms": platforms,
    "../context": { useLive: () => ({ use: () => ({ state: catalog, release() {} }) }) },
    "../lib/api": { api: request, ApiError },
    "../lib/cache": { onCacheRefresh: () => () => {} },
    "../lib/plugin-config": pluginConfig,
    "../lib/reply-rules": replyRules,
    "../lib/toast": { toast, toastErrors() {} },
  };
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => imports[name] ?? { default: {} } });
  const view = scope.run(() => module.exports.default.setup({ platform: "onebot" }, { expose() {} }))!;
  return {
    view,
    remote,
    request,
    toast,
    ready: () => vi.waitFor(() => expect(view.busy.value).toBe(false)),
    dispose() {
      unmounts.forEach((callback) => callback());
      scope.stop();
    },
  };
}

const group = (channelId: string): Rule => ({ platform: "onebot", channelId, isDirect: false });

it("lists this platform's rules and those for every platform, never another platform's", async () => {
  const h = page([group("1"), { platform: "wechat-bridge", channelId: "w@chatroom" }, { platform: "*", channelId: "*" }]);
  try {
    await h.ready();
    expect(h.view.rules.value.map((rule) => rule.channelId)).toEqual(["1", "*"]);
  } finally {
    h.dispose();
  }
});

it("adds a rule to the latest saved list at once, keeping other settings, and offers 撤销", async () => {
  const h = page([group("1"), { platform: "wechat-bridge", channelId: "w@chatroom" }]);
  try {
    await h.ready();
    // Another page adds a rule after this one was read: it stays.
    h.remote.race = (config) => (config.allowedChannels as Rule[]).push(group("other"));
    h.view.draft.value = " 2 ";
    h.view.draftType.value = "direct";
    h.view.adding.value = true;
    await h.view.add();
    expect(h.view.adding.value).toBe(false);
    expect(h.remote.latest.config).toEqual({
      allowedChannels: [
        group("1"),
        { platform: "wechat-bridge", channelId: "w@chatroom" },
        group("other"),
        { platform: "onebot", channelId: "2", isDirect: true },
      ],
      other: "kept",
      secret: { $secret: true },
    });
    const [text, , , action] = h.toast.mock.calls.at(-1)!;
    expect([text, action.label]).toEqual(["已保存：添加 私聊 2", "撤销"]);
    action.run();
    await vi.waitFor(() => expect(h.toast.mock.calls.at(-1)![0]).toBe("已撤销：添加 私聊 2"));
    expect(h.remote.latest.config.allowedChannels).toEqual([group("1"), { platform: "wechat-bridge", channelId: "w@chatroom" }, group("other")]);
  } finally {
    h.dispose();
  }
});

it("refuses an empty, spaced or duplicate rule and keeps the input", async () => {
  const h = page([group("1")]);
  try {
    await h.ready();
    for (const [input, type, problem] of [
      ["1", "group", "这条规则已经在列表里了。"],
      ["1 2", "", "ID 里不能有空格。"],
      ["  ", "", "请填写群或联系人。"],
    ] as const) {
      h.view.draft.value = input;
      h.view.draftType.value = type;
      await h.view.add();
      expect(h.view.problem.value).toBe(problem);
      expect(h.view.draft.value).toBe(input);
    }
    expect(h.remote.writes).toEqual([]);
  } finally {
    h.dispose();
  }
});

it("removes a rule at once and 撤销 puts it back in its place", async () => {
  const h = page([group("1"), group("2"), group("3")]);
  try {
    await h.ready();
    h.view.remove(h.view.rules.value[1]!);
    await vi.waitFor(() => expect(h.remote.latest.config.allowedChannels).toEqual([group("1"), group("3")]));
    await h.ready();
    const [text, , , action] = h.toast.mock.calls.at(-1)!;
    expect(text).toBe("已保存：移除 群 2");
    action.run();
    await vi.waitFor(() => expect(h.remote.latest.config.allowedChannels).toEqual([group("1"), group("2"), group("3")]));
  } finally {
    h.dispose();
  }
});

it("stops after three changed revisions and reports it", async () => {
  const h = page([group("1")]);
  try {
    await h.ready();
    h.request.mockImplementation(async (_path: string, body?: Update) => {
      if (!body) return clone(h.remote.latest);
      throw new ApiError(409, "config_changed");
    });
    h.view.draft.value = "2";
    await h.view.add();
    expect(h.request.mock.calls.filter((call) => call[1])).toHaveLength(3);
    expect(h.view.rules.value).toEqual([group("1")]);
    expect(h.toast).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
